import { estimateCostUsd, type GroundingChunk, rerank } from "@ask/ai";
import { loadEnv, logger } from "@ask/config";
import { recordUsage } from "./telemetry.js";

const log = logger("rank");

/** Dedupe by id, first occurrence wins. */
function dedupe(chunks: GroundingChunk[]): GroundingChunk[] {
  const seen = new Set<string>();
  const out: GroundingChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * Fair merge when no reranker ran: interleave by `source` so no single source
 * (e.g. a full DB result set) can starve the others. Preserves each source's
 * internal order. This is what structurally prevents the DB-first truncation.
 */
function roundRobinBySource(chunks: GroundingChunk[]): GroundingChunk[] {
  const groups = new Map<string, GroundingChunk[]>();
  for (const c of chunks) {
    const g = groups.get(c.source);
    if (g) g.push(c);
    else groups.set(c.source, [c]);
  }
  const lists = [...groups.values()];
  const out: GroundingChunk[] = [];
  for (let i = 0; out.length < chunks.length; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Cross-source relevance ranking + dedupe — the single place that decides
 * whether a real reranker ran, so every caller stays consistent.
 *
 * When RERANK_ENABLED and a reranker actually scores the candidates, orders
 * best-first and stamps `chunk.score` (0-1). When reranking is disabled, no
 * provider is configured or the call times out (`rerank` returns null), or the
 * call errors, returns a fair round-robin-by-source order with `score`
 * UNDEFINED — signalling that relevance is unknown so callers fall back to their
 * confidence gate. Always dedupes and slices to `limit` last.
 */
export async function rankChunks(
  query: string,
  chunks: GroundingChunk[],
  opts?: { limit?: number },
): Promise<GroundingChunk[]> {
  const env = loadEnv();
  const limit = opts?.limit ?? 8;
  const deduped = dedupe(chunks);
  if (deduped.length === 0) return [];

  const fallback = () => roundRobinBySource(deduped).slice(0, limit);

  if (!env.RERANK_ENABLED) return fallback();

  const docs = deduped.map((c) => `${c.title}\n${c.body}`.slice(0, env.RERANK_DOC_CHARS));
  const startedAt = Date.now();
  try {
    const res = await rerank(query, docs, { topK: limit });
    // null = no reranker ran (unconfigured or timed out): relevance unknown.
    if (res === null) return fallback();
    void recordUsage({
      kind: "rerank", model: res.model, tokensIn: res.tokens,
      costUsd: estimateCostUsd(res.model, res.tokens ?? 0, 0),
      latencyMs: Date.now() - startedAt,
      metadata: { provider: res.provider, docs: docs.length, topK: limit },
    }).catch(() => {});
    if (res.hits.length === 0) return fallback();
    const ranked: GroundingChunk[] = [];
    for (const h of res.hits) {
      const chunk = deduped[h.index];
      if (chunk) ranked.push({ ...chunk, score: h.score });
    }
    return ranked.slice(0, limit);
  } catch (err) {
    log.warn({ err }, "rerank failed — falling back to round-robin");
    return fallback();
  }
}
