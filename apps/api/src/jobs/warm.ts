import { logger } from "@ask/config";
import { ask, topQuestions } from "@ask/core";

const log = logger("warm-cache");

/**
 * Keep the answer cache warm for the questions people actually ask. Pulls the
 * most-asked canonical questions from the clustering telemetry and runs each at
 * public visibility, which re-populates any entries evicted by TTL, revisions,
 * or `down`. Auto-derived — no hand-maintained list — so it tracks real demand.
 *
 * (The curated seed list, `pnpm warm-cache`, covers a cold start before there's
 * enough telemetry to cluster.)
 */
export async function runCacheWarm(limit = 30): Promise<void> {
  const top = await topQuestions(limit);
  const questions = top.map((q) => q.canonicalText).filter(Boolean);
  if (questions.length === 0) {
    log.info("no clustered questions yet; nothing to warm");
    return;
  }

  let warmed = 0;
  let abstained = 0;
  for (const q of questions) {
    try {
      const r = await ask(q, { surface: "warm", visibility: "public" });
      if (r.abstained) abstained++;
      else warmed++;
    } catch (err) {
      log.warn({ err, q }, "warm failed");
    }
  }
  log.info({ total: questions.length, warmed, abstained }, "cache warm finished");
}
