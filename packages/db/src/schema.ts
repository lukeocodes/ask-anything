import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Embedding dimension — must match EMBEDDINGS_MODEL / EMBEDDING_DIM. Env-driven
 * so the migration and the runtime agree; default 1024 (voyage-4-lite / voyage-3
 * at output_dimension 1024). Changing it requires re-embedding everything and
 * regenerating the migration.
 */
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || 1024;

// --- Enums ------------------------------------------------------------------

// Registered sources (ADR-0024).
export const sourceStatusEnum = pgEnum("source_status", ["idle", "indexing", "error"]);
export const urlCrawlEnum = pgEnum("url_crawl", ["page", "sitemap"]);
// Chunk tree (ADR-0025).
export const chunkKindEnum = pgEnum("chunk_kind", ["file", "section", "paragraph", "code"]);

export const knowledgeStatusEnum = pgEnum("knowledge_status", [
  "active",
  "stale", // decayed below the refresh threshold; re-read on the next source index
  "archived",
  "proposed", // exists only as a candidate, not yet approved
]);

export const revisionActorEnum = pgEnum("revision_actor", [
  "api",
  "source", // a source adapter refreshed the record in place
  "proposal",
  "system",
]);

// `backfill` / `warm` are the engine's own cron traffic (machine surfaces).
// Where a request came from. `backfill` and `warm` are the API's own cron jobs.
export const surfaceEnum = pgEnum("surface", ["api", "cli", "mcp", "backfill", "warm"]);

export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "applied",
]);

export const feedbackRatingEnum = pgEnum("feedback_rating", ["up", "down"]);

/**
 * Visibility tier. `public` = docs / public-site-driven knowledge only.
 * `private` = internal knowledge; a private request sees public AND private
 * (private is inclusive of public). Unlocking private requires a private-tier
 * credential — see auth.
 */
export const visibilityEnum = pgEnum("visibility", ["public", "private"]);

// --- Sources ----------------------------------------------------------------

/** A registered place knowledge comes from: a repo, a site, … (ADR-0024). */
/**
 * A registered source (ADR-0024): a git remote or a URL the engine clones /
 * fetches and indexes on a schedule, on demand, or one record at a time.
 * Records it produces carry source_id and metadata.origin = "source".
 */
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Adapter kind ("git", "url", ...). Text, not an enum: adapters register at
    // runtime (ADR-0020) and must not need a migration.
    kind: text("kind").notNull(),
    // Clone URL (https / ssh / git@) or page URL.
    locator: text("locator").notNull(),
    // Provider hint from the adapter's describe() ("github", "web", ...).
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    branch: text("branch"),
    include: text("include").array().notNull().default(sql`'{}'::text[]`),
    exclude: text("exclude").array().notNull().default(sql`'{}'::text[]`),
    // url sources only: index the one page, or expand its sitemap.
    crawl: urlCrawlEnum("crawl"),
    // Per-source cron. NULL = INDEX_DEFAULT_SCHEDULE.
    schedule: text("schedule"),
    // Non-secret, adapter-specific config; exposed to the adapter as ctx.config.
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    // Name of an env var on the API host holding this source's secret. Only the
    // name is stored; the value is read into ctx.secret when an index runs.
    credentialEnv: text("credential_env"),
    enabled: boolean("enabled").notNull().default(true),
    status: sourceStatusEnum("status").notNull().default("idle"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    // git: HEAD sha at last index. url: content hash of the sitemap / page.
    lastCommit: text("last_commit"),
    lastError: text("last_error"),
    itemCount: integer("item_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("knowledge_sources_locator_uq").on(t.locator)],
);

// --- Knowledge items --------------------------------------------------------

/**
 * The living knowledgebase. Each row is one indexed fact, file, page, or snippet.
 * Confidence decays over time (see @ask/core decay); low-confidence rows go
 * `stale` and are queued for a source refresh rather than being deleted.
 */
export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull(),

    // "api" | "manual" | a registered adapter kind ("git", "url", …). Text, not
    // an enum, so a new adapter kind never needs a migration.
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"), // canonical url / doc id / message permalink
    sourceId: uuid("source_id").references(() => knowledgeSources.id, {
      onDelete: "set null",
    }),

    status: knowledgeStatusEnum("status").notNull().default("active"),
    // Fail closed: unset visibility is treated as private (never leaked to a
    // public request). Public sources set this to `public` explicitly.
    visibility: visibilityEnum("visibility").notNull().default("private"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    // --- Neurosymbolic decay parameters ---
    // effective_confidence = baseConfidence * exp(-decayRate * ageDays),
    // reinforced by retrievalCount (see @ask/core/decay).
    baseConfidence: real("base_confidence").notNull().default(1),
    decayRate: real("decay_rate").notNull().default(0.02), // per-day lambda
    retrievalCount: integer("retrieval_count").notNull().default(0),
    lastRetrievedAt: timestamp("last_retrieved_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("knowledge_items_status_idx").on(t.status),
    index("knowledge_items_visibility_idx").on(t.visibility),
    index("knowledge_items_source_type_idx").on(t.sourceType),
    index("knowledge_items_last_verified_idx").on(t.lastVerifiedAt),
    // HNSW index for cosine similarity retrieval.
    index("knowledge_items_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/**
 * Retrieval chunks. Long items are split into overlapping chunks so retrieval
 * is precise (a query matches the relevant passage, not a whole document).
 * Each chunk has its own embedding for vector search; lexical search uses an
 * expression GIN index over to_tsvector(body) added in the migration. Status /
 * visibility / decay are read by joining the parent item.
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    // Document order across the whole file.
    ord: integer("ord").notNull().default(0),
    // --- Tree structure (ADR-0025). Body is text alone; context lives here.
    parentId: uuid("parent_id").references((): AnyPgColumn => knowledgeChunks.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull().default(0),
    heading: text("heading"),
    headingPath: text("heading_path").array().notNull().default(sql`'{}'::text[]`),
    // Materialised position, e.g. "0.2.1": subtree = path prefix.
    path: text("path").notNull().default(""),
    kind: chunkKindEnum("kind").notNull().default("section"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    body: text("body").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("knowledge_chunks_item_idx").on(t.itemId),
    index("knowledge_chunks_parent_idx").on(t.parentId),
    uniqueIndex("knowledge_chunks_item_path_uq").on(t.itemId, t.path),
    index("knowledge_chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    // Lexical half of hybrid retrieval (ADR-0004): expression GIN index that
    // matches the to_tsvector('english', body) predicate in core retrieval.
    index("knowledge_chunks_fts_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.body})`,
    ),
  ],
);

/** Append-only history of a knowledge item (audit + rollback + decay memory). */
export const knowledgeRevisions = pgTable(
  "knowledge_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull(),
    changeReason: text("change_reason"),
    createdBy: revisionActorEnum("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("knowledge_revisions_item_rev_uq").on(t.itemId, t.revision),
  ],
);

// --- Questions & answers ----------------------------------------------------

/**
 * A canonical question. Many raw phrasings collapse into one row via
 * normalisation + embedding clustering ("20 users asked this"). askCount is
 * the deduped demand signal.
 */
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalText: text("canonical_text").notNull(),
    normalizedText: text("normalized_text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    askCount: integer("ask_count").notNull().default(0),
    firstAskedAt: timestamp("first_asked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAskedAt: timestamp("last_asked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The item most often used to answer this (weak fk, informational).
    canonicalItemId: uuid("canonical_item_id").references(
      () => knowledgeItems.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("questions_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("questions_ask_count_idx").on(t.askCount),
  ],
);

/** One occurrence of someone asking (raw phrasing + who + where). */
export const questionEvents = pgTable(
  "question_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionId: uuid("question_id").references(() => questions.id, {
      onDelete: "set null",
    }),
    rawText: text("raw_text").notNull(),
    surface: surfaceEnum("surface").notNull(),
    actorRef: text("actor_ref"), // caller id / api key label
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("question_events_question_idx").on(t.questionId)],
);

/** A generated answer to a question event, with provenance. */
export const answers = pgTable("answers", {
  id: uuid("id").defaultRandom().primaryKey(),
  questionEventId: uuid("question_event_id")
    .notNull()
    .references(() => questionEvents.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  model: text("model").notNull(),
  // Which knowledge items grounded the answer.
  itemIds: uuid("item_ids").array().notNull().default(sql`'{}'::uuid[]`),
  // The visibility tier this answer was produced under (audit).
  visibility: visibilityEnum("visibility").notNull().default("public"),
  latencyMs: integer("latency_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Feedback on an answer. Surface-agnostic: recorded via the API by any client
 * (the CLI is one). A `down` may be followed by a
 * free-text `comment` captured in a natural-language follow-up.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    answerId: uuid("answer_id")
      .notNull()
      .references(() => answers.id, { onDelete: "cascade" }),
    rating: feedbackRatingEnum("rating").notNull(),
    comment: text("comment"),
    surface: surfaceEnum("surface"),
    actorRef: text("actor_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("feedback_answer_idx").on(t.answerId),
    index("feedback_rating_idx").on(t.rating),
  ],
);

/**
 * Semantic answer cache. A repeat question (by embedding similarity, within the
 * same visibility tier) returns a stored answer without a model call — the
 * biggest speed/cost lever, and model-independent. Entries are invalidated when
 * a cited item changes or when the answer gets a `down`, and expire via `expiresAt`.
 */
export const answerCache = pgTable(
  "answer_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionEmbedding: vector("question_embedding", { dimensions: EMBEDDING_DIM }),
    queryText: text("query_text").notNull(),
    visibility: visibilityEnum("visibility").notNull(),
    answerText: text("answer_text").notNull(),
    citedItemIds: uuid("cited_item_ids").array().notNull().default(sql`'{}'::uuid[]`),
    model: text("model").notNull(),
    // The answer this entry was stored from, so a `down` on that answer can evict
    // it even when it cited no DB items (no item citations). Weak fk.
    answerId: uuid("answer_id"),
    hits: integer("hits").notNull().default(0),
    invalidated: boolean("invalidated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("answer_cache_embedding_idx").using(
      "hnsw",
      t.questionEmbedding.op("vector_cosine_ops"),
    ),
    index("answer_cache_visibility_idx").on(t.visibility),
    index("answer_cache_invalidated_idx").on(t.invalidated),
    index("answer_cache_answer_idx").on(t.answerId),
  ],
);

// --- Telemetry --------------------------------------------------------------

/** Usage telemetry — every billable / notable action, kept in the DB. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(), // "answer" | "embed" | "cheap_op" | "ingest" | ...
    surface: surfaceEnum("surface"),
    actor: text("actor"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("usage_events_kind_idx").on(t.kind),
    index("usage_events_created_idx").on(t.createdAt),
  ],
);

// --- Update proposals (anyone with a write key → operator approval) ----------

/**
 * A proposed change to an EXISTING knowledge item, sent by any write-scope
 * key through `POST /v1/knowledge/:id/proposals` (ADR-0010). Registered
 * adapters never propose; they refresh in place. Proposals are listed for an
 * operator (via the CLI or management MCP) to approve before they touch the
 * knowledgebase.
 */
export const updateProposals = pgTable(
  "update_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    // Label of the API key that sent the proposal (ADR-0010). Null for
    // proposals the engine raised itself.
    proposedBy: text("proposed_by"),
    proposedTitle: text("proposed_title"),
    proposedSummary: text("proposed_summary"),
    proposedBody: text("proposed_body"),
    // Machine-readable diff + the evidence (links) that triggered the proposal.
    diff: jsonb("diff").$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb("evidence")
      .$type<{ url?: string; note?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: proposalStatusEnum("status").notNull().default("pending"),
    approvalRef: text("approval_ref"), // external approval reference, if any
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("update_proposals_status_idx").on(t.status),
    index("update_proposals_item_idx").on(t.itemId),
  ],
);

/** A recorded decay recomputation — the symbolic-forgetting audit trail. */
export const decayEvents = pgTable("decay_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => knowledgeItems.id, { onDelete: "cascade" }),
  effectiveConfidence: real("effective_confidence").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Append-only domain event log. The core emits events (e.g. a private item
 * needs a visibility decision, an answer got feedback); surfaces subscribe via
 * the API's event stream and render their own UI. `seq` gives a monotonic
 * cursor for replay on reconnect; the durable table means any UI can also poll
 * history, not just catch live events.
 */
export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_type_idx").on(t.type)],
);

// --- Inferred types ---------------------------------------------------------

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type NewKnowledgeSource = typeof knowledgeSources.$inferInsert;
export type KnowledgeItem = typeof knowledgeItems.$inferSelect;
export type NewKnowledgeItem = typeof knowledgeItems.$inferInsert;
export type KnowledgeRevision = typeof knowledgeRevisions.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type QuestionEvent = typeof questionEvents.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type UpdateProposal = typeof updateProposals.$inferSelect;
export type NewUpdateProposal = typeof updateProposals.$inferInsert;
export type DecayEvent = typeof decayEvents.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;
export type AnswerCache = typeof answerCache.$inferSelect;
export type NewAnswerCache = typeof answerCache.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
