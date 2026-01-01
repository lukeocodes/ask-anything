/**
 * Eval harness. Runs a golden set of questions against a running Ask API and
 * scores each answer. This is how you swap models (or tune retrieval) WITHOUT
 * guessing whether accuracy moved — run it before and after a change.
 *
 *   ASK_API_URL=http://localhost:3000 ASK_API_KEY=devkey123 pnpm eval
 *
 * Optional: pass a path to a .jsonl golden file as argv[2] (default eval/golden.jsonl).
 * Each line: { "question": "...", "expect": { "contains"?: string[], "url"?: string, "abstain"?: boolean } }
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface Expect {
  contains?: string[];
  url?: string;
  abstain?: boolean;
}
interface Golden {
  question: string;
  expect: Expect;
}
interface AskResponse {
  answer: string;
  citedIds: string[];
  abstained: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.ASK_API_URL ?? "http://localhost:3000";
const key = process.env.ASK_API_KEY;
if (!key) {
  console.error("Set ASK_API_KEY (and ASK_API_URL) to run the eval.");
  process.exit(2);
}

const file = process.argv[2] ?? join(here, "golden.jsonl");
const cases: Golden[] = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Golden);

function grade(res: AskResponse, expect: Expect): { pass: boolean; why: string } {
  if (expect.abstain !== undefined) {
    return res.abstained === expect.abstain
      ? { pass: true, why: "abstain matched" }
      : { pass: false, why: `expected abstain=${expect.abstain}, got ${res.abstained}` };
  }
  const hay = `${res.answer}\n${res.citedIds.join("\n")}`.toLowerCase();
  if (expect.url && !hay.includes(expect.url.toLowerCase())) {
    return { pass: false, why: `missing url ${expect.url}` };
  }
  for (const needle of expect.contains ?? []) {
    if (!hay.includes(needle.toLowerCase())) {
      return { pass: false, why: `missing "${needle}"` };
    }
  }
  return { pass: true, why: "ok" };
}

async function main(): Promise<void> {
  let passed = 0;
  let totalMs = 0;
  for (const c of cases) {
    const started = Date.now();
    const resp = await fetch(`${url}/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ question: c.question }),
    });
    const ms = Date.now() - started;
    totalMs += ms;
    if (!resp.ok) {
      console.log(`FAIL (${resp.status}) ${c.question}`);
      continue;
    }
    const res = (await resp.json()) as AskResponse;
    const { pass, why } = grade(res, c.expect);
    if (pass) passed++;
    console.log(`${pass ? "PASS" : "FAIL"} [${ms}ms] ${c.question}${pass ? "" : ` — ${why}`}`);
  }

  const accuracy = cases.length ? passed / cases.length : 0;
  console.log(
    `\n${passed}/${cases.length} passed  (accuracy ${(accuracy * 100).toFixed(0)}%)  avg ${Math.round(totalMs / Math.max(1, cases.length))}ms`,
  );
  process.exit(accuracy === 1 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
