import { createHash, randomUUID } from "node:crypto";
import { embed, makeSummary, makeTitle } from "@ask/ai";
import { loadEnv, logger } from "@ask/config";
import {
  and,
  db,
  desc,
  eq,
  knowledgeChunks,
  knowledgeItems,
  knowledgeRevisions,
  sql,
  type Database,
  type KnowledgeItem,
  type NewKnowledgeItem,
} from "@ask/db";
import { invalidateAnswerCacheForItems } from "./cache.js";
import { type ChunkNode, chunkDocument, chunkEmbeddingInput } from "./chunking.js";
import { emitEvent } from "./events.js";
import { recordUsage } from "./telemetry.js";
import type { IngestInput, KnownSourceType, Visibility } from "./types.js";

/** Per-source default decay rates (per-day lambda). More volatile → higher. */
const DEFAULT_DECAY: Record<KnownSourceType, number> = {
  api: 0.015,
  manual: 0.01,
  git: 0.03,
  url: 0.03,
};

/**
 * Per-source default visibility. Hand-seeded items are public; everything else
 * defaults to private (fail closed). Callers can override.
 */
const DEFAULT_VISIBILITY: Record<KnownSourceType, Visibility> = {
  manual: "public",
  api: "private",
  // Registered sources always pass their own visibility; fail closed otherwise.
  git: "private",
  url: "private",
};

/** Default decay for a source type; an unknown adapter kind decays like `git`. */
export function defaultDecayRate(sourceType: string): number {
  return DEFAULT_DECAY[sourceType as KnownSourceType] ?? DEFAULT_DECAY.git;
}

/** Default visibility for a source type; an unknown adapter kind fails closed to `private`. */
export function defaultVisibility(sourceType: string): Visibility {
  return DEFAULT_VISIBILITY[sourceType as KnownSourceType] ?? "private";
}

/** A Drizzle executor: the shared client or a transaction handle. */
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Governance (ADR-0007): private content never reaches a third-party model or
 * embeddings API unless PRIVATE_EGRESS_ALLOWED. Call before any embed() or
 * cheap-model call on a private item.
 */
function assertPrivateEgress(visibility: "public" | "private", op: string): void {
  if (visibility === "private" && !loadEnv().PRIVATE_EGRESS_ALLOWED) {
    throw new Error(
      `Private ${op} is disabled on this deployment (PRIVATE_EGRESS_ALLOWED=false): the item is private and its body would be sent to a third-party model/embeddings API. Enable private egress or self-host the models.`,
    );
  }
}

/**
 * Ingest a new piece of knowledge: fill title/summary with the cheap model if
 * absent, embed the body, persist the item, and open revision 1.
 */
export async function ingest(input: IngestInput): Promise<KnowledgeItem> {
  const enrich = input.enrich ?? true;
  const visibility = input.visibility ?? defaultVisibility(input.sourceType);
  // Refuse before any model or embedding call — the body never leaves.
  assertPrivateEgress(visibility, "ingest");
  // Landed private with no explicit decision from the caller (fail-closed
  // default): flag it for review so a human decides whether it should be public.
  const autoPrivate = visibility === "private" && input.visibility === undefined;
  let title = input.title;
  let summary = input.summary;

  if (!title) {
    if (enrich) {
      const t = await makeTitle(input.body);
      title = t.value;
      await recordUsage({ kind: "cheap_op", model: t.usage.model, tokensIn: t.usage.inputTokens, tokensOut: t.usage.outputTokens, costUsd: t.usage.costUsd, metadata: { op: "title" } });
    } else {
      title = deriveTitle(input.body);
    }
  }
  if (!summary && enrich) {
    const s = await makeSummary(input.body);
    summary = s.value;
    await recordUsage({ kind: "cheap_op", model: s.usage.model, tokensIn: s.usage.inputTokens, tokensOut: s.usage.outputTokens, costUsd: s.usage.costUsd, metadata: { op: "summary" } });
  }

  // Chunk + embed once: chunk vectors power retrieval; the first is kept as the
  // item's representative embedding.
  const chunks = chunkDocument(input.body, { format: input.format });
  const { vectors, itemVector, model: embedModel, tokens } = await embedChunks(chunks);
  await recordUsage({ kind: "embed", model: embedModel, tokensIn: tokens, metadata: { op: "ingest", chunks: chunks.length } });

  const row: NewKnowledgeItem = {
    title,
    summary,
    body: input.body,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    sourceId: input.sourceId,
    visibility,
    tags: input.tags ?? [],
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.format ? { format: input.format } : {}),
      contentHash: hashBody(input.body),
      ...(autoPrivate ? { [REVIEW_FLAG]: true } : {}),
    },
    baseConfidence: input.baseConfidence ?? 1,
    decayRate: input.decayRate ?? defaultDecayRate(input.sourceType),
    embedding: itemVector,
  };

  // Item, chunks, and revision 1 land together or not at all (ADR-0003): an
  // item with no chunks can never be retrieved.
  const item = await db().transaction(async (tx) => {
    const [inserted] = await tx.insert(knowledgeItems).values(row).returning();
    if (!inserted) throw new Error("ingest: insert returned no row");

    await writeChunks(inserted.id, chunks, vectors, { exec: tx });

    await tx.insert(knowledgeRevisions).values({
      itemId: inserted.id,
      revision: 1,
      title: inserted.title,
      summary: inserted.summary,
      body: inserted.body,
      changeReason: "initial ingest",
      createdBy: input.createdBy ?? "api",
    });
    return inserted;
  });

  // Surfaces subscribe and render their own review UI; the review is also
  // queryable via listVisibilityReviews.
  if (autoPrivate) {
    void emitEvent("knowledge.review_requested", {
      itemId: item.id, title: item.title, sourceType: item.sourceType, sourceRef: item.sourceRef,
    });
  }

  await recordUsage({ kind: "ingest", metadata: { itemId: item.id, sourceType: input.sourceType } });
  return item;
}

/**
 * Embed a chunk tree (ADR-0025). The input for each chunk is its heading
 * breadcrumb plus its body; the stored body stays pure. Structural rows with
 * no text (an empty file root) get no vector, so they are never retrieved.
 * `vectors` is aligned to `chunks`; `itemVector` is the first real vector.
 */
async function embedChunks(
  chunks: ChunkNode[],
): Promise<{ vectors: (number[] | null)[]; itemVector: number[] | null; model: string; tokens?: number }> {
  const inputs: { index: number; text: string }[] = [];
  chunks.forEach((c, index) => {
    if (c.body.trim()) inputs.push({ index, text: chunkEmbeddingInput(c) });
  });
  const vectors: (number[] | null)[] = chunks.map(() => null);
  if (inputs.length === 0) return { vectors, itemVector: null, model: "", tokens: 0 };
  const res = await embed(
    inputs.map((i) => i.text),
    { inputType: "document" },
  );
  inputs.forEach((i, k) => {
    vectors[i.index] = res.vectors[k] ?? null;
  });
  return { vectors, itemVector: vectors.find((v) => v !== null) ?? null, model: res.model, tokens: res.tokens };
}

/**
 * Insert (optionally replacing) an item's chunk tree. Ids are minted here so
 * `parent_id` resolves in the same insert: chunks arrive in document order,
 * every parentPath names an earlier chunk (ADR-0025 guarantees ancestors are
 * emitted), so one pass over path → id is enough.
 */
async function writeChunks(
  itemId: string,
  chunks: ChunkNode[],
  vectors: (number[] | null)[],
  opts?: { replace?: boolean; exec?: Executor },
): Promise<void> {
  const exec = opts?.exec ?? db();
  if (opts?.replace) {
    await exec.delete(knowledgeChunks).where(eq(knowledgeChunks.itemId, itemId));
  }
  if (chunks.length === 0) return;
  const idByPath = new Map<string, string>();
  const rows = chunks.map((c, i) => {
    const id = randomUUID();
    idByPath.set(c.path, id);
    const parentId = c.parentPath === null ? null : idByPath.get(c.parentPath);
    if (c.parentPath !== null && !parentId) {
      throw new Error(`writeChunks: chunk ${c.path} names parent ${c.parentPath} before it was emitted`);
    }
    return {
      id,
      itemId,
      ord: c.ord,
      parentId: parentId ?? null,
      depth: c.depth,
      heading: c.heading,
      headingPath: c.headingPath,
      path: c.path,
      kind: c.kind,
      startLine: c.startLine,
      endLine: c.endLine,
      body: c.body,
      embedding: vectors[i] ?? null,
    };
  });
  await exec.insert(knowledgeChunks).values(rows);
}

/** Cheap title from the body's first meaningful line (no LLM). */
function deriveTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? body).slice(0, 80).trim();
  return base || "Untitled";
}

/**
 * Delete every knowledge item for a source type (chunks + revisions cascade).
 * Used for full-refresh ingests where the source is re-crawled wholesale.
 */
export async function deleteBySource(sourceType: string): Promise<number> {
  const rows = await db()
    .delete(knowledgeItems)
    .where(eq(knowledgeItems.sourceType, sourceType))
    .returning({ id: knowledgeItems.id });
  return rows.length;
}

/** Stable content fingerprint used to detect whether a refresh actually changed a body. */
function hashBody(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex");
}

/**
 * Non-destructive refresh by (sourceType, sourceRef): inserts a new item, and
 * UPDATES an existing item's body in place when the content changed — preserving the item's id, `baseConfidence`
 * (incl. any `down`/`up` adjustment), `retrievalCount`, and revision history. It lets
 * a proactive re-crawl keep content fresh WITHOUT purging, so decay/feedback
 * state survives across runs.
 *
 *  - new item                → ingest (create)
 *  - existing, body unchanged → touch lastVerifiedAt (re-verified against source),
 *                               recover stale→active, refresh metadata/tags. No re-embed.
 *  - existing, body changed   → re-embed + re-chunk, bump a revision, invalidate
 *                               cached answers; id + confidence + retrievalCount kept.
 */
export async function refreshCanonical(
  input: IngestInput & { sourceRef: string },
): Promise<{ item: KnowledgeItem; created: boolean; changed: boolean }> {
  const [existing] = await db()
    .select()
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.sourceType, input.sourceType), eq(knowledgeItems.sourceRef, input.sourceRef)))
    .limit(1);

  if (!existing) return { item: await ingest(input), created: true, changed: true };

  const now = new Date();
  const newHash = hashBody(input.body);
  const oldHash = (existing.metadata as Record<string, unknown> | null)?.contentHash;
  const metadata = { ...(input.metadata ?? {}), ...(input.format ? { format: input.format } : {}), contentHash: newHash };

  if (oldHash === newHash) {
    // Same content: this run re-verified it against its upstream source. Refresh the
    // verification clock (and recover from stale), but touch nothing decay/feedback.
    const [item] = await db()
      .update(knowledgeItems)
      .set({
        status: existing.status === "stale" ? "active" : existing.status,
        lastVerifiedAt: now,
        updatedAt: now,
        metadata,
        tags: input.tags ?? existing.tags,
        title: input.title ?? existing.title,
        summary: input.summary ?? existing.summary,
      })
      .where(eq(knowledgeItems.id, existing.id))
      .returning();
    return { item: item!, created: false, changed: false };
  }

  // Content changed: re-embed + re-chunk, keep the same row (and its confidence /
  // retrievalCount), bump a revision, and invalidate any answer cached on it.
  assertPrivateEgress(existing.visibility, "refresh");
  const chunks = chunkDocument(input.body, { format: input.format });
  const { vectors, itemVector, model, tokens } = await embedChunks(chunks);
  await recordUsage({ kind: "embed", model, tokensIn: tokens, metadata: { op: "refresh", itemId: existing.id, chunks: chunks.length } });

  const nextRev = await nextRevisionNumber(existing.id);
  const [item] = await db()
    .update(knowledgeItems)
    .set({
      title: input.title ?? existing.title,
      summary: input.summary ?? existing.summary,
      body: input.body,
      tags: input.tags ?? existing.tags,
      metadata,
      embedding: itemVector,
      status: "active",
      lastVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(knowledgeItems.id, existing.id))
    .returning();
  if (!item) throw new Error("refreshCanonical: update returned no row");

  await writeChunks(existing.id, chunks, vectors, { replace: true });
  await invalidateAnswerCacheForItems([existing.id]).catch(() => {});
  await db().insert(knowledgeRevisions).values({
    itemId: existing.id,
    revision: nextRev,
    title: item.title,
    summary: item.summary,
    body: item.body,
    changeReason: "source refresh",
    createdBy: input.createdBy ?? "source",
  });

  return { item, created: false, changed: true };
}

export async function getItem(id: string): Promise<KnowledgeItem | undefined> {
  const [item] = await db()
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .limit(1);
  return item;
}

/**
 * Visibility review is a surface-agnostic API concept: a piece of knowledge that
 * was auto-created private (fail-closed) and needs a human to decide whether it
 * should be public. State lives here in the DB (a metadata flag), so ANY UI —
 * lists reviews via GET /v1/knowledge/reviews and
 * resolves them via POST /v1/knowledge/:id/visibility. Surfaces are thin.
 */
const REVIEW_FLAG = "awaitingVisibilityReview";

/** Flag an item as needing a public/private decision. */
export async function flagForVisibilityReview(id: string): Promise<void> {
  await db()
    .update(knowledgeItems)
    .set({ metadata: sql`${knowledgeItems.metadata} || ${JSON.stringify({ [REVIEW_FLAG]: true })}::jsonb` })
    .where(eq(knowledgeItems.id, id));
}

/** List items awaiting a visibility decision (newest first). */
export async function listVisibilityReviews(limit = 50): Promise<KnowledgeItem[]> {
  return db()
    .select()
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.visibility, "private"),
        sql`${knowledgeItems.metadata} ->> ${REVIEW_FLAG} = 'true'`,
      ),
    )
    .orderBy(desc(knowledgeItems.createdAt))
    .limit(limit);
}

/**
 * Set an item's visibility tier and clear any pending review — used to resolve a
 * visibility review from whichever surface the decision came from.
 */
export async function setVisibility(
  id: string,
  visibility: "public" | "private",
): Promise<KnowledgeItem | undefined> {
  const [item] = await db()
    .update(knowledgeItems)
    .set({ visibility, metadata: sql`${knowledgeItems.metadata} - ${REVIEW_FLAG}` })
    .where(eq(knowledgeItems.id, id))
    .returning();
  return item;
}

/**
 * Apply an approved change to an item: re-embed if the body changed, bump the
 * revision, reset decay (lastVerifiedAt = now), and reactivate if stale.
 */
export async function applyRevision(
  id: string,
  change: {
    title?: string;
    summary?: string;
    body?: string;
    changeReason: string;
    createdBy: "api" | "source" | "proposal" | "system";
  },
): Promise<KnowledgeItem> {
  const current = await getItem(id);
  if (!current) throw new Error(`knowledge item ${id} not found`);

  const nextBody = change.body ?? current.body;
  const bodyChanged = nextBody.trim() !== current.body.trim();

  let embedding = current.embedding;
  let newChunks: { chunks: ChunkNode[]; vectors: (number[] | null)[] } | undefined;
  if (bodyChanged) {
    assertPrivateEgress(current.visibility, "revision");
    // Re-chunk with the format the record was ingested with (metadata.format),
    // so a plain-text record is not re-parsed as Markdown on revision.
    const format = (current.metadata as { format?: "markdown" | "text" } | null)?.format;
    const chunks = chunkDocument(nextBody, { format });
    const { vectors, itemVector, model, tokens } = await embedChunks(chunks);
    embedding = itemVector;
    newChunks = { chunks, vectors };
    await recordUsage({ kind: "embed", model, tokensIn: tokens, metadata: { op: "revision", itemId: id, chunks: chunks.length } });
  }

  const nextRev = await nextRevisionNumber(id);
  const now = new Date();

  const [updated] = await db()
    .update(knowledgeItems)
    .set({
      title: change.title ?? current.title,
      summary: change.summary ?? current.summary,
      body: nextBody,
      // Keep the crawl's change gate honest: the stored hash must fingerprint
      // the stored body, or the next crawl compares upstream against a stale
      // hash and never overwrites an approved edit (ADR-0010).
      ...(bodyChanged ? { metadata: { ...current.metadata, contentHash: hashBody(nextBody) } } : {}),
      embedding,
      status: "active",
      lastVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(knowledgeItems.id, id))
    .returning();
  if (!updated) throw new Error("applyRevision: update returned no row");

  if (newChunks) await writeChunks(id, newChunks.chunks, newChunks.vectors, { replace: true });

  // A changed item invalidates any cached answer that cited it.
  await invalidateAnswerCacheForItems([id]);

  await db().insert(knowledgeRevisions).values({
    itemId: id,
    revision: nextRev,
    title: updated.title,
    summary: updated.summary,
    body: updated.body,
    changeReason: change.changeReason,
    createdBy: change.createdBy,
  });

  return updated;
}

async function nextRevisionNumber(itemId: string): Promise<number> {
  const rows = await db()
    .select({ revision: knowledgeRevisions.revision })
    .from(knowledgeRevisions)
    .where(eq(knowledgeRevisions.itemId, itemId));
  const max = rows.reduce((m, r) => Math.max(m, r.revision), 0);
  return max + 1;
}
