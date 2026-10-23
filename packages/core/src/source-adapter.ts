import type { Logger } from "@ask/config";
import type { KnowledgeItem, KnowledgeSource } from "@ask/db";
import type { CreateSourceInput } from "./sources.js";
import type { IngestInput } from "./types.js";

/**
 * The source adapter contract (ADR-0020). Source types are abstract: core knows
 * only this interface and a registry. The engine ships two adapters —
 * public git repository crawling and website crawling — in `@ask/sources`.
 * Core never imports an adapter; the API registers them at startup.
 *
 * There is no trust level and no verify hook: an adapter is trusted by being
 * registered and its records refresh in place (ADR-0010). Anything that needs
 * a human before it lands proposes through the API instead.
 */

export interface AdapterDescription {
  /** Stored in `knowledge_sources.provider` (github | gitlab | git | web | …). */
  provider: string;
  /** Human name derived from the locator: `owner/repo` or `host/path`. */
  name: string;
}

/**
 * The persistence seam. Adapters only ever call these, so a test can point
 * them at an in-memory store and exercise listing, globbing, and change
 * detection with no database.
 */
export interface SourcePersistence {
  refresh(input: IngestInput & { sourceRef: string }): Promise<{ created: boolean; changed: boolean }>;
  prune(sourceId: string, keepRefs: string[]): Promise<number>;
  remove(itemId: string): Promise<void>;
  /**
   * Register a child source (an org enumerator registering each repo it
   * finds, say). Optional: the memory seam used in tests may omit it.
   */
  registerSource?(input: CreateSourceInput): Promise<KnowledgeSource>;
}

export interface IndexContext {
  source: KnowledgeSource;
  persistence: SourcePersistence;
  log: Logger;
  /** Per-source, non-secret adapter config (`knowledge_sources.config`). Shipped adapters ignore it. */
  config: Record<string, unknown>;
  /**
   * The source's secret, read from `process.env[source.credentialEnv]` when the
   * context is built. Never stored, never logged, never returned by the API.
   */
  secret?: string;
  env: {
    /** ASK_WORKDIR, `~` expanded, absolute. Adapters keep clone caches under it. */
    workdir: string;
    /** INDEX_MAX_FILE_KB. */
    maxFileKb: number;
    /** INDEX_MAX_PAGES. */
    maxPages: number;
  };
}

/** Counters one index run reports. */
export interface IndexResult {
  /** True when the commit / content gate said nothing changed and nothing was read. */
  skipped?: boolean;
  created: number;
  changed: number;
  unchanged: number;
  pruned: number;
  /** Records seen this run (becomes the source's item count). */
  seen?: number;
  /** Records whose ingest threw (logged; the run continues). */
  failed?: number;
  /** git: HEAD sha. url: content hash of the page / sitemap. Stored as `lastCommit`. */
  lastCommit?: string | null;
}

export type RefreshAction = "refreshed" | "unchanged" | "removed";

export interface SourceAdapter {
  /** `knowledge_sources.kind` and `knowledge_items.source_type`: "git" | "url" | future adapters. */
  readonly kind: string;
  /** Provider values `describe` can return (github | gitlab | …) — a hint for `GET /v1/sources/adapters`. */
  readonly providers?: string[];
  /** True when this adapter can index the locator. First match in registration order wins. */
  detect(locator: string): boolean;
  describe(locator: string): AdapterDescription;
  /** Full index: clone / fetch, push every record through the content-hash gate, prune what vanished. */
  index(ctx: IndexContext, opts: { force: boolean }): Promise<IndexResult>;
  /** Re-read ONE source-owned record. `removed` when it is gone upstream (the record is deleted). */
  refresh(item: KnowledgeItem, ctx: IndexContext): Promise<RefreshAction>;
}

/** Raised when the upstream (remote, host, page) cannot be reached or read. */
export class UpstreamFetchError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    detail?: string,
  ) {
    super(`upstream ${status} fetching ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "UpstreamFetchError";
  }
}

/** Raised when a source is already `indexing`. */
export class SourceBusyError extends Error {
  constructor(readonly sourceId: string) {
    super(`source ${sourceId} is already indexing`);
    this.name = "SourceBusyError";
  }
}

// --- Registry ---------------------------------------------------------------

const registry = new Map<string, SourceAdapter>();

/**
 * Register (or replace) the adapter for its kind. Registration order is the
 * `detectAdapter` order — first `detect` to accept a locator wins — so a more
 * specific adapter registers ahead of a broad one with `{ before: "git" }`.
 * Replacing a kind keeps its position unless `before` moves it; `before`
 * naming an unregistered kind appends.
 */
export function registerAdapter(adapter: SourceAdapter, opts: { before?: string } = {}): void {
  const before = opts.before;
  if (!before || before === adapter.kind || !registry.has(before)) {
    // New kind → appended; existing kind → replaced in place.
    registry.set(adapter.kind, adapter);
    return;
  }
  const entries = [...registry.entries()].filter(([kind]) => kind !== adapter.kind);
  registry.clear();
  for (const [kind, existing] of entries) {
    if (kind === before) registry.set(adapter.kind, adapter);
    registry.set(kind, existing);
  }
}

/** The adapter for a kind. Throws when nothing is registered for it. */
export function adapterFor(kind: string): SourceAdapter {
  const adapter = registry.get(kind);
  if (!adapter) {
    const known = [...registry.keys()].join(", ") || "none";
    throw new Error(`no source adapter registered for kind "${kind}" (registered: ${known})`);
  }
  return adapter;
}

/** The first registered adapter whose `detect` accepts the locator, or null. */
export function detectAdapter(locator: string): SourceAdapter | null {
  for (const adapter of registry.values()) if (adapter.detect(locator)) return adapter;
  return null;
}

export function listAdapters(): SourceAdapter[] {
  return [...registry.values()];
}

/** Test-only: forget every registered adapter. */
export function resetAdapters(): void {
  registry.clear();
}
