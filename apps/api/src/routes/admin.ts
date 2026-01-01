import {
  approveProposal,
  invalidateAllAnswerCache,
  knowledgeStats,
  listPendingProposals,
  rejectProposal,
  runDecay,
  topQuestions,
  usageStats,
} from "@ask/core";
import type { FastifyInstance } from "fastify";
import { runGapBackfill } from "../jobs/backfill.js";
import { verifyReviewItems } from "../jobs/monitor.js";
import { requireScope } from "../auth.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/proposals",
    { preHandler: requireScope("write") },
    async () => ({ proposals: await listPendingProposals() }),
  );

  app.post(
    "/v1/proposals/:id/approve",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const outcome = await approveProposal(id, req.apiKey?.label ?? "api");
      if (outcome === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true, outcome });
    },
  );

  app.post(
    "/v1/proposals/:id/reject",
    { preHandler: requireScope("write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const outcome = await rejectProposal(id, req.apiKey?.label ?? "api");
      if (outcome === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true, outcome });
    },
  );

  app.get(
    "/v1/questions/top",
    { preHandler: requireScope("read") },
    async () => ({ questions: await topQuestions() }),
  );

  // Rolling 24h operational stats: latency p95, cache hit rate, cost, tokens.
  app.get(
    "/v1/admin/stats",
    { preHandler: requireScope("admin") },
    async () => usageStats(),
  );

  // Knowledge-base health: item counts, stale counts, oldest/avg age per source.
  app.get(
    "/v1/admin/knowledge-stats",
    { preHandler: requireScope("admin") },
    async () => knowledgeStats(),
  );

  // Manual triggers for the background jobs (also run on cron — see jobs/).
  // run-verify: re-check items owned by review-trust adapters; a no-op with
  // only the shipped upstream-trust adapters.
  app.post(
    "/v1/admin/run-verify",
    { preHandler: requireScope("admin") },
    async () => verifyReviewItems(),
  );

  app.post(
    "/v1/admin/run-decay",
    { preHandler: requireScope("admin") },
    async () => runDecay(),
  );

  // Retroactively re-ask previously-unanswered questions now the KB has grown.
  app.post(
    "/v1/admin/run-backfill",
    { preHandler: requireScope("admin") },
    async () => runGapBackfill(),
  );

  // Flush the semantic answer cache — after a retrieval/threshold/model change,
  // so answers cached before the change aren't served until they expire.
  app.post(
    "/v1/admin/invalidate-cache",
    { preHandler: requireScope("admin") },
    async () => ({ invalidated: await invalidateAllAnswerCache() }),
  );
}
