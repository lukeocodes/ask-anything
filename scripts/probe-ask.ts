import { ask } from "@ask/core";
async function main() {
  const t0 = Date.now();
  const r = await ask("what does this project do?", { surface: "cli", visibility: "private" });
  console.log(`(${Date.now()-t0}ms) abstained=${r.abstained} cited=${r.citedIds.length}`);
  console.log("ANSWER:", r.answer.slice(0, 500));
}
main().catch(e => { console.error("PIPELINE ERROR:", e.stack || e.message); process.exit(1); });
