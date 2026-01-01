import { type GroundingChunk } from "@ask/ai";
import { type Env, loadEnv } from "@ask/config";
import { rankChunks } from "./rank.js";
import { retrieveFromDb, toChunks } from "./retrieval.js";
import type { Visibility } from "./types.js";

export interface GatherOptions {
  visibility: Visibility;
  limit: number;
  /** Over-fetch multiplier; defaults to RERANK_POOL_FACTOR. */
  poolFactor?: number;
  /** Precomputed query embedding, threaded through to avoid a re-embed. */
  queryVector?: number[];
  tags?: string[];
}

/**
 * Hard visibility post-condition: a public caller must NEVER see a private
 * chunk. `retrieveFromDb` already filters in SQL, but enforcing it here (in the
 * one shared core) means the guarantee can't be lost by a call site. A private
 * caller sees everything (private is inclusive of public).
 */
function enforceVisibility(chunks: GroundingChunk[], visibility: Visibility): GroundingChunk[] {
  if (visibility === "private") return chunks;
  return chunks.filter((c) => c.visibility !== "private");
}

/**
 * Fetch the index at pool width and map it to chunks — one untruncated
 * candidate pool. No ranking, no slicing — that's `fuseAndRank`. Degrades to []
 * on error so a retrieval failure never throws out of the gather.
 */
export async function gatherPool(query: string, opts: GatherOptions): Promise<GroundingChunk[]> {
  const width = opts.limit * (opts.poolFactor ?? loadEnv().RERANK_POOL_FACTOR);
  const chunks = await retrieveFromDb(query, {
    limit: width,
    visibility: opts.visibility,
    queryVector: opts.queryVector,
    tags: opts.tags,
  })
    .then(toChunks)
    .catch(() => [] as GroundingChunk[]);
  return enforceVisibility(chunks, opts.visibility);
}

/** Rerank + dedupe + slice. Thin alias over `rankChunks` so both ask and
 *  search fuse identically. */
export async function fuseAndRank(
  query: string,
  pool: GroundingChunk[],
  limit: number,
): Promise<GroundingChunk[]> {
  return rankChunks(query, pool, { limit });
}

/**
 * Numeric answerability gate over a ranked pool. Answerable when the top hit is
 * relevant (reranked score ≥ threshold — or, when no reranker ran, its decayed
 * confidence clears the freshness floor) AND fresh. A chunk with no confidence
 * is treated as fresh (`?? 1`). Relevance and freshness stay separate signals
 * so a stale-but-relevant item still escalates rather than answering.
 */
export function isSufficient(ranked: GroundingChunk[], env: Env): boolean {
  const top = ranked[0];
  if (!top) return false;
  const fresh = (top.confidence ?? 1) >= env.FASTPATH_MIN_CONFIDENCE;
  const relevant =
    top.score !== undefined
      ? top.score >= env.RELEVANCE_ANSWER_THRESHOLD
      : (top.confidence ?? 0) >= env.FASTPATH_MIN_CONFIDENCE;
  return relevant && fresh;
}
