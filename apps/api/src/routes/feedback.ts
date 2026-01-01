import { addFeedbackComment, emitEvent, getAnswer, invalidateAnswerCacheForAnswer, recordFeedback } from "@ask/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireScope } from "../auth.js";

const FeedbackBody = z.object({
  rating: z.enum(["up", "down"]),
  actorRef: z.string().optional(),
  surface: z.enum(["api", "cli", "mcp"]).optional(),
  comment: z.string().optional(),
});

const CommentBody = z.object({
  comment: z.string().min(1),
  actorRef: z.string().optional(),
  surface: z.enum(["api", "cli", "mcp"]).optional(),
});

/**
 * Feedback endpoints — surface-agnostic. The CLI (`ask feedback …`), the
 * management MCP and any other REST caller are all just clients of these.
 */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  // +/- feedback on an answer.
  app.post(
    "/v1/answers/:id/feedback",
    { preHandler: requireScope("read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = FeedbackBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      if (!(await getAnswer(id))) return reply.code(404).send({ error: "not_found" });

      const row = await recordFeedback(id, parsed.data);
      // A `down` evicts the cache entry stored from this answer — including one with
      // no DB citations (no item citations), which item-based invalidation
      // (inside recordFeedback) can't reach. Best-effort.
      if (parsed.data.rating === "down") {
        void invalidateAnswerCacheForAnswer(id).catch(() => {});
      }
      // Consumers of /v1/events can react (e.g. surface a `down` to an operator).
      void emitEvent("answer.feedback", {
        answerId: id,
        rating: parsed.data.rating,
        actorRef: parsed.data.actorRef,
        surface: parsed.data.surface,
      });
      return reply.code(201).send({ id: row.id, rating: row.rating });
    },
  );

  // Natural-language follow-up feedback (typically after a `down`).
  app.post(
    "/v1/answers/:id/feedback/comment",
    { preHandler: requireScope("read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CommentBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }
      if (!(await getAnswer(id))) return reply.code(404).send({ error: "not_found" });

      const row = await addFeedbackComment(id, parsed.data);
      return reply.code(201).send({ id: row.id });
    },
  );
}
