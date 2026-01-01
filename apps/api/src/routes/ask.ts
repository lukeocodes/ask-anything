import { ask, askStream, reverifyItems } from "@ask/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { costCapGuard, requireScope, resolveVisibility } from "../auth.js";

/** Fire-and-forget: cited items past REVERIFY_AGE_HOURS are re-checked through their source adapter. */
function scheduleReverify(itemIds: string[]): void {
  void reverifyItems(itemIds).catch(() => {});
}

const AskBody = z.object({
  // Capped so the question can't push a `question.unanswered` NOTIFY past the
  // 8 KB pg_notify limit (the payload is truncated server-side as a backstop).
  question: z.string().min(1).max(4000),
  // `backfill` / `warm` are the engine's own cron surfaces (no demand signal).
  surface: z.enum(["api", "cli", "mcp", "backfill", "warm"]).default("api"),
  actorRef: z.string().optional(),
  limit: z.number().int().positive().max(20).optional(),
  // Prior conversation supplied by the caller (not a citable source).
  context: z.string().optional(),
  // Requested visibility. Capped to the caller's key tier server-side.
  visibility: z.enum(["public", "private"]).optional(),
});

export async function askRoutes(app: FastifyInstance): Promise<void> {
  // Answering a question is a read of the knowledgebase.
  app.post(
    "/v1/ask",
    { preHandler: [requireScope("read"), costCapGuard] },
    async (req, reply) => {
      const parsed = AskBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { question, surface, actorRef, limit, context } = parsed.data;
      const visibility = resolveVisibility(req.apiKey!, parsed.data.visibility);

      const result = await ask(question, {
        surface,
        actorRef: actorRef ?? req.apiKey?.label,
        limit,
        context,
        visibility,
        scheduleReverify,
      });

      // The model emits canonical Markdown; clients render it for their surface.
      return reply.send(result);
    },
  );

  // Streaming answer over Server-Sent Events. Emits `delta` events as text is
  // produced, then a final `done` event carrying the full AskResult.
  app.post(
    "/v1/ask/stream",
    { preHandler: [requireScope("read"), costCapGuard] },
    async (req, reply) => {
      const parsed = AskBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { question, surface, actorRef, limit, context } = parsed.data;
      const visibility = resolveVisibility(req.apiKey!, parsed.data.visibility);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // SSE `delta` events carry the model's raw Markdown tokens (append-safe);
      // `step` events carry pipeline progress (retrieval, cache) that streaming
      // clients can render natively. The client renders both for its surface.
      const writeDelta = (text: string) => {
        if (text) raw.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
      };
      const writeStep = (step: unknown) => {
        raw.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
      };

      try {
        const result = await askStream(
          question,
          {
            surface,
            actorRef: actorRef ?? req.apiKey?.label,
            limit,
            context,
            visibility,
            scheduleReverify,
          },
          (md) => writeDelta(md),
          (step) => writeStep(step),
        );
        raw.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
      } catch (err) {
        raw.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
      } finally {
        raw.end();
      }
    },
  );
}
