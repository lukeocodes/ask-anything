import type { GroundingChunk } from "@ask/ai";
import { embed } from "@ask/ai";
import {
  and,
  cosineDistance,
  db,
  desc,
  eq,
  inArray,
  knowledgeChunks,
  knowledgeItems,
  sql,
  type KnowledgeItem,
} from "@ask/db";
import { effectiveConfidence } from "./decay.js";
import type { ScoredItem, Visibility } from "./types.js";

/**
 * Hybrid, neurosymbolic retrieval over CHUNKS.
 *
 * 1. Neural recall: cosine-similarity ANN over chunk embeddings (pgvector HNSW).
 * 2. Lexical recall: full-text search over chunk bodies (GIN over to_tsvector),
 *    so exact tokens — error codes, flag names, API paths — are found even when
 *    the embedding misses them.
 * 3. Fusion: Reciprocal Rank Fusion (RRF) merges the two ranked lists.
 * 4. Symbolic re-rank: multiply by the parent item's effective (decayed)
 *    confidence, then keep the best chunk per item.
 *
 *   score = rrf * (0.5 + 0.5 * effectiveConfidence)
 */
export interface RetrieveOptions {
  limit?: number;
  /** Include stale items (default false — they're pending refresh). */
  includeStale?: boolean;
  /** `public` returns only public items; `private` returns public + private. */
  visibility?: Visibility;
  /** Optional precomputed query embedding (avoids a duplicate embed call). */
  queryVector?: number[];
  /** Restrict to items carrying at least one of these tags. */
  tags?: string[];
}

const RRF_K = 60; // standard RRF damping constant

interface ChunkRow {
  chunkId: string;
  chunkBody: string;
  headingPath: string[];
  chunkPath: string;
  item: KnowledgeItem;
}

interface Candidate extends ChunkRow {
  rrf: number;
}

const chunkSelect = {
  chunkId: knowledgeChunks.id,
  chunkBody: knowledgeChunks.body,
  headingPath: knowledgeChunks.headingPath,
  chunkPath: knowledgeChunks.path,
  item: knowledgeItems,
};

export async function retrieveFromDb(
  query: string,
  opts: RetrieveOptions = {},
): Promise<ScoredItem[]> {
  const limit = opts.limit ?? 8;
  const poolSize = limit * 4;

  const queryVec =
    opts.queryVector ?? (await embed([query], { inputType: "query" })).vectors[0];
  if (!queryVec) return [];

  const statuses: ("active" | "stale")[] = opts.includeStale
    ? ["active", "stale"]
    : ["active"];

  const filters = [
    inArray(knowledgeItems.status, statuses),
    sql`${knowledgeChunks.embedding} is not null`,
  ];
  if ((opts.visibility ?? "public") === "public") {
    filters.push(eq(knowledgeItems.visibility, "public"));
  }
  if (opts.tags && opts.tags.length > 0) {
    filters.push(sql`${knowledgeItems.tags} && ${opts.tags}`);
  }

  // Order by the raw `<=>` distance ascending — the only shape pgvector's HNSW
  // index serves. Ranking here is by position (RRF), so no similarity is needed.
  const distance = cosineDistance(knowledgeChunks.embedding, queryVec);
  const tsquery = sql`plainto_tsquery('english', ${query})`;
  const tsdoc = sql`to_tsvector('english', ${knowledgeChunks.body})`;

  // Vector and lexical recall in parallel. Both join the item for status /
  // visibility / decay and return enough to rank without a second fetch.
  const [vectorRows, lexicalRows] = await Promise.all([
    db()
      .select(chunkSelect)
      .from(knowledgeChunks)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChunks.itemId))
      .where(and(...filters))
      .orderBy(distance)
      .limit(poolSize),
    db()
      .select(chunkSelect)
      .from(knowledgeChunks)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChunks.itemId))
      .where(and(...filters, sql`${tsdoc} @@ ${tsquery}`))
      .orderBy(desc(sql`ts_rank(${tsdoc}, ${tsquery})`))
      .limit(poolSize),
  ]);

  // Reciprocal Rank Fusion over the two lists.
  const candidates = new Map<string, Candidate>();
  const fuse = (rows: ChunkRow[]) => {
    rows.forEach((row, i) => {
      const inc = 1 / (RRF_K + i + 1);
      const existing = candidates.get(row.chunkId);
      if (existing) existing.rrf += inc;
      else candidates.set(row.chunkId, { ...row, rrf: inc });
    });
  };
  fuse(vectorRows);
  fuse(lexicalRows);

  // Symbolic re-rank + keep the best chunk per item.
  const now = new Date();
  const bestByItem = new Map<string, ScoredItem>();
  for (const c of candidates.values()) {
    const eff = effectiveConfidence(c.item, now);
    const score = c.rrf * (0.5 + 0.5 * eff);
    const prev = bestByItem.get(c.item.id);
    if (!prev || score > prev.score) {
      bestByItem.set(c.item.id, {
        item: c.item,
        chunkBody: c.chunkBody,
        chunkId: c.chunkId,
        headingPath: c.headingPath,
        chunkPath: c.chunkPath,
        relevance: c.rrf,
        effectiveConfidence: eff,
        score,
      });
    }
  }

  return [...bestByItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Map scored items to grounding chunks (using the matched chunk text). */
export function toChunks(scored: ScoredItem[]): GroundingChunk[] {
  return scored.map((s) => ({
    id: s.item.id,
    title: s.item.title,
    body: s.chunkBody || s.item.body,
    source: "db",
    // An indexed page keeps its source URL so citations can link to it.
    url:
      s.item.sourceRef && /^https?:\/\//.test(s.item.sourceRef)
        ? s.item.sourceRef
        : undefined,
    // Carry the item's tier so citations align with the keys schema.
    visibility: s.item.visibility,
    confidence: s.effectiveConfidence,
    // Tree position of the matched chunk (ADR-0025) — carried, not rendered.
    chunkId: s.chunkId,
    headingPath: s.headingPath,
    path: s.chunkPath,
  }));
}

/** Mark an item as verified now (used after a successful, cited answer). */
export async function touchVerified(id: string): Promise<void> {
  await db()
    .update(knowledgeItems)
    .set({ lastVerifiedAt: new Date() })
    .where(eq(knowledgeItems.id, id));
}
