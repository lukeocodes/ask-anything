import {
  SourceError,
  UpstreamFetchError,
  getItem,
  ingest,
  isSourceOwned,
  listKnowledgeGaps,
  listVisibilityReviews,
  proposeUpdate,
  recordUsage,
  refreshItem,
  setVisibility,
} from "@ask/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrivateTier, requireScope, visibleTo } from "../auth.js";

const IngestBody = z.object({
  body: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  // git / url are reserved for registered sources (ADR-0024).
  sourceType: z.enum(["api", "manual"]).default("api"),
  sourceRef: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  baseConfidence: z.number().min(0).max(1).optional(),
  decayRate: z.number().min(0).optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

// The candidate shape from ADR-0010. A proposal with nothing to change is
// refused; `diff` and `evidence` are the proposer's notes and may be empty.
const ProposalBody = z
  .object({
    proposedTitle: z.string().min(1).optional(),
    proposedSummary: z.string().min(1).optional(),
    proposedBody: z.string().min(1).optional(),
    diff: z.record(z.unknown()).default({}),
    evidence: z.array(z.object({ url: z.string().optional(), note: z.string().optional() })).default([]),
  })
  .refine(
    (b) => b.proposedTitle !== undefined || b.proposedSummary !== undefined || b.proposedBody !== undefined,
    { message: "one of proposedTitle, proposedSummary, proposedBody is required" },
  );

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // Insert knowledge into the database (the primary write path).
  app.post(
    "/v1/knowledge",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const parsed = IngestBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      // A public-tier key may only create public knowledge. A private key may
      // create either (falling back to the per-source default when unset).
      const visibility =
        req.apiKey!.visibility === "public" ? "public" : parsed.data.visibility;
      // Auto-defaulted to private (the caller didn't choose)? Core ingest()
      // flags it for visibility review and emits knowledge.review_requested;
      // surfaces subscribe and render their own review UI. The review is also
      // queryable at GET .../reviews.
      const item = await ingest({ ...parsed.data, visibility });
      return reply
        .code(201)
        .send({ id: item.id, title: item.title, status: item.status, visibility: item.visibility });
    },
  );

  // Knowledge awaiting a public/private decision — surface-agnostic, so any UI
  // (CLI, management MCP, web, …) can render the review queue. Every entry is
  // private, so the queue itself needs the private tier.
  app.get(
    "/v1/knowledge/reviews",
    { preHandler: [requireScope("read"), requirePrivateTier] },
    async () => {
      const items = await listVisibilityReviews();
      return {
        reviews: items.map((i) => ({
          id: i.id,
          title: i.title,
          sourceType: i.sourceType,
          sourceRef: i.sourceRef,
          visibility: i.visibility,
          createdAt: i.createdAt,
        })),
      };
    },
  );

  // Knowledge gaps — the questions the engine repeatedly can't answer. An operator
  // to-do list, surface-agnostic.
  app.get(
    "/v1/knowledge/gaps",
    { preHandler: requireScope("read") },
    async () => ({ gaps: await listKnowledgeGaps() }),
  );

  // Resolve an item's visibility (clears any pending review). Called by whatever
  // surface the decision came from.
  app.post(
    "/v1/knowledge/:id/visibility",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = z.object({ visibility: z.enum(["public", "private"]) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      const current = await getItem(id);
      if (!current || !visibleTo(req, current)) return reply.code(404).send({ error: "not_found" });
      const item = await setVisibility(id, parsed.data.visibility);
      if (!item) return reply.code(404).send({ error: "not_found" });
      return reply.send({ id: item.id, visibility: item.visibility });
    },
  );

  // Forced, on-demand refresh of ONE source-owned item (ADR-0024): re-read
  // through its source's adapter and refreshed in place (refreshed | unchanged
  // | removed). Anything else has no upstream to read from → 409.
  app.post(
    "/v1/knowledge/:id/refresh",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const item = await getItem(id);
      if (!item || !visibleTo(req, item)) return reply.code(404).send({ error: "not_found" });

      const audit = (action: string) =>
        recordUsage({
          kind: "watch",
          actor: req.apiKey?.label,
          metadata: { forced: true, itemId: id, sourceType: item.sourceType, action },
        });

      if (!isSourceOwned(item)) {
        await audit("not_source_owned");
        return reply.code(409).send({ error: "not_source_owned", id });
      }
      try {
        const action = await refreshItem(item);
        await audit(action);
        return reply.send({ id, action });
      } catch (err) {
        if (err instanceof UpstreamFetchError) {
          await audit("failed");
          return reply.code(502).send({ error: "upstream_unavailable", status: err.status, url: err.url });
        }
        if (err instanceof SourceError && err.code === "not_found") {
          await audit("failed");
          return reply.code(409).send({ error: "source_missing", id, message: err.message });
        }
        throw err;
      }
    },
  );

  // Propose a change to a record (ADR-0010). Any write-scope key may; the
  // record is untouched until an operator approves (POST /v1/proposals/:id/
  // approve). One pending proposal per record: while one is pending, the
  // existing one comes back with 200 instead of a new one with 201.
  app.post(
    "/v1/knowledge/:id/proposals",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ProposalBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      const item = await getItem(id);
      if (!item || !visibleTo(req, item)) return reply.code(404).send({ error: "not_found" });
      const { proposal, created } = await proposeUpdate(
        id,
        item.sourceType,
        parsed.data,
        req.apiKey?.label ?? "api",
      );
      return reply.code(created ? 201 : 200).send({ proposal, created });
    },
  );

  app.get(
    "/v1/knowledge/:id",
    { preHandler: requireScope("read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const item = await getItem(id);
      if (!item || !visibleTo(req, item)) return reply.code(404).send({ error: "not_found" });
      return reply.send(item);
    },
  );
}
