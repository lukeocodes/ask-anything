import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnv, logger } from "@ask/config";
import {
  and,
  db,
  desc,
  eq,
  knowledgeItems,
  knowledgeSources,
  notInArray,
  sql,
  type KnowledgeItem,
  type KnowledgeSource,
  type NewKnowledgeSource,
} from "@ask/db";
import { CronExpressionParser } from "cron-parser";
import { getItem, refreshCanonical } from "./knowledge.js";
import { proposeUpdate } from "./proposals.js";
import {
  SourceBusyError,
  adapterFor,
  detectAdapter,
  type IndexContext,
  type IndexResult,
  type RefreshAction,
  type SourceAdapter,
  type SourcePersistence,
} from "./source-adapter.js";
import { recordUsage } from "./telemetry.js";
import type { IngestInput, Visibility } from "./types.js";

/**
 * Registered sources (ADR-0024). A source is a row in `knowledge_sources`
 * that a registered adapter (ADR-0020, `source-adapter.ts`) indexes on a
 * schedule, on demand, or one record at a time. Records it produces carry
 * `sourceId`, `sourceType` = the adapter kind, `sourceRef`
 * `<sourceId>:<path|url>` and `metadata.origin = "source"` — the source owns
 * them: refreshed in place, never by proposal, pruned when the file vanishes.
 *
 * CRUD, status transitions, scheduling and the `ingest` usage event live
 * here; everything that touches the upstream is the adapter's.
 */

export type SourceKind = KnowledgeSource["kind"];
export type SourceProvider = KnowledgeSource["provider"];
export type SourceCrawl = NonNullable<KnowledgeSource["crawl"]>;

/** `metadata.origin` stamped on every record a registered source produces. */
export const SOURCE_ORIGIN = "source";

/** True when the item is owned by a registered source (see SOURCE_ORIGIN). */
export function isSourceOwned(item: { metadata: Record<string, unknown> | null }): boolean {
  return item.metadata?.origin === SOURCE_ORIGIN;
}

export class SourceError extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

// --- Locators ---------------------------------------------------------------

/** Split any clone/page locator into host + path. Handles scp-like `git@host:path`. */
export function parseLocator(locator: string): { host: string; path: string; scheme: string } {
  const trimmed = locator.trim();
  const scp = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp) return { scheme: "ssh", host: scp[2]!.toLowerCase(), path: scp[3]!.replace(/^\/+/, "") };
  try {
    const u = new URL(trimmed);
    return {
      scheme: u.protocol.replace(/:$/, ""),
      host: u.hostname.toLowerCase(),
      path: decodeURIComponent(u.pathname).replace(/^\/+/, ""),
    };
  } catch {
    throw new SourceError("invalid", `not a clone URL or page URL: ${locator}`);
  }
}

/**
 * Pick the adapter for a locator: an explicit `kind` names it, otherwise the
 * first registered adapter whose `detect` accepts the locator. Throws
 * SourceError("invalid") when nothing claims it.
 */
export function resolveAdapter(locator: string, kind?: string): SourceAdapter {
  if (kind) {
    try {
      return adapterFor(kind);
    } catch (err) {
      throw new SourceError("invalid", (err as Error).message);
    }
  }
  parseLocator(locator); // rejects garbage with a readable message
  const adapter = detectAdapter(locator);
  if (!adapter) throw new SourceError("invalid", `no source adapter accepts ${locator}`);
  return adapter;
}

// --- CRUD -------------------------------------------------------------------

export interface CreateSourceInput {
  locator: string;
  name?: string;
  /** Adapter kind; overrides locator detection. */
  kind?: string;
  visibility?: Visibility;
  branch?: string;
  include?: string[];
  exclude?: string[];
  crawl?: SourceCrawl;
  schedule?: string;
  enabled?: boolean;
  /** Non-secret, adapter-specific config (ctx.config). */
  config?: Record<string, unknown>;
  /** Name of an env var on the API host holding the source's secret (ctx.secret). */
  credentialEnv?: string;
}

export interface UpdateSourceInput {
  name?: string;
  enabled?: boolean;
  schedule?: string | null;
  visibility?: Visibility;
  include?: string[];
  exclude?: string[];
  branch?: string | null;
  crawl?: SourceCrawl;
  config?: Record<string, unknown>;
  credentialEnv?: string | null;
}

/** Throw unless `expr` is a 5/6-field cron expression cron-parser accepts. */
export function assertCron(expr: string): void {
  try {
    CronExpressionParser.parse(expr);
  } catch (err) {
    throw new SourceError("invalid", `invalid cron schedule "${expr}": ${(err as Error).message}`);
  }
}

/** Register a source. The adapter (detected from the locator, or named by `kind`) supplies kind / provider / name. */
export async function createSource(input: CreateSourceInput): Promise<KnowledgeSource> {
  const locator = input.locator.trim();
  const adapter = resolveAdapter(locator, input.kind);
  const info = adapter.describe(locator);
  if (input.schedule) assertCron(input.schedule);

  const [existing] = await db()
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.locator, locator))
    .limit(1);
  if (existing) throw new SourceError("conflict", `source already registered for ${locator} (${existing.id})`);

  const row: NewKnowledgeSource = {
    kind: adapter.kind,
    provider: info.provider,
    locator,
    name: input.name?.trim() || info.name,
    visibility: input.visibility ?? "private",
    branch: input.branch?.trim() || null,
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    crawl: adapter.kind === "url" ? (input.crawl ?? "page") : null,
    schedule: input.schedule?.trim() || null,
    enabled: input.enabled ?? true,
    config: input.config ?? {},
    credentialEnv: input.credentialEnv?.trim() || null,
  };

  try {
    const [created] = await db().insert(knowledgeSources).values(row).returning();
    if (!created) throw new Error("createSource: insert returned no row");
    return created;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new SourceError("conflict", `source already registered for ${locator}`);
    }
    throw err;
  }
}

export async function listSources(): Promise<KnowledgeSource[]> {
  return db().select().from(knowledgeSources).orderBy(desc(knowledgeSources.createdAt));
}

export async function getSource(id: string): Promise<KnowledgeSource | undefined> {
  const [row] = await db().select().from(knowledgeSources).where(eq(knowledgeSources.id, id)).limit(1);
  return row;
}

/** Update the editable fields. A visibility change is pushed to the source's records. */
export async function updateSource(id: string, patch: UpdateSourceInput): Promise<KnowledgeSource | undefined> {
  if (patch.schedule) assertCron(patch.schedule);
  const set: Partial<NewKnowledgeSource> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.schedule !== undefined) set.schedule = patch.schedule || null;
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.include !== undefined) set.include = patch.include;
  if (patch.exclude !== undefined) set.exclude = patch.exclude;
  if (patch.branch !== undefined) set.branch = patch.branch || null;
  if (patch.crawl !== undefined) set.crawl = patch.crawl;
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.credentialEnv !== undefined) set.credentialEnv = patch.credentialEnv || null;

  const [row] = await db().update(knowledgeSources).set(set).where(eq(knowledgeSources.id, id)).returning();
  if (row && patch.visibility !== undefined) {
    await db()
      .update(knowledgeItems)
      .set({ visibility: patch.visibility, updatedAt: new Date() })
      .where(eq(knowledgeItems.sourceId, id));
  }
  return row;
}

/**
 * Delete a source. `purge` also deletes its records (chunks + revisions
 * cascade); otherwise they are detached — `sourceId` nulled and
 * `metadata.origin` / `metadata.sourceId` dropped, so they stop being
 * source-owned (no adapter will refresh or prune them) and decay normally.
 */
export async function deleteSource(
  id: string,
  opts: { purge?: boolean } = {},
): Promise<{ deleted: boolean; purged: number }> {
  let purged = 0;
  if (opts.purge) {
    const rows = await db()
      .delete(knowledgeItems)
      .where(eq(knowledgeItems.sourceId, id))
      .returning({ id: knowledgeItems.id });
    purged = rows.length;
  } else {
    await db()
      .update(knowledgeItems)
      .set({
        sourceId: null,
        metadata: sql`coalesce(${knowledgeItems.metadata}, '{}'::jsonb) - 'origin' - 'sourceId'`,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeItems.sourceId, id));
  }
  const rows = await db().delete(knowledgeSources).where(eq(knowledgeSources.id, id)).returning({ id: knowledgeSources.id });
  return { deleted: rows.length > 0, purged };
}

/**
 * Delete this source's records whose sourceRef is not in `keepRefs` — the
 * files that vanished upstream since the last index. Only source-owned rows
 * (`metadata.origin = "source"`) qualify. A no-op when keepRefs is empty: an
 * index that saw nothing never wipes a source.
 */
export async function pruneSourceItems(sourceId: string, keepRefs: string[]): Promise<number> {
  if (keepRefs.length === 0) return 0;
  const log = logger("sources");
  const rows = await db()
    .delete(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.sourceId, sourceId),
        sql`${knowledgeItems.metadata} ->> 'origin' = ${SOURCE_ORIGIN}`,
        notInArray(knowledgeItems.sourceRef, keepRefs),
      ),
    )
    .returning({ id: knowledgeItems.id, sourceRef: knowledgeItems.sourceRef });
  for (const r of rows) {
    log.info({ itemId: r.id, sourceRef: r.sourceRef, sourceId, reason: "vanished_upstream" }, "pruned source item");
  }
  return rows.length;
}

/** Delete one source-owned record (its backing file / page is gone). */
export async function removeSourceItem(itemId: string): Promise<boolean> {
  const rows = await db().delete(knowledgeItems).where(eq(knowledgeItems.id, itemId)).returning({ id: knowledgeItems.id });
  return rows.length > 0;
}

/** The DB-backed persistence seam handed to adapters. */
export const dbPersistence: SourcePersistence = {
  refresh: (input) => refreshCanonical(input).then((r) => ({ created: r.created, changed: r.changed })),
  prune: pruneSourceItems,
  remove: async (itemId) => {
    await removeSourceItem(itemId);
  },
  registerSource: createSource,
};

/** Number of records currently attached to a source. */
export async function countSourceItems(sourceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.sourceId, sourceId));
  return Number(row?.n ?? 0);
}

// --- Status -----------------------------------------------------------------

export async function markIndexing(id: string): Promise<void> {
  await db()
    .update(knowledgeSources)
    .set({ status: "indexing", lastError: null, updatedAt: new Date() })
    .where(eq(knowledgeSources.id, id));
}

export async function markIdle(
  id: string,
  result: { lastCommit?: string | null; itemCount?: number; lastIndexedAt?: Date } = {},
): Promise<void> {
  const set: Partial<NewKnowledgeSource> = {
    status: "idle",
    lastError: null,
    lastIndexedAt: result.lastIndexedAt ?? new Date(),
    updatedAt: new Date(),
  };
  if (result.lastCommit !== undefined) set.lastCommit = result.lastCommit;
  if (result.itemCount !== undefined) set.itemCount = result.itemCount;
  await db().update(knowledgeSources).set(set).where(eq(knowledgeSources.id, id));
}

export async function markError(id: string, message: string): Promise<void> {
  await db()
    .update(knowledgeSources)
    .set({ status: "error", lastError: message.slice(0, 2000), updatedAt: new Date() })
    .where(eq(knowledgeSources.id, id));
}

// --- Scheduling -------------------------------------------------------------

/**
 * Due when the schedule's most recent fire time (at or before `now`) is later
 * than the last index, or the source has never been indexed. `tz` defaults to
 * the machine's timezone, matching the node-cron tick.
 */
export function isDue(schedule: string, lastIndexedAt: Date | null, now: Date, tz?: string): boolean {
  if (!lastIndexedAt) return true;
  const expr = CronExpressionParser.parse(schedule, { currentDate: now, ...(tz ? { tz } : {}) });
  const prev = expr.prev().toDate();
  return prev.getTime() > lastIndexedAt.getTime();
}

/** Enabled sources whose schedule (or INDEX_DEFAULT_SCHEDULE) has fired since their last index. */
export async function dueSources(now: Date = new Date()): Promise<KnowledgeSource[]> {
  const fallback = loadEnv().INDEX_DEFAULT_SCHEDULE;
  const log = logger("sources");
  const rows = await db().select().from(knowledgeSources).where(eq(knowledgeSources.enabled, true));
  return rows.filter((s) => {
    const schedule = s.schedule || fallback;
    try {
      return isDue(schedule, s.lastIndexedAt, now);
    } catch (err) {
      log.warn({ err, sourceId: s.id, schedule }, "invalid source schedule; skipped");
      return false;
    }
  });
}

// --- Records ----------------------------------------------------------------

export interface SourceItemSpec {
  /** Repo-relative path (git) or page URL (url). */
  ref: string;
  title: string;
  body: string;
  format: "markdown" | "text";
  commit?: string | null;
  /** Browsable URL for citations (git: blob URL when known; url: the page). */
  url?: string;
}

/**
 * The IngestInput for one record a source produces. Shared by the full index
 * and the single-record refresh so both write byte-identical rows and the
 * content-hash gate reports `unchanged` honestly.
 */
export function sourceItemInput(source: KnowledgeSource, spec: SourceItemSpec): IngestInput & { sourceRef: string } {
  const isGit = source.kind === "git";
  return {
    sourceType: source.kind,
    sourceRef: `${source.id}:${spec.ref}`,
    sourceId: source.id,
    visibility: source.visibility,
    title: spec.title,
    body: spec.body,
    format: spec.format,
    enrich: false,
    createdBy: "system",
    tags: [source.kind, source.name],
    metadata: {
      origin: SOURCE_ORIGIN,
      sourceId: source.id,
      ...(isGit ? { path: spec.ref } : { url: spec.ref }),
      ...(spec.commit ? { commit: spec.commit } : {}),
      ...(spec.url ? { url: spec.url } : {}),
      format: spec.format,
    },
  };
}

/** Format by file extension: markdown for .md/.mdx/.markdown, else text. */
export function formatForPath(path: string): "markdown" | "text" {
  return /\.(md|mdx|markdown)$/i.test(path) ? "markdown" : "text";
}

// --- Indexing ---------------------------------------------------------------

/** ASK_WORKDIR with `~` expanded, as an absolute path. */
export function workdirRoot(override?: string): string {
  const raw = override ?? loadEnv().ASK_WORKDIR;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/**
 * The context an adapter runs with: the source, the DB seam, a logger, the
 * source's config, its secret (resolved from `process.env[credentialEnv]`
 * here and nowhere else — never persisted or logged), and the INDEX_* env.
 */
export function adapterContext(source: KnowledgeSource, overrides: Partial<IndexContext> = {}): IndexContext {
  const env = loadEnv();
  return {
    source,
    persistence: dbPersistence,
    log: logger(`source:${source.kind}`),
    config: source.config ?? {},
    secret: source.credentialEnv ? process.env[source.credentialEnv] : undefined,
    env: {
      workdir: workdirRoot(),
      maxFileKb: env.INDEX_MAX_FILE_KB,
      maxPages: env.INDEX_MAX_PAGES,
    },
    ...overrides,
  };
}

export interface IndexSourceOptions {
  force?: boolean;
  /** Replace parts of the adapter context (tests). */
  context?: Partial<IndexContext>;
}

export interface IndexRunResult extends IndexResult {
  sourceId: string;
  kind: string;
  forced: boolean;
}

/**
 * Index one source through its adapter: mark it `indexing`, run the adapter,
 * record the counters as a usage event, and leave it `idle` (with the new
 * commit / item count) or `error` (with the message). Throws
 * SourceError("not_found") for an unknown id and SourceBusyError when a run
 * is already in flight.
 */
export async function indexSource(id: string, opts: IndexSourceOptions = {}): Promise<IndexRunResult> {
  const source = await getSource(id);
  if (!source) throw new SourceError("not_found", `source ${id} not found`);
  return indexLoadedSource(source, opts);
}

async function indexLoadedSource(source: KnowledgeSource, opts: IndexSourceOptions): Promise<IndexRunResult> {
  if (source.status === "indexing") throw new SourceBusyError(source.id);
  const force = opts.force ?? false;
  const adapter = adapterFor(source.kind);
  const ctx = adapterContext(source, opts.context);

  await markIndexing(source.id);
  try {
    const r = await adapter.index(ctx, { force });
    const result: IndexRunResult = {
      skipped: r.skipped ?? false,
      created: r.created,
      changed: r.changed,
      unchanged: r.unchanged,
      pruned: r.pruned,
      seen: r.seen ?? r.created + r.changed + r.unchanged,
      failed: r.failed ?? 0,
      lastCommit: r.lastCommit ?? null,
      sourceId: source.id,
      kind: source.kind,
      forced: force,
    };
    await markIdle(source.id, {
      lastCommit: result.lastCommit,
      ...(result.skipped ? {} : { itemCount: result.seen }),
    });
    await recordUsage({
      kind: "ingest",
      metadata: {
        sourceId: source.id,
        kind: source.kind,
        skipped: result.skipped,
        created: result.created,
        changed: result.changed,
        unchanged: result.unchanged,
        pruned: result.pruned,
        failed: result.failed,
        forced: force,
      },
    });
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await markError(source.id, message).catch(() => {});
    throw err;
  }
}

export interface IndexRunSummary {
  ran: number;
  results: IndexRunResult[];
  errors: { sourceId: string; error: string }[];
}

async function runMany(sources: KnowledgeSource[], opts: IndexSourceOptions): Promise<IndexRunSummary> {
  const log = logger("sources");
  const summary: IndexRunSummary = { ran: 0, results: [], errors: [] };
  for (const source of sources) {
    if (source.status === "indexing") {
      log.info({ sourceId: source.id }, "source already indexing; skipped");
      continue;
    }
    summary.ran += 1;
    try {
      summary.results.push(await indexLoadedSource(source, opts));
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      summary.errors.push({ sourceId: source.id, error });
      log.error({ sourceId: source.id, err: error }, "source index failed");
    }
  }
  return summary;
}

/** The scheduler tick: index every enabled source whose schedule has fired. */
export async function indexDueSources(now: Date = new Date(), opts: IndexSourceOptions = {}): Promise<IndexRunSummary> {
  const due = await dueSources(now);
  if (due.length === 0) return { ran: 0, results: [], errors: [] };
  logger("sources").info({ count: due.length }, "sources due");
  return runMany(due, opts);
}

/** Index every enabled source now, ignoring schedules. */
export async function indexAllSources(opts: IndexSourceOptions = {}): Promise<IndexRunSummary> {
  const all = (await listSources()).filter((s) => s.enabled);
  return runMany(all, opts);
}

/** The registered source that owns an item (column first, then `metadata.sourceId`). */
export async function sourceForItem(item: KnowledgeItem): Promise<KnowledgeSource | undefined> {
  const id = item.sourceId ?? (item.metadata as { sourceId?: string } | null)?.sourceId;
  return id ? getSource(id) : undefined;
}

/**
 * Re-read ONE source-owned record through its adapter and run the same
 * content-hash gate the full index would. Throws SourceError("not_found")
 * when the owning source is gone.
 */
export async function refreshItem(item: KnowledgeItem, context: Partial<IndexContext> = {}): Promise<RefreshAction> {
  const source = await sourceForItem(item);
  if (!source) throw new SourceError("not_found", `source for item ${item.id} not found`);
  const adapter = adapterFor(source.kind);
  return adapter.refresh(item, adapterContext(source, context));
}

export interface ReverifyResult {
  id: string;
  /**
   *  - refreshed | unchanged | removed → upstream-trust adapter re-read it in place
   *  - proposed  → review-trust adapter saw a change; a proposal was created
   *  - verified  → review-trust adapter saw no change
   *  - skipped   → not source-owned / no source / no adapter (nothing checked it, so nothing stamps it)
   *  - failed    → the adapter threw (logged)
   */
  action: RefreshAction | "proposed" | "verified" | "skipped" | "failed";
}

/**
 * Targeted re-verify of specific items (the answer path fires this for cited
 * items older than REVERIFY_AGE_HOURS). Each source-owned item goes through
 * its adapter: `upstream` trust refreshes in place, `review` trust verifies
 * and proposes. Items with no source or adapter are left alone (ADR-0021).
 * Best-effort — never throws; the per-item outcome is returned for callers
 * that report it. Ids that match no item are omitted.
 */
export async function reverifyItems(itemIds: string[]): Promise<ReverifyResult[]> {
  const log = logger("reverify");
  const results: ReverifyResult[] = [];
  for (const id of itemIds) {
    const item = await getItem(id).catch(() => undefined);
    if (!item) continue;
    if (!isSourceOwned(item)) {
      results.push({ id, action: "skipped" });
      continue;
    }
    try {
      const source = await sourceForItem(item);
      if (!source) {
        log.debug({ itemId: id }, "reverify skipped: owning source not found");
        results.push({ id, action: "skipped" });
        continue;
      }
      const adapter = adapterFor(source.kind);
      const ctx = adapterContext(source);
      if (adapter.trust === "review" && adapter.verify) {
        const candidate = await adapter.verify(item, ctx);
        if (candidate) {
          await proposeUpdate(item.id, item.sourceType, candidate);
          results.push({ id, action: "proposed" });
        } else {
          results.push({ id, action: "verified" });
        }
        continue;
      }
      results.push({ id, action: await adapter.refresh(item, ctx) });
    } catch (err) {
      log.warn({ err, itemId: id }, "reverify item failed");
      results.push({ id, action: "failed" });
    }
  }
  return results;
}
