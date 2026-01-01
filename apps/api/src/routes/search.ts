import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireScope, resolveVisibility } from "../auth.js";
import { publicSearch } from "../search.js";

const SearchBody = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
  // Requested visibility. Capped to the caller's key tier server-side, exactly
  // as /v1/ask does — a public key is always forced to public.
  visibility: z.enum(["public", "private"]).optional(),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // Retrieval-only search (no synthesis) at the key's visibility tier. Also
  // backs the MCP `search` tool for stdio clients that proxy here.
  app.post("/v1/search", { preHandler: [requireScope("read")] }, async (req, reply) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const visibility = resolveVisibility(req.apiKey!, parsed.data.visibility);
    const hits = await publicSearch(parsed.data.query, parsed.data.limit, visibility);
    return reply.send({ hits });
  });
}
