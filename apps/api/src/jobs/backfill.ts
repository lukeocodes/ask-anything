import { logger } from "@ask/config";
import { ask, emitEvent, listKnowledgeGaps } from "@ask/core";

const log = logger("gap-backfill");

/**
 * Retroactive gap backfill. Questions the engine previously couldn't answer are
 * recorded as `question.unanswered` events (the gap ledger). The
 * knowledge base grows continuously — source indexing, approved proposals,
 * and manual adds — so a gap recorded last week may be answerable today.
 *
 * This job re-asks each open gap. When one now returns a grounded answer, it
 * emits `question.answered`, which closes the gap (listKnowledgeGaps excludes
 * questions answered after they were last missed) and warms the cache for the
 * next asker. Gaps that still abstain stay open for the next run.
 */
export async function runGapBackfill(
  limit = 30,
): Promise<{ total: number; resolved: number; stillOpen: number }> {
  const gaps = await listKnowledgeGaps(limit);
  if (gaps.length === 0) {
    log.info("no open knowledge gaps");
    return { total: 0, resolved: 0, stillOpen: 0 };
  }

  let resolved = 0;
  let stillOpen = 0;
  for (const gap of gaps) {
    try {
      const r = await ask(gap.question, { surface: "backfill", visibility: "public" });
      if (r.abstained) {
        stillOpen++;
      } else {
        resolved++;
        await emitEvent("question.answered", { question: gap.question, surface: "backfill" });
      }
    } catch (err) {
      log.warn({ err, question: gap.question }, "gap re-ask failed");
    }
  }
  const stats = { total: gaps.length, resolved, stillOpen };
  log.info(stats, "gap backfill finished");
  return stats;
}
