import type { GroundingChunk } from "@ask/ai";
import { fuseAndRank, gatherPool, type Visibility } from "@ask/core";

/**
 * Retrieval-only search over the index (hybrid vector+lexical), reranked. No
 * LLM synthesis. Shared by the REST `/v1/search` route and the MCP `search`
 * tool — and built on the SAME gather→fuse→rank core `ask` uses, so the two
 * can't drift apart. `gatherPool` over-fetches and enforces the visibility
 * floor; `fuseAndRank` dedupes, reranks, and slices.
 *
 * `visibility` defaults to public (fail closed). Callers must resolve it from
 * the credential (see auth.resolveVisibility) — the hosted MCP engine stays
 * pinned to public because it is unauthenticated.
 */
export async function publicSearch(
  query: string,
  limit = 8,
  visibility: Visibility = "public",
): Promise<GroundingChunk[]> {
  const pool = await gatherPool(query, { visibility, limit });
  return fuseAndRank(query, pool, limit);
}
