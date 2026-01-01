import { getChunkContext, getItem, getItemChunkTree } from "@ask/core";
import type { FastifyInstance } from "fastify";
import { requireScope, visibleTo } from "../auth.js";

/** Chunk-tree reads (ADR-0025). */
export async function chunkRoutes(app: FastifyInstance): Promise<void> {
  // A record's whole chunk tree: flat rows in document order + nested shape.
  app.get(
    "/v1/knowledge/:id/chunks",
    { preHandler: requireScope("read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const item = await getItem(id);
      if (!item || !visibleTo(req, item)) return reply.code(404).send({ error: "not_found" });
      const { chunks, tree } = await getItemChunkTree(id);
      return reply.send({ itemId: id, chunks, tree });
    },
  );

  // One chunk with its parent, siblings, and children.
  app.get(
    "/v1/chunks/:id/context",
    { preHandler: requireScope("read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const context = await getChunkContext(id);
      if (!context) return reply.code(404).send({ error: "not_found" });
      const item = await getItem(context.chunk.itemId);
      if (!item || !visibleTo(req, item)) return reply.code(404).send({ error: "not_found" });
      return reply.send(context);
    },
  );
}
