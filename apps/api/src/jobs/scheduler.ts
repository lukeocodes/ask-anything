import { loadEnv, logger } from "@ask/config";
import { indexDueSources, runDecay } from "@ask/core";
import cron from "node-cron";
import { runGapBackfill } from "./backfill.js";
import { verifyReviewItems } from "./monitor.js";
import { runCacheWarm } from "./warm.js";

const log = logger("scheduler");

/**
 * Wire the background jobs to cron. All are part of the core API service (the
 * maintenance jobs).
 */
export function startScheduler(): void {
  const env = loadEnv();

  // Verify tick: items owned by a `review`-trust adapter are checked upstream
  // and changes become proposals. A no-op while every adapter is `upstream`.
  if (cron.validate(env.MONITOR_CRON)) {
    cron.schedule(env.MONITOR_CRON, () => {
      verifyReviewItems().catch((err) => log.error({ err }, "verify job failed"));
    });
    log.info({ cron: env.MONITOR_CRON }, "verify job scheduled");
  } else {
    log.warn({ cron: env.MONITOR_CRON }, "invalid MONITOR_CRON; verify disabled");
  }

  if (cron.validate(env.DECAY_CRON)) {
    cron.schedule(env.DECAY_CRON, () => {
      runDecay()
        .then((r) => log.info(r, "decay pass complete"))
        .catch((err) => log.error({ err }, "decay job failed"));
    });
    log.info({ cron: env.DECAY_CRON }, "decay job scheduled");
  } else {
    log.warn({ cron: env.DECAY_CRON }, "invalid DECAY_CRON; decay disabled");
  }

  if (cron.validate(env.WARM_CACHE_CRON)) {
    cron.schedule(env.WARM_CACHE_CRON, () => {
      runCacheWarm().catch((err) => log.error({ err }, "warm-cache job failed"));
    });
    log.info({ cron: env.WARM_CACHE_CRON }, "warm-cache job scheduled");
  } else {
    log.warn({ cron: env.WARM_CACHE_CRON }, "invalid WARM_CACHE_CRON; warm-cache disabled");
  }

  // Registered sources (ADR-0024): each tick indexes the sources whose own
  // schedule (or INDEX_DEFAULT_SCHEDULE) has fired since their last index.
  // Empty INDEX_CRON disables the tick; `ask sources index` still works.
  if (env.INDEX_CRON && cron.validate(env.INDEX_CRON)) {
    cron.schedule(env.INDEX_CRON, () => {
      indexDueSources()
        .then((r) => {
          if (r.ran > 0) log.info({ ran: r.ran, errors: r.errors.length }, "source index tick complete");
        })
        .catch((err) => log.error({ err }, "source index tick failed"));
    });
    log.info({ cron: env.INDEX_CRON }, "source index tick scheduled");
  } else if (env.INDEX_CRON) {
    log.warn({ cron: env.INDEX_CRON }, "invalid INDEX_CRON; source indexing tick disabled");
  }

  // Retroactive backfill: re-ask previously-unanswered questions (empty disables).
  if (env.BACKFILL_CRON && cron.validate(env.BACKFILL_CRON)) {
    cron.schedule(env.BACKFILL_CRON, () => {
      runGapBackfill().catch((err) => log.error({ err }, "gap-backfill job failed"));
    });
    log.info({ cron: env.BACKFILL_CRON }, "gap-backfill job scheduled");
  } else if (env.BACKFILL_CRON) {
    log.warn({ cron: env.BACKFILL_CRON }, "invalid BACKFILL_CRON; gap-backfill disabled");
  }
}
