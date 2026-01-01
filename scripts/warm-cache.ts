import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "@ask/config";

/**
 * Pre-warm the answer cache with common questions. Each question is run through
 * /v1/ask at public visibility; the pipeline caches every non-abstained answer
 * (keyed by the query embedding), so real users — who ask paraphrases — hit the
 * cache instead of paying for retrieval + generation.
 *
 *   pnpm warm-cache [path/to/questions.txt]
 *
 * Idempotent: re-running just refreshes/serves from cache. Abstains (nothing in
 * the knowledgebase) are reported and NOT cached.
 */
const here = dirname(fileURLToPath(import.meta.url));

function loadQuestions(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function ask(url: string, key: string, question: string) {
  const res = await fetch(`${url}/v1/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ question, surface: "api", visibility: "public" }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as { abstained: boolean; citedIds: string[] };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.ASK_API_URL;
  const key = env.ASK_API_KEY;
  if (!key) throw new Error("ASK_API_KEY is not set");

  const file = process.argv[2] ?? join(here, "common-questions.txt");
  const questions = loadQuestions(file);
  console.log(`Warming cache with ${questions.length} questions via ${url}\n`);

  let cached = 0;
  let abstained = 0;
  let failed = 0;
  for (const [i, q] of questions.entries()) {
    const n = `${i + 1}/${questions.length}`;
    try {
      const r = await ask(url, key, q);
      if (r.abstained) {
        abstained++;
        console.log(`  ⚠️  ${n} abstained  — ${q}`);
      } else {
        cached++;
        console.log(`  ✅ ${n} cached (${r.citedIds.length} cites) — ${q}`);
      }
    } catch (err) {
      failed++;
      console.log(`  ❌ ${n} failed     — ${q}\n       ${String(err)}`);
    }
    // Gentle pacing for the embeddings rate limits.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\nDone: ${cached} cached, ${abstained} abstained, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
