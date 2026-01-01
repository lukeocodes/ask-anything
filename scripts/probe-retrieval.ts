import { fuseAndRank, gatherPool } from "@ask/core";

/** Print raw retrieval hits for each query arg — a retrieval debug tool. */
async function main(): Promise<void> {
  const queries = process.argv.slice(2);
  if (queries.length === 0) {
    console.log('usage: tsx scripts/probe-retrieval.ts "query one" "query two"');
    return;
  }
  for (const q of queries) {
    console.log(`\n=== "${q}" ===`);
    const pool = await gatherPool(q, { visibility: "private", limit: 6 });
    const hits = await fuseAndRank(q, pool, 6);
    if (hits.length === 0) {
      console.log("  (no hits)");
      continue;
    }
    for (const h of hits) {
      console.log(`  • ${h.title}`);
      console.log(`    ${h.url ?? "(no url)"}`);
      console.log(`    ${h.body.slice(0, 120).replace(/\s+/g, " ")}…`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
