import type { KnowledgeItem } from "@ask/db";

/**
 * Where a question came from: the REST API, the management CLI, or an MCP
 * client. `backfill` and `warm` are the engine's own cron traffic (gap re-asks,
 * cache warming) — machine surfaces that must never count as demand: no
 * clustering, no gap-ledger entry.
 */
export type Surface = "api" | "cli" | "mcp" | "backfill" | "warm";

/** True for the engine's own cron traffic (see `Surface`). */
export function isMachineSurface(surface: Surface): boolean {
  return surface === "backfill" || surface === "warm";
}

/** Visibility tier. `private` is inclusive of `public`. */
export type Visibility = "public" | "private";

/**
 * The source types the engine knows how to default decay / visibility for:
 * `api` (inserted via the API), `manual` (hand-seeded), and the two shipped
 * adapter kinds. `sourceType` itself is an open string — any registered
 * adapter kind (ADR-0020) is valid without a migration.
 */
export type KnownSourceType = "api" | "manual" | "git" | "url";

/** Input for ingesting a new piece of knowledge. */
export interface IngestInput {
  body: string;
  title?: string;
  summary?: string;
  /** "api" | "manual" | a registered adapter kind. */
  sourceType: string;
  sourceRef?: string;
  /** Owning registered source (ADR-0024); set only on source-produced records. */
  sourceId?: string;
  /** Body format for the chunker: markdown (heading tree) or plain text. */
  format?: "markdown" | "text";
  /** Actor recorded on the revision. Defaults to `api`. */
  createdBy?: "api" | "source" | "proposal" | "system";
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Visibility tier. Defaults are computed per source when omitted. */
  visibility?: Visibility;
  /** Initial confidence 0-1 (defaults to 1). */
  baseConfidence?: number;
  /** Per-day decay lambda (defaults to source-tuned value). */
  decayRate?: number;
  /**
   * When true (default) fill missing title/summary with the cheap model. Set
   * false on hot paths to avoid an LLM call — a title is derived from the body
   * instead.
   */
  enrich?: boolean;
}

/** A retrieved chunk's parent item with its fused score + decayed confidence. */
export interface ScoredItem {
  item: KnowledgeItem;
  /** The matched chunk's text (more precise grounding than the whole item). */
  chunkBody: string;
  /** The matched chunk's row + position in its item's tree (ADR-0025). */
  chunkId?: string;
  headingPath?: string[];
  chunkPath?: string;
  /** Fused hybrid (vector + lexical RRF) relevance. */
  relevance: number;
  effectiveConfidence: number;
  score: number;
}

export interface AskOptions {
  surface: Surface;
  actorRef?: string;
  /** Max grounding chunks to pass to the model. */
  limit?: number;
  /** Optional tag scope — only items carrying at least one of these tags. */
  tags?: string[];
  /** Prior conversation supplied by the caller, given to the model as context (not a citable source). */
  context?: string;
  /**
   * Visibility of this request. `public` sees only public knowledge; `private`
   * sees public AND private. Defaults to `public`. The API caps this to the
   * caller's credential tier before it reaches here.
   */
  visibility?: Visibility;
  /**
   * Injected sink for cited items that are older than REVERIFY_AGE_HOURS — the
   * answer path calls it fire-and-forget with those item ids so a targeted
   * source re-verify can run out of band. Injected by the app (core can't depend
   * on the sources layer that actually re-checks them).
   */
  scheduleReverify?: (itemIds: string[]) => void;
}

/**
 * A progress step in the answering pipeline, surfaced to streaming clients (the
 * a consumer can render these as progress). Honest phases only —
 * emitted from the real work, never faked on a timer.
 */
export interface StepEvent {
  /** Stable id so a client can update the same card in place. */
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  /** Short result note shown when the step completes (e.g. "6 sources"). */
  output?: string;
}

export type StepFn = (step: StepEvent) => void;

/** A cited source, resolved to its human title + link (not a bare id). */
export interface Citation {
  id: string;
  title?: string;
  url?: string;
}

export interface AskResult {
  answer: string;
  citedIds: string[];
  /** Cited sources with title + url, in cited order. */
  citations: Citation[];
  abstained: boolean;
  visibility: Visibility;
  questionEventId: string;
  answerId: string;
  model: string;
}
