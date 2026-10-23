import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ApiClient } from "../api.js";
import { renderers } from "../render.js";

/**
 * The command registry — the single source of truth for what the CLI can do.
 * The argv parser (src/index.ts) is generated from it, and so is every tool on
 * the management MCP server (apps/mgmt-mcp). One entry per REST endpoint.
 */

export type Surface = "cli" | "mcp";

export interface CommandContext {
  apiUrl: string;
  apiKey: string;
  surface: Surface;
  /** Sink for streaming commands' incremental output (defaults to stdout). */
  write?: (text: string) => void;
}

export type ArgsSchema = z.ZodObject<z.ZodRawShape>;

export interface Command<S extends ArgsSchema = ArgsSchema> {
  /** Space-separated words, e.g. "proposals approve". */
  name: string;
  description: string;
  /** Positionals + flags. Keys listed in `positionals` are positional, in order. */
  args: S;
  positionals?: readonly string[];
  /** Streams to `ctx.write` while running. Skipped by the management MCP. */
  streaming?: boolean;
  /** A valid invocation, used by tests and `--help`. */
  example: z.input<S>;
  run(args: z.output<S>, ctx: CommandContext): Promise<unknown>;
  /** Compact human rendering of `run`'s result. Falls back to JSON. */
  render?: (data: unknown) => string;
}

function define<S extends ArgsSchema>(cmd: Command<S>): Command {
  return cmd as unknown as Command;
}

const client = (ctx: CommandContext): ApiClient =>
  new ApiClient({ apiUrl: ctx.apiUrl, apiKey: ctx.apiKey });

const visibility = z.enum(["public", "private"]);

const askArgs = z.object({
  question: z.string().min(1).max(4000).describe("The question to answer."),
  visibility: visibility.optional().describe("Requested visibility (capped to the key's tier)."),
  context: z.string().optional().describe("Prior conversation or extra context."),
  limit: z.number().int().positive().max(20).optional().describe("Max grounding sources."),
});

const askBody = (a: z.output<typeof askArgs>, ctx: CommandContext) => ({
  question: a.question,
  surface: ctx.surface,
  visibility: a.visibility,
  context: a.context,
  limit: a.limit,
});

const sourceId = z.string().min(1).describe("Source id (from `sources list`).");
const sourceFlags = {
  name: z.string().optional().describe("Display name (defaults to owner/repo or host/path)."),
  visibility: visibility.optional().describe("Visibility of every record the source produces."),
  branch: z.string().optional().describe("git: branch to clone (default: the remote HEAD)."),
  include: z.array(z.string()).optional().describe("git: keep only paths matching these globs (comma-separated)."),
  exclude: z.array(z.string()).optional().describe("git: drop paths matching these globs (comma-separated)."),
  crawl: z.enum(["page", "sitemap"]).optional().describe("url: index the one page, or expand its sitemap."),
  schedule: z.string().optional().describe("Per-source cron (default: INDEX_DEFAULT_SCHEDULE)."),
  config: z.record(z.unknown()).optional().describe("Non-secret adapter config (JSON object on the CLI)."),
  credentialEnv: z
    .string()
    .optional()
    .describe("Name of an env var on the API host holding the source's secret. The value is never stored."),
};
const SOURCE_EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";

const knowledgeAddArgs = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  body: z.string().optional().describe("The knowledge text."),
  file: z.string().optional().describe("Read the body from this file instead of --body."),
  visibility: visibility.optional(),
  sourceType: z.enum(["api", "manual"]).optional().describe("git / url are reserved for registered sources."),
  sourceRef: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Comma-separated on the CLI."),
  metadata: z.record(z.unknown()).optional().describe("JSON object on the CLI."),
});

export const commands: readonly Command[] = [
  define({
    name: "ask",
    description: "Ask a question and get a grounded, cited answer (POST /v1/ask).",
    args: askArgs,
    positionals: ["question"],
    example: { question: "How do I authenticate?", visibility: "public" },
    run: (a, ctx) => client(ctx).post("/v1/ask", askBody(a, ctx)),
    render: renderers.ask,
  }),

  define({
    name: "ask stream",
    description: "Ask a question and stream the answer as it is produced (POST /v1/ask/stream).",
    args: askArgs,
    positionals: ["question"],
    streaming: true,
    example: { question: "How do I authenticate?" },
    async run(a, ctx) {
      const write = ctx.write ?? ((t: string) => process.stdout.write(t));
      let result: unknown;
      for await (const ev of client(ctx).sse("POST", "/v1/ask/stream", { body: askBody(a, ctx) })) {
        if (ev.event === "delta") write((JSON.parse(ev.data) as { text: string }).text);
        else if (ev.event === "done") result = JSON.parse(ev.data);
        else if (ev.event === "error") throw new Error((JSON.parse(ev.data) as { error: string }).error);
      }
      write("\n");
      return result;
    },
    render: renderers.askStreamTail,
  }),

  define({
    name: "search",
    description: "Retrieval-only search, no synthesis (POST /v1/search).",
    args: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(20).optional(),
      visibility: visibility.optional(),
    }),
    positionals: ["query"],
    example: { query: "rate limits", limit: 5 },
    run: (a, ctx) => client(ctx).post("/v1/search", a),
    render: renderers.search,
  }),

  define({
    name: "knowledge add",
    description: "Add a knowledge item from text or a file (POST /v1/knowledge).",
    args: knowledgeAddArgs,
    example: { body: "The API rate limit is 100 rps.", title: "Rate limits", tags: ["api"] },
    async run(a, ctx) {
      const sources = [a.body, a.file].filter((v) => v !== undefined).length;
      if (sources !== 1) throw new Error("knowledge add needs exactly one of --body or --file");
      const body = a.file !== undefined ? await readFile(a.file, "utf8") : a.body!;
      return client(ctx).post("/v1/knowledge", {
        body,
        title: a.title,
        summary: a.summary,
        sourceType: a.sourceType,
        sourceRef: a.sourceRef,
        tags: a.tags,
        metadata: a.metadata,
        visibility: a.visibility,
      });
    },
    render: renderers.knowledgeAdd,
  }),

  define({
    name: "knowledge get",
    description: "Fetch one knowledge item by id (GET /v1/knowledge/:id).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).get(`/v1/knowledge/${encodeURIComponent(a.id)}`),
  }),

  define({
    name: "knowledge reviews",
    description: "Knowledge awaiting a public/private decision (GET /v1/knowledge/reviews).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/knowledge/reviews"),
    render: renderers.knowledgeReviews,
  }),

  define({
    name: "knowledge visibility",
    description: "Set an item's visibility, clearing any pending review (POST /v1/knowledge/:id/visibility).",
    args: z.object({ id: z.string().min(1), visibility }),
    positionals: ["id", "visibility"],
    example: { id: "00000000-0000-0000-0000-000000000000", visibility: "public" },
    run: (a, ctx) =>
      client(ctx).post(`/v1/knowledge/${encodeURIComponent(a.id)}/visibility`, {
        visibility: a.visibility,
      }),
  }),

  define({
    name: "knowledge gaps",
    description: "Questions the engine repeatedly cannot answer (GET /v1/knowledge/gaps).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/knowledge/gaps"),
    render: renderers.knowledgeGaps,
  }),

  define({
    name: "knowledge refresh",
    description:
      "Re-read one source-owned item from its registered source now (POST /v1/knowledge/:id/refresh): refreshed | unchanged | removed. Items not owned by a source are refused (409 not_source_owned).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).post(`/v1/knowledge/${encodeURIComponent(a.id)}/refresh`),
  }),

  define({
    name: "knowledge chunks",
    description: "A knowledge item's chunk tree: parent, depth, heading path, position per chunk (GET /v1/knowledge/:id/chunks).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).get(`/v1/knowledge/${encodeURIComponent(a.id)}/chunks`),
  }),

  define({
    name: "chunks context",
    description: "One chunk with its parent, siblings, and children (GET /v1/chunks/:id/context).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).get(`/v1/chunks/${encodeURIComponent(a.id)}/context`),
  }),

  define({
    name: "proposals list",
    description: "Pending knowledge-update proposals awaiting approval (GET /v1/proposals).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/proposals"),
    render: renderers.proposalsList,
  }),

  define({
    name: "proposals create",
    description:
      "Propose a change to a knowledge item for an operator to approve (POST /v1/knowledge/:id/proposals). Needs at least one of --title, --summary, --body or --file. Returns the already-pending proposal if the item has one.",
    args: z.object({
      id: z.string().min(1).describe("Knowledge item id."),
      title: z.string().optional().describe("Proposed title."),
      summary: z.string().optional().describe("Proposed summary."),
      body: z.string().optional().describe("Proposed body text."),
      file: z.string().optional().describe("Read the proposed body from this file instead of --body."),
      diff: z.record(z.unknown()).optional().describe("Machine-readable diff (JSON object on the CLI)."),
      evidence: z.array(z.string()).optional().describe("URLs backing the change (comma-separated on the CLI)."),
      note: z.string().optional().describe("Why the change is right, in words."),
    }),
    positionals: ["id"],
    example: {
      id: "00000000-0000-0000-0000-000000000000",
      body: "The rate limit is now 200 rps.",
      evidence: ["https://example.com/changelog"],
      note: "Raised in the March release.",
    },
    async run(a, ctx) {
      if (a.body !== undefined && a.file !== undefined) {
        throw new Error("proposals create takes --body or --file, not both");
      }
      const body = a.file !== undefined ? await readFile(a.file, "utf8") : a.body;
      const evidence = [
        ...(a.evidence ?? []).map((url) => ({ url })),
        ...(a.note !== undefined ? [{ note: a.note }] : []),
      ];
      return client(ctx).post(`/v1/knowledge/${encodeURIComponent(a.id)}/proposals`, {
        proposedTitle: a.title,
        proposedSummary: a.summary,
        proposedBody: body,
        diff: a.diff,
        evidence,
      });
    },
    render: renderers.proposalCreate,
  }),

  define({
    name: "proposals approve",
    description: "Approve a proposal (POST /v1/proposals/:id/approve).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).post(`/v1/proposals/${encodeURIComponent(a.id)}/approve`),
  }),

  define({
    name: "proposals reject",
    description: "Reject a proposal (POST /v1/proposals/:id/reject).",
    args: z.object({ id: z.string().min(1) }),
    positionals: ["id"],
    example: { id: "00000000-0000-0000-0000-000000000000" },
    run: (a, ctx) => client(ctx).post(`/v1/proposals/${encodeURIComponent(a.id)}/reject`),
  }),

  define({
    name: "feedback",
    description:
      "Rate an answer up or down, optionally with a comment (POST /v1/answers/:id/feedback[/comment]).",
    args: z.object({
      answerId: z.string().min(1),
      rating: z.enum(["up", "down"]),
      comment: z.string().optional(),
    }),
    positionals: ["answerId", "rating"],
    example: { answerId: "00000000-0000-0000-0000-000000000000", rating: "down", comment: "Wrong SDK." },
    async run(a, ctx) {
      const api = client(ctx);
      const id = encodeURIComponent(a.answerId);
      const feedback = await api.post(`/v1/answers/${id}/feedback`, {
        rating: a.rating,
        surface: ctx.surface,
      });
      const comment = a.comment
        ? await api.post(`/v1/answers/${id}/feedback/comment`, { comment: a.comment, surface: ctx.surface })
        : undefined;
      return { feedback, comment };
    },
  }),

  define({
    name: "questions top",
    description: "Most-asked question clusters (GET /v1/questions/top).",
    args: z.object({
      limit: z.number().int().positive().optional().describe("Client-side cap; the endpoint takes none."),
    }),
    example: { limit: 10 },
    async run(a, ctx) {
      const r = await client(ctx).get<{ questions: unknown[] }>("/v1/questions/top");
      return a.limit ? { questions: r.questions.slice(0, a.limit) } : r;
    },
    render: renderers.questionsTop,
  }),

  define({
    name: "stats",
    description: "Rolling 24h operational stats: latency, cache hit rate, cost (GET /v1/admin/stats).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/admin/stats"),
    render: renderers.keyValues,
  }),

  define({
    name: "stats knowledge",
    description: "Knowledge-base health: counts, stale items, age per source (GET /v1/admin/knowledge-stats).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/admin/knowledge-stats"),
    render: renderers.keyValues,
  }),

  define({
    name: "jobs run",
    description: "Trigger a background job now (POST /v1/admin/run-<job>): decay or backfill.",
    args: z.object({
      job: z.enum(["decay", "backfill"]),
    }),
    positionals: ["job"],
    example: { job: "decay" },
    run: (a, ctx) => client(ctx).post(`/v1/admin/run-${a.job}`),
  }),

  define({
    name: "sources add",
    description:
      "Register a git repo or a URL as a source (POST /v1/sources). Kind and provider are detected from the locator; --kind overrides.",
    args: z.object({
      locator: z.string().min(1).describe("Public clone URL (https / ssh / git@) or page URL."),
      kind: z.string().optional().describe("Adapter kind (see `sources adapters`); overrides detection."),
      ...sourceFlags,
    }),
    positionals: ["locator"],
    example: { locator: "https://github.com/acme/sdk", visibility: "public", include: ["docs/**", "*.md"] },
    run: (a, ctx) => client(ctx).post("/v1/sources", a),
    render: renderers.keyValues,
  }),

  define({
    name: "sources adapters",
    description: "The source adapters this deployment can index with: kind, provider hints (GET /v1/sources/adapters).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/sources/adapters"),
    render: renderers.keyValues,
  }),

  define({
    name: "sources list",
    description: "Registered sources with status, item count and last index time (GET /v1/sources).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/v1/sources"),
    render: renderers.sourcesList,
  }),

  define({
    name: "sources get",
    description: "One registered source (GET /v1/sources/:id).",
    args: z.object({ id: sourceId }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID },
    run: (a, ctx) => client(ctx).get(`/v1/sources/${encodeURIComponent(a.id)}`),
    render: renderers.keyValues,
  }),

  define({
    name: "sources update",
    description:
      "Change a source's name, visibility, branch, globs, crawl mode, schedule, config or credential env (PATCH /v1/sources/:id).",
    args: z.object({ id: sourceId, ...sourceFlags }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID, schedule: "0 6 * * *" },
    run: (a, ctx) => {
      const { id, ...patch } = a;
      return client(ctx).request("PATCH", `/v1/sources/${encodeURIComponent(id)}`, { body: patch });
    },
    render: renderers.keyValues,
  }),

  define({
    name: "sources remove",
    description:
      "Delete a source (DELETE /v1/sources/:id). --purge also deletes its records; without it they stay, detached, and decay.",
    args: z.object({
      id: sourceId,
      purge: z.boolean().optional().describe("Also delete every record the source produced."),
    }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID, purge: true },
    run: (a, ctx) =>
      client(ctx).request("DELETE", `/v1/sources/${encodeURIComponent(a.id)}`, {
        query: { purge: a.purge ? "true" : undefined },
      }),
    render: renderers.keyValues,
  }),

  define({
    name: "sources enable",
    description: "Put a source back on the schedule (PATCH /v1/sources/:id enabled=true).",
    args: z.object({ id: sourceId }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID },
    run: (a, ctx) => client(ctx).request("PATCH", `/v1/sources/${encodeURIComponent(a.id)}`, { body: { enabled: true } }),
    render: renderers.keyValues,
  }),

  define({
    name: "sources disable",
    description: "Take a source off the schedule without deleting anything (PATCH /v1/sources/:id enabled=false).",
    args: z.object({ id: sourceId }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID },
    run: (a, ctx) => client(ctx).request("PATCH", `/v1/sources/${encodeURIComponent(a.id)}`, { body: { enabled: false } }),
    render: renderers.keyValues,
  }),

  define({
    name: "sources index",
    description:
      "Index one source now and report the counters (POST /v1/sources/:id/index). --force ignores the commit and content-hash gates.",
    args: z.object({
      id: sourceId,
      force: z.boolean().optional().describe("Re-ingest every file even when nothing changed."),
    }),
    positionals: ["id"],
    example: { id: SOURCE_EXAMPLE_ID, force: false },
    run: (a, ctx) => client(ctx).post(`/v1/sources/${encodeURIComponent(a.id)}/index`, { force: a.force }),
    render: renderers.keyValues,
  }),

  define({
    name: "sources index-all",
    description: "Index every enabled source now, ignoring schedules (POST /v1/sources/index-all).",
    args: z.object({ force: z.boolean().optional() }),
    example: { force: false },
    run: (a, ctx) => client(ctx).post("/v1/sources/index-all", { force: a.force }),
    render: renderers.keyValues,
  }),

  define({
    name: "cache invalidate",
    description: "Flush the semantic answer cache (POST /v1/admin/invalidate-cache).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).post("/v1/admin/invalidate-cache"),
  }),

  define({
    name: "events tail",
    description: "Follow the domain event stream, one JSON line per event (GET /v1/events).",
    args: z.object({
      since: z.number().int().nonnegative().optional().describe("Replay events after this seq first."),
    }),
    streaming: true,
    example: { since: 0 },
    async run(a, ctx) {
      const write = ctx.write ?? ((t: string) => process.stdout.write(t));
      for await (const ev of client(ctx).sse("GET", "/v1/events", { query: { since: a.since } })) {
        write(ev.data.replace(/\s*$/, "") + "\n");
      }
      return undefined;
    },
  }),

  define({
    name: "health",
    description: "Service liveness (GET /health).",
    args: z.object({}),
    example: {},
    run: (_a, ctx) => client(ctx).get("/health"),
    render: renderers.keyValues,
  }),
];

/** Look up a command by its exact name. */
export function getCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

/**
 * Match the leading argv words to the longest command name. Returns the command
 * and the tokens that follow it. The binary is itself `ask`, so when no
 * registered name matches, argv is read as if `ask` were prepended: `ask "q"`
 * is the `ask` command and `ask stream "q"` is `ask stream`. Empty argv
 * resolves to nothing (the caller prints help).
 */
export function resolveCommand(argv: readonly string[]): { command: Command; rest: string[] } | undefined {
  const sorted = [...commands].sort((a, b) => b.name.split(" ").length - a.name.split(" ").length);
  const match = (tokens: readonly string[]) => {
    for (const command of sorted) {
      const words = command.name.split(" ");
      if (words.every((w, i) => tokens[i] === w)) return { command, rest: tokens.slice(words.length) };
    }
    return undefined;
  };
  if (argv.length === 0) return undefined;
  return match(argv) ?? match(["ask", ...argv]);
}
