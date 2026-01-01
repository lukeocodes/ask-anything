import { logger } from "@ask/config";
import { adapterContext, getSource, listAdapters, proposeUpdate } from "@ask/core";
import { and, db, eq, inArray, knowledgeItems, type KnowledgeItem } from "@ask/db";

const log = logger("verify");

export interface VerifyRunResult {
  checked: number;
  proposed: number;
  byKind: Record<string, { checked: number; proposed: number }>;
}

/**
 * The MONITOR_CRON tick. For every registered adapter with `trust: "review"`
 * and a `verify`, re-check the items it owns against the upstream; a changed
 * upstream becomes a pending proposal (GET /v1/proposals) rather than an
 * in-place write. `upstream`-trust adapters refresh in place on the index
 * tick instead, so with only the shipped git / url adapters this is a no-op.
 */
export async function verifyReviewItems(opts: { limitPerKind?: number } = {}): Promise<VerifyRunResult> {
  const limit = opts.limitPerKind ?? 200;
  const result: VerifyRunResult = { checked: 0, proposed: 0, byKind: {} };
  const reviewers = listAdapters().filter((a) => a.trust === "review" && typeof a.verify === "function");
  if (reviewers.length === 0) {
    log.debug("no review-trust adapters registered; nothing to verify");
    return result;
  }

  for (const adapter of reviewers) {
    const stats = { checked: 0, proposed: 0 };
    const items = (await db()
      .select()
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.sourceType, adapter.kind),
          inArray(knowledgeItems.status, ["active", "stale"]),
        ),
      )
      .limit(limit)) as KnowledgeItem[];

    for (const item of items) {
      const source = item.sourceId ? await getSource(item.sourceId) : undefined;
      if (!source) {
        log.debug({ itemId: item.id }, "verify skipped: item has no registered source");
        continue;
      }
      stats.checked += 1;
      try {
        const candidate = await adapter.verify!(item, adapterContext(source));
        if (candidate) {
          await proposeUpdate(item.id, item.sourceType, candidate);
          stats.proposed += 1;
        }
      } catch (err) {
        log.warn({ err, itemId: item.id }, "verify item failed");
      }
    }

    result.byKind[adapter.kind] = stats;
    result.checked += stats.checked;
    result.proposed += stats.proposed;
    log.info({ kind: adapter.kind, ...stats }, "verify pass complete");
  }

  if (result.proposed > 0) {
    log.info({ proposed: result.proposed }, `${result.proposed} proposal(s) created; review via GET /v1/proposals`);
  }
  return result;
}
