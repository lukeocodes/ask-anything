import { logger } from "@ask/config";
import {
  and,
  db,
  decayEvents,
  eq,
  inArray,
  knowledgeItems,
  sql,
  type KnowledgeItem,
} from "@ask/db";

/**
 * Symbolic decay / adaptive forgetting.
 *
 * Effective confidence combines a symbolic prior (source authority via
 * baseConfidence), continuous time decay (exp), and a reinforcement term
 * (frequently-retrieved knowledge decays slower — adaptive forgetting):
 *
 *   ageDays   = (now - lastVerifiedAt) / 1 day
 *   reinforce = 1 + ln(1 + retrievalCount)      // ≥ 1, grows with use
 *   lambdaEff = decayRate / reinforce            // heavier use → slower decay
 *   effective = baseConfidence * exp(-lambdaEff * ageDays)
 *
 * Items whose effective confidence falls below STALE_THRESHOLD are marked
 * `stale` and re-read by the next source index — never deleted.
 */
export const STALE_THRESHOLD = 0.4;
const MS_PER_DAY = 86_400_000;

export function effectiveConfidence(
  item: Pick<
    KnowledgeItem,
    "baseConfidence" | "decayRate" | "retrievalCount" | "lastVerifiedAt"
  >,
  now: Date = new Date(),
): number {
  const ageDays =
    (now.getTime() - new Date(item.lastVerifiedAt).getTime()) / MS_PER_DAY;
  if (ageDays <= 0) return item.baseConfidence;
  const reinforce = 1 + Math.log1p(Math.max(0, item.retrievalCount));
  const lambdaEff = item.decayRate / reinforce;
  return item.baseConfidence * Math.exp(-lambdaEff * ageDays);
}

export interface DecayRunResult {
  scanned: number;
  markedStale: number;
}

/**
 * Recompute decay across the knowledgebase, flip newly-stale items, and record
 * a decay_event audit row for each. Run on a schedule (DECAY_CRON).
 */
export async function runDecay(now: Date = new Date()): Promise<DecayRunResult> {
  const log = logger("decay");
  const items = (await db()
    .select()
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.status, ["active", "stale"]))) as KnowledgeItem[];

  let markedStale = 0;
  for (const item of items) {
    const eff = effectiveConfidence(item, now);
    const shouldBeStale = eff < STALE_THRESHOLD;

    await db().insert(decayEvents).values({
      itemId: item.id,
      effectiveConfidence: eff,
      reason: shouldBeStale ? "below_threshold" : "recomputed",
    });

    if (shouldBeStale && item.status === "active") {
      await db()
        .update(knowledgeItems)
        .set({ status: "stale", updatedAt: now })
        .where(and(eq(knowledgeItems.id, item.id), eq(knowledgeItems.status, "active")));
      markedStale++;
    }
  }

  log.info({ scanned: items.length, markedStale }, "decay run complete");
  return { scanned: items.length, markedStale };
}

/**
 * Reinforce an item on retrieval: bump the counter and, if it was a strong hit,
 * nudge lastVerifiedAt forward so genuinely-used knowledge resists decay.
 */
export async function reinforce(
  itemId: string,
  opts?: { verify?: boolean },
): Promise<void> {
  await db()
    .update(knowledgeItems)
    .set({
      retrievalCount: sql`${knowledgeItems.retrievalCount} + 1`,
      lastRetrievedAt: new Date(),
      ...(opts?.verify ? { lastVerifiedAt: new Date() } : {}),
    })
    .where(eq(knowledgeItems.id, itemId));
}
