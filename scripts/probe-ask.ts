import { ask, fuseAndRank, gatherPool } from "@ask/core";

/**
 * Probe the pipeline from a terminal, at private visibility.
 *
 *   tsx scripts/probe-ask.ts [--retrieval-only] ["query one" "query two" ...]
 *
 * Default mode answers each query and prints timing, abstention, cite count and
 * the answer. `--retrieval-only` stops after gather + rank and prints the raw
 * hits: the side-effect-free view of what the answer path would be fed.
 *
 * Every probe costs one embeddings call, which is also an egress (ADR-0008), so
 * the modes are separate — no invocation pays for both.
 */

const DEFAULT_QUERY = "what does this project do?";

/** `ask()`'s own default grounding width, so the hits shown are the hits used. */
const LIMIT = 8;

async function probeRetrieval(query: string): Promise<void> {
  const pool = await gatherPool(query, { visibility: "private", limit: LIMIT });
  const hits = await fuseAndRank(query, pool, LIMIT);
  if (hits.length === 0) {
    console.log("  (no hits)");
    return;
  }
  for (const h of hits) {
    const score = h.score === undefined ? "" : ` (${h.score.toFixed(3)})`;
    console.log(`  • ${h.title}${score}`);
    console.log(`    ${h.url ?? "(no url)"}`);
    console.log(`    ${h.body.slice(0, 120).replace(/\s+/g, " ")}…`);
  }
}

async function probeAnswer(query: string): Promise<void> {
  const t0 = Date.now();
  const r = await ask(query, { surface: "cli", visibility: "private" });
  console.log(`  (${Date.now() - t0}ms) abstained=${r.abstained} cited=${r.citedIds.length}`);
  console.log(`  ${r.answer.slice(0, 500)}`);
}

const USAGE = 'usage: tsx scripts/probe-ask.ts [--retrieval-only] ["query one" "query two" ...]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const retrievalOnly = args.includes("--retrieval-only");
  const queries = args.filter((a) => a !== "--retrieval-only");
  // A mistyped flag must not fall through as a query: that would silently cost a
  // model call and an egress (ADR-0008).
  const unknown = queries.filter((a) => a.startsWith("--"));
  if (unknown.length > 0) {
    console.error(`unknown option: ${unknown.join(" ")}\n${USAGE}`);
    process.exit(2);
  }
  if (queries.length === 0) queries.push(DEFAULT_QUERY);
  for (const query of queries) {
    console.log(`\n=== "${query}" ===`);
    await (retrievalOnly ? probeRetrieval(query) : probeAnswer(query));
  }
}

main().catch((err) => {
  console.error("PIPELINE ERROR:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
