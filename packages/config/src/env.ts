import { z } from "zod";
import { loadEnvFiles } from "./dotenv.js";

/**
 * Central environment schema. Every process (API, jobs, CLI, MCP) parses the
 * subset it needs from here. Parsing is lazy + cached so importing this
 * module never throws at import time.
 */
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  // Identity of this deployment — surfaced in the MCP server name and the
  // answer prompts. Describe what the configured sources cover.
  ASK_NAME: z.string().min(1).default("ask-anything"),
  ASK_DESCRIPTION: z
    .string()
    .min(1)
    .default("a grounded knowledge engine over the configured sources"),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Not `.url()`: the Cloud SQL unix-socket form (…@/db?host=/cloudsql/…) is a
  // valid postgres DSN but fails strict URL parsing (empty host).
  DATABASE_URL: z.string().min(1),

  // Static API keys — CSV of "key:label:scope:visibility" (see parseApiKeys).
  API_KEYS: z.string().default(""),

  // LLM provider: `anthropic` (Anthropic or an Anthropic-compatible gateway like
  // opencode zen) or `vertex` (Gemini on Google Vertex AI).
  LLM_PROVIDER: z.enum(["anthropic", "vertex"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // AI SDK provider baseURL — INCLUDE the version path (the provider appends
  // /messages). opencode zen: https://opencode.ai/zen/v1. Omit for Anthropic.
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ASK_ANSWER_MODEL: z.string().default("claude-opus-4-8"),
  ASK_CHEAP_MODEL: z.string().default("claude-haiku-4-5"),

  // Google Vertex AI (LLM / embeddings / rerank). Auth via ADC (local:
  // `gcloud auth application-default login`; Cloud Run: the runtime SA).
  GOOGLE_VERTEX_PROJECT: z.string().optional(),
  GOOGLE_VERTEX_LOCATION: z.string().default("us-central1"),

  // Embeddings
  // `vertex` (Gemini embeddings on Vertex), `voyage` (hosted; voyage-4-lite is
  // free up to 200M tokens), `openai`, or `local` (any OpenAI-compatible
  // embeddings server — set EMBEDDINGS_BASE_URL).
  EMBEDDINGS_PROVIDER: z.enum(["vertex", "voyage", "openai", "local"]).default("voyage"),
  EMBEDDINGS_MODEL: z.string().default("voyage-4-lite"),
  // Base URL for the `local` (or a custom `openai`-compatible) provider.
  EMBEDDINGS_BASE_URL: z.string().url().optional(),
  // Vector dimension. MUST match the pgvector column (regenerate the migration
  // if you change it). Voyage requests it via output_dimension; OpenAI via
  // dimensions; local servers use their model's native size.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Cross-encoder rerank over the candidate set — the answerability signal that
  // decides the ask fast path and orders search results. On by default; the
  // reranker degrades to a round-robin merge (relevance unknown) when no key is
  // configured, so this is safe to leave on. Requires VOYAGE_API_KEY (or the
  // vertex provider) to actually score; otherwise gates fall back to confidence.
  RERANK_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // `voyage` reranker, or `vertex` (Vertex AI Ranking API).
  RERANK_PROVIDER: z.enum(["voyage", "vertex"]).default("voyage"),
  RERANK_MODEL: z.string().default("rerank-2.5-lite"),
  // Reranked top-hit relevance at/above which the DB fast path answers directly;
  // below it, ask hands off to the index-searching agent. Voyage rerank-2.5-lite emits ~0-1
  // but is NOT calibrated to effectiveConfidence — tune against the eval set.
  RELEVANCE_ANSWER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  // Freshness floor (decayed confidence) for the fast path, and the answerability
  // fallback when no reranker ran. 0.4 mirrors
  // STALE_THRESHOLD so a stale-but-relevant item still escalates.
  FASTPATH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.4),
  // Max chars per document sent to the reranker (source bodies are unbounded).
  RERANK_DOC_CHARS: z.coerce.number().int().positive().default(1200),
  // Over-fetch multiplier: each source is gathered at limit×this into the pool
  // that the reranker then orders, so a good hit can't be missed by a tight limit.
  RERANK_POOL_FACTOR: z.coerce.number().int().positive().default(4),

  // Semantic answer cache (speed/cost). A near-identical repeat question in the
  // same visibility tier returns a stored answer with no model call.
  CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CACHE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.95),
  CACHE_TTL_HOURS: z.coerce.number().positive().default(24),

  // Governance: allow private knowledge to reach third-party model/embedding
  // APIs. When false, private requests are refused (self-host to enable).
  PRIVATE_EGRESS_ALLOWED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Ops guardrails.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  DAILY_COST_CAP_USD: z.coerce.number().nonnegative().default(0), // 0 = disabled

  // Registered sources (ADR-0024). Sources themselves are rows created with
  // `ask sources add`, not env. These only tune how the adapters (ADR-0020:
  // public git repositories and websites) index them.
  // Clone cache: repos land in <ASK_WORKDIR>/sources/<sourceId>. `~` expands.
  ASK_WORKDIR: z.string().min(1).default("~/.ask-anything"),
  // Scheduler tick that runs whichever sources are due (empty disables).
  INDEX_CRON: z.string().default("*/15 * * * *"),
  // Per-source cron when the source has none of its own.
  INDEX_DEFAULT_SCHEDULE: z.string().default("0 4 * * *"),
  // Files larger than this (KB) are skipped when indexing a git source.
  INDEX_MAX_FILE_KB: z.coerce.number().int().positive().default(512),
  // Max pages a sitemap crawl expands to.
  INDEX_MAX_PAGES: z.coerce.number().int().positive().default(500),

  // Clients of the REST API: the stdio MCP proxy (@ask/mcp-stdio) and the
  // management CLI (`ask`) reach the hosted API with these.
  ASK_API_URL: z.string().url().default("http://localhost:3000"),
  ASK_API_KEY: z.string().optional(),

  // Jobs
  DECAY_CRON: z.string().default("0 3 * * *"),
  // Re-warm the answer cache for the most-asked questions (default: every 4h).
  WARM_CACHE_CRON: z.string().default("30 */4 * * *"),
  // Retroactively re-ask previously-unanswered questions now the KB has grown
  // (default: daily at 05:00, after the default source index). Empty string
  // disables it.
  BACKFILL_CRON: z.string().default("0 5 * * *"),
  // On the answer path, cited items last verified more than this many hours ago
  // are queued for a targeted re-verify against their source (0 disables).
  REVERIFY_AGE_HOURS: z.coerce.number().nonnegative().default(168),

  // Logdrain
  LOGDRAIN_URL: z.string().url().optional(),
  LOGDRAIN_TOKEN: z.string().optional(),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface ApiKeyEntry {
  key: string;
  label: string;
  scope: "read" | "write" | "admin";
  /** Max visibility this key can request/insert. `private` includes public. */
  visibility: "public" | "private";
}

export interface Env extends RawEnv {
  apiKeys: ApiKeyEntry[];
}

let cached: Env | undefined;

function parseApiKeys(raw: string): ApiKeyEntry[] {
  return csv(raw).map((entry) => {
    const [key, label = "unnamed", scope = "read", visibility = "public"] =
      entry.split(":");
    if (!key) throw new Error(`Invalid API_KEYS entry: "${entry}"`);
    if (scope !== "read" && scope !== "write" && scope !== "admin") {
      throw new Error(`Invalid scope "${scope}" in API_KEYS entry "${entry}"`);
    }
    if (visibility !== "public" && visibility !== "private") {
      throw new Error(
        `Invalid visibility "${visibility}" in API_KEYS entry "${entry}"`,
      );
    }
    return { key, label, scope, visibility };
  });
}

/** Parse + cache process env. Throws with a readable message on misconfig. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  loadEnvFiles(); // apply .env / .env.local before parsing (real env still wins)
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = {
    ...parsed.data,
    apiKeys: parseApiKeys(parsed.data.API_KEYS),
  };
  return cached;
}

/** Test-only: clear the cached env so the next loadEnv() re-parses. */
export function resetEnvCache(): void {
  cached = undefined;
}
