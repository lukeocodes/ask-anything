import {
  SourceBusyError,
  SourceError,
  createSource,
  deleteSource,
  getSource,
  indexAllSources,
  indexSource,
  listAdapters,
  listSources,
  updateSource,
} from "@ask/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireScope } from "../auth.js";

const visibility = z.enum(["public", "private"]);
const globs = z.array(z.string().min(1)).max(200);
// The NAME of an env var on this host; the value is read at index time and
// never stored, so source rows (and every /v1/sources response) carry the
// name only.
const envVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name").max(200);

const CreateBody = z.object({
  locator: z.string().min(1).max(2048),
  name: z.string().min(1).max(200).optional(),
  // Validated against the registered adapters at request time.
  kind: z.string().min(1).max(50).optional(),
  visibility: visibility.optional(),
  branch: z.string().min(1).max(200).optional(),
  include: globs.optional(),
  exclude: globs.optional(),
  crawl: z.enum(["page", "sitemap"]).optional(),
  schedule: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()).optional(),
  credentialEnv: envVarName.optional(),
});

const PatchBody = z
  .object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    schedule: z.string().max(100).nullable(),
    visibility,
    include: globs,
    exclude: globs,
    branch: z.string().max(200).nullable(),
    crawl: z.enum(["page", "sitemap"]),
    config: z.record(z.unknown()),
    credentialEnv: envVarName.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });

const IndexBody = z.object({ force: z.boolean().optional() }).optional();

/** Map a thrown SourceError to its HTTP status; rethrow anything else. */
function sourceErrorReply(err: unknown, reply: FastifyReply) {
  if (err instanceof SourceError) {
    const status = err.code === "conflict" ? 409 : err.code === "not_found" ? 404 : 400;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Registered sources (ADR-0024): CRUD plus on-demand indexing through the
 * adapter registry (ADR-0020). Indexing runs synchronously and returns the
 * counters — a clone of a large repo can take a while, so clients should set
 * a generous timeout.
 */
export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/sources", { preHandler: requireScope("write") }, async () => ({ sources: await listSources() }));

  // The adapters this deployment can index with: kind, provider hints.
  app.get("/v1/sources/adapters", { preHandler: requireScope("read") }, async () => ({
    adapters: listAdapters().map((a) => ({
      kind: a.kind,
      providers: a.providers ?? [],
    })),
  }));

  app.post("/v1/sources", { preHandler: requireScope("write") }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const kinds = listAdapters().map((a) => a.kind);
    if (parsed.data.kind !== undefined && !kinds.includes(parsed.data.kind)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `unknown source kind "${parsed.data.kind}"; registered adapters: ${kinds.join(", ")}`,
      });
    }
    // A public-tier key may only register public sources.
    const vis = req.apiKey!.visibility === "public" ? "public" : parsed.data.visibility;
    try {
      const source = await createSource({ ...parsed.data, visibility: vis });
      return reply.code(201).send(source);
    } catch (err) {
      return sourceErrorReply(err, reply);
    }
  });

  app.post("/v1/sources/index-all", { preHandler: requireScope("admin") }, async (req, reply) => {
    const parsed = IndexBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return reply.send(await indexAllSources({ force: parsed.data?.force }));
  });

  app.get("/v1/sources/:id", { preHandler: requireScope("write") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const source = await getSource(id);
    if (!source) return reply.code(404).send({ error: "not_found" });
    return reply.send(source);
  });

  app.patch("/v1/sources/:id", { preHandler: requireScope("write") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    if (req.apiKey!.visibility === "public" && parsed.data.visibility === "private") {
      return reply.code(403).send({ error: "forbidden", message: "a public key cannot make a source private" });
    }
    try {
      const source = await updateSource(id, parsed.data);
      if (!source) return reply.code(404).send({ error: "not_found" });
      return reply.send(source);
    } catch (err) {
      return sourceErrorReply(err, reply);
    }
  });

  app.delete("/v1/sources/:id", { preHandler: requireScope("admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const purge = (req.query as { purge?: string }).purge === "true";
    const r = await deleteSource(id, { purge });
    if (!r.deleted) return reply.code(404).send({ error: "not_found" });
    return reply.send({ id, deleted: true, purged: r.purged });
  });

  app.post("/v1/sources/:id/index", { preHandler: requireScope("admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = IndexBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return reply.send(await indexSource(id, { force: parsed.data?.force }));
    } catch (err) {
      if (err instanceof SourceBusyError) return reply.code(409).send({ error: "already_indexing", id });
      if (err instanceof SourceError && err.code === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.code(502).send({ error: "index_failed", id, message: (err as Error).message });
    }
  });
}
