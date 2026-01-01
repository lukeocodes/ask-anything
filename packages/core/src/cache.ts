import { loadEnv } from "@ask/config";
import {
  and,
  answerCache,
  cosineDistance,
  db,
  eq,
  sql,
  type AnswerCache,
} from "@ask/db";
import type { Visibility } from "./types.js";

/**
 * Semantic answer cache. A near-identical repeat question (by embedding
 * similarity) in the SAME visibility tier returns a stored answer with no model
 * call — the biggest speed/cost lever, model-independent.
 *
 * Safety: lookups are tier-exact. A public request only reads public-tier
 * entries, so a private-derived answer can never be served publicly.
 */
export interface CachedAnswer {
  id: string;
  answerText: string;
  citedItemIds: string[];
  model: string;
}

export async function lookupAnswerCache(
  queryVector: number[],
  visibility: Visibility,
): Promise<CachedAnswer | null> {
  const env = loadEnv();
  if (!env.CACHE_ENABLED) return null;

  // Order by the raw `<=>` distance ascending — the only shape pgvector's HNSW
  // index serves. Similarity (1 - distance) is derived afterwards for the gate.
  const distance = cosineDistance(answerCache.questionEmbedding, queryVector);
  const [row] = await db()
    .select({ row: answerCache, distance: sql<number>`${distance}` })
    .from(answerCache)
    .where(
      and(
        eq(answerCache.visibility, visibility),
        eq(answerCache.invalidated, false),
        sql`${answerCache.expiresAt} > now()`,
        sql`${answerCache.questionEmbedding} is not null`,
      ),
    )
    .orderBy(distance)
    .limit(1);

  if (!row || 1 - Number(row.distance) < env.CACHE_SIMILARITY) return null;

  const hit = row.row as AnswerCache;
  await db()
    .update(answerCache)
    .set({ hits: sql`${answerCache.hits} + 1` })
    .where(eq(answerCache.id, hit.id));

  return {
    id: hit.id,
    answerText: hit.answerText,
    citedItemIds: hit.citedItemIds,
    model: hit.model,
  };
}

export async function storeAnswerCache(input: {
  queryVector: number[];
  queryText: string;
  visibility: Visibility;
  answerText: string;
  citedItemIds: string[];
  model: string;
  /** The `answers` row this entry came from — lets a `down` evict it directly. */
  answerId?: string;
  /** TTL in hours — defaults to CACHE_TTL_HOURS. */
  ttlHours?: number;
}): Promise<void> {
  const env = loadEnv();
  if (!env.CACHE_ENABLED) return;
  const ttlHours = input.ttlHours ?? env.CACHE_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db().insert(answerCache).values({
    questionEmbedding: input.queryVector,
    queryText: input.queryText,
    visibility: input.visibility,
    answerText: input.answerText,
    citedItemIds: input.citedItemIds,
    model: input.model,
    answerId: input.answerId,
    expiresAt,
  });
}

/**
 * Invalidate the cached entry stored from a specific answer (a `down` on it). This
 * evicts even when the answer cited no items, which the item-based
 * invalidation can't reach.
 */
export async function invalidateAnswerCacheForAnswer(answerId: string): Promise<void> {
  await db()
    .update(answerCache)
    .set({ invalidated: true })
    .where(eq(answerCache.answerId, answerId));
}

/** Invalidate any cached answer that cited one of these items. */
export async function invalidateAnswerCacheForItems(
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  // Build a typed uuid[] literal (ARRAY['id'::uuid, …]); binding a JS array
  // straight into `&&` makes Postgres try to parse a bare uuid as an array
  // literal (22P02). Each id is a separate bound parameter.
  const arr = sql`array[${sql.join(
    itemIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  await db()
    .update(answerCache)
    .set({ invalidated: true })
    .where(sql`${answerCache.citedItemIds} && ${arr}`);
}

/**
 * Invalidate every live cached answer. Use after a change that alters how
 * answers are produced (a retrieval/threshold change, a model swap) so stale
 * answers cached before the change aren't served. Returns the count.
 */
export async function invalidateAllAnswerCache(): Promise<number> {
  const rows = await db()
    .update(answerCache)
    .set({ invalidated: true })
    .where(eq(answerCache.invalidated, false))
    .returning({ id: answerCache.id });
  return rows.length;
}
