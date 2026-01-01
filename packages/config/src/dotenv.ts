import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Minimal, dependency-free .env loader. Finds the repo root (nearest ancestor
 * with pnpm-workspace.yaml) and applies `.env` then `.env.local` (local wins).
 * Precedence: real process env > .env.local > .env — so inline/CI vars always
 * win and never get clobbered by a file.
 *
 * Syntax: `KEY=value`, optional `export`, `#` comment lines. An unquoted value
 * ends at ` #` (inline comment); quoted values keep `#`. `KEY=` with nothing
 * after it leaves KEY unset — so an optional `.url()` field in the schema
 * passes instead of failing on "".
 */
let loaded = false;

export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;

  const root = findRepoRoot(process.cwd());
  if (!root) return;

  const preexisting = new Set(Object.keys(process.env));
  const merged = new Map<string, string>();
  for (const name of [".env", ".env.local"]) {
    const file = join(root, name);
    if (existsSync(file)) parseInto(readFileSync(file, "utf8"), merged);
  }
  for (const [key, value] of merged) {
    if (!preexisting.has(key)) process.env[key] = value;
  }
}

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parse dotenv text into a map. Exported for tests; `loadEnvFiles` is the entry point. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  parseInto(text, out);
  return out;
}

function parseInto(text: string, out: Map<string, string>): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    if (!key) continue;
    const value = parseValue(stripped.slice(eq + 1).trim());
    // `KEY=` means unset — including unsetting a value an earlier file gave it.
    if (value === undefined) out.delete(key);
    else out.set(key, value);
  }
}

/** The value part of a line: quoted verbatim, unquoted up to an inline comment, empty → undefined. */
function parseValue(raw: string): string | undefined {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length >= 2) {
    const close = raw.indexOf(quote, 1);
    if (close !== -1) return raw.slice(1, close);
  }
  const value = raw.replace(/(^|\s)#.*$/, "").trim();
  return value === "" ? undefined : value;
}
