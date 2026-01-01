import { embed, estimateCostUsd, normalizeQuestion } from "@ask/ai";
import {
  cosineDistance,
  db,
  desc,
  eq,
  questionEvents,
  questions,
  sql,
} from "@ask/db";
import { recordUsage } from "./telemetry.js";
import type { Surface } from "./types.js";

/** Similarity above which two questions are considered "the same question". */
const CLUSTER_THRESHOLD = 0.9;

/**
 * Log a raw question occurrence — a cheap, synchronous insert with NO LLM call,
 * so it stays off the answer's critical path. Normalisation + clustering happen
 * afterwards via clusterQuestionEvent().
 */
export async function logQuestionEvent(
  rawText: string,
  ctx: { surface: Surface; actorRef?: string },
): Promise<{ questionEventId: string }> {
  const [event] = await db()
    .insert(questionEvents)
    .values({
      rawText,
      surface: ctx.surface,
      actorRef: ctx.actorRef,
    })
    .returning({ id: questionEvents.id });
  return { questionEventId: event!.id };
}

/**
 * Normalise a raw question with the cheap model, cluster it against existing
 * questions by embedding similarity ("20 users asked this"), and link the event
 * to its canonical question. Runs AFTER the answer is returned (fire-and-forget)
 * — it's analytics/demand signal, not part of answering.
 */
export async function clusterQuestionEvent(
  questionEventId: string,
  rawText: string,
  ctx: { surface: Surface },
): Promise<void> {
  const norm = await normalizeQuestion(rawText);
  await recordUsage({ kind: "cheap_op", model: norm.usage.model, tokensIn: norm.usage.inputTokens, tokensOut: norm.usage.outputTokens, costUsd: norm.usage.costUsd, surface: ctx.surface, metadata: { op: "normalize" } });
  const canonical = norm.value;

  const embedStartedAt = Date.now();
  const embedded = await embed([canonical], { inputType: "query" });
  await recordUsage({
    kind: "embed", surface: ctx.surface, model: embedded.model, tokensIn: embedded.tokens,
    costUsd: estimateCostUsd(embedded.model, embedded.tokens ?? 0, 0),
    latencyMs: Date.now() - embedStartedAt, metadata: { op: "cluster" },
  }).catch(() => {});
  const vec = embedded.vectors[0];
  const now = new Date();

  const nearest = vec ? await nearestQuestion(vec) : undefined;

  let questionId: string;
  if (nearest && nearest.similarity >= CLUSTER_THRESHOLD) {
    const [updated] = await db()
      .update(questions)
      .set({ askCount: sql`${questions.askCount} + 1`, lastAskedAt: now })
      .where(eq(questions.id, nearest.id))
      .returning({ id: questions.id });
    questionId = updated!.id;
  } else {
    const [created] = await db()
      .insert(questions)
      .values({
        canonicalText: canonical,
        normalizedText: canonical,
        embedding: vec,
        askCount: 1,
        firstAskedAt: now,
        lastAskedAt: now,
      })
      .returning({ id: questions.id });
    questionId = created!.id;
  }

  await db()
    .update(questionEvents)
    .set({ questionId })
    .where(eq(questionEvents.id, questionEventId));
}

async function nearestQuestion(
  vec: number[],
): Promise<{ id: string; similarity: number } | undefined> {
  // `<=>` ascending is the only ordering pgvector's HNSW index serves; the
  // similarity is derived afterwards for the threshold.
  const distance = cosineDistance(questions.embedding, vec);
  const [row] = await db()
    .select({ id: questions.id, distance: sql<number>`${distance}` })
    .from(questions)
    .where(sql`${questions.embedding} is not null`)
    .orderBy(distance)
    .limit(1);
  return row ? { id: row.id, similarity: 1 - Number(row.distance) } : undefined;
}

/** Top unanswered / high-demand questions — useful for gap analysis. */
export async function topQuestions(limit = 20) {
  return db()
    .select()
    .from(questions)
    .orderBy(desc(questions.askCount))
    .limit(limit);
}
