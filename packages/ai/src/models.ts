import { loadEnv, logger } from "@ask/config";

const log = logger("models");

/**
 * Two model tiers:
 *  - answer: capable model that composes grounded answers (default Opus 4.8).
 *  - cheap:  fast/cheap model for summaries, titles, normalisation, and
 *            question clustering (default Haiku 4.5).
 */
export function answerModel(): string {
  return loadEnv().ASK_ANSWER_MODEL;
}

export function cheapModel(): string {
  return loadEnv().ASK_CHEAP_MODEL;
}

/** Rough $/1M token rates for cost telemetry. Update alongside model changes. */
const RATES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // Gemini on Vertex (approx $/1M tokens).
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  // Voyage embeddings — input-only, approximate list $/1M tokens. VERIFY
  // against https://www.voyageai.com/pricing before trusting the cap on these.
  "voyage-4-lite": { in: 0.02, out: 0 },
  "voyage-3-lite": { in: 0.02, out: 0 },
  "voyage-3": { in: 0.06, out: 0 },
  // Voyage rerankers — query+document tokens, approximate list $/1M. VERIFY.
  "rerank-2.5-lite": { in: 0.02, out: 0 },
  "rerank-2-lite": { in: 0.02, out: 0 },
  "rerank-2": { in: 0.05, out: 0 },
};

/** Model ids already warned about — an unknown model logs once, not per call. */
const warnedUnknown = new Set<string>();

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const rate = RATES[model];
  if (!rate) {
    if (!warnedUnknown.has(model)) {
      warnedUnknown.add(model);
      log.warn({ model }, "no rate for model — its cost is invisible to the daily cap; add it to RATES");
    }
    return undefined;
  }
  return (inputTokens * rate.in + outputTokens * rate.out) / 1_000_000;
}
