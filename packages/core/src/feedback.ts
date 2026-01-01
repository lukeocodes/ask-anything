import {
  and,
  answers,
  db,
  desc,
  eq,
  feedback,
  inArray,
  knowledgeItems,
  sql,
  type Answer,
  type Feedback,
} from "@ask/db";
import { invalidateAnswerCacheForItems } from "./cache.js";
import { reinforce } from "./decay.js";
import { recordUsage } from "./telemetry.js";
import type { Surface } from "./types.js";

export interface FeedbackInput {
  rating: "up" | "down";
  actorRef?: string;
  surface?: Surface;
  comment?: string;
}

export async function getAnswer(id: string): Promise<Answer | undefined> {
  const [row] = await db().select().from(answers).where(eq(answers.id, id)).limit(1);
  return row;
}

/**
 * Record a up/down on an answer. Surface-agnostic — the API exposes this to any
 * client; the CLI is one caller.
 */
export async function recordFeedback(
  answerId: string,
  input: FeedbackInput,
): Promise<Feedback> {
  const answer = await getAnswer(answerId);
  if (!answer) throw new Error(`answer ${answerId} not found`);

  const [row] = await db()
    .insert(feedback)
    .values({
      answerId,
      rating: input.rating,
      comment: input.comment,
      surface: input.surface,
      actorRef: input.actorRef,
    })
    .returning();
  if (!row) throw new Error("recordFeedback: insert returned no row");

  // Close the loop: feedback nudges ranking of the cited items.
  await applyFeedbackToRanking(answer.itemIds, input.rating);

  await recordUsage({
    kind: "feedback",
    surface: input.surface,
    actor: input.actorRef,
    metadata: { answerId, rating: input.rating, hasComment: Boolean(input.comment) },
  });
  return row;
}

/**
 * `up` reinforces cited items (bumps retrievalCount so they resist decay). It is
 * popularity, not a source check, so it never stamps lastVerifiedAt — only a
 * refresh or re-verify does (ADR-0009/0021). `down` penalises their base confidence
 * (floored) so they rank lower next time, and invalidates any cached answer
 * built on them.
 */
async function applyFeedbackToRanking(
  itemIds: string[],
  rating: "up" | "down",
): Promise<void> {
  if (itemIds.length === 0) return;
  if (rating === "up") {
    await Promise.all(itemIds.map((id) => reinforce(id, { verify: false }).catch(() => {})));
    return;
  }
  await db()
    .update(knowledgeItems)
    .set({ baseConfidence: sql`GREATEST(0.1, ${knowledgeItems.baseConfidence} * 0.85)` })
    .where(inArray(knowledgeItems.id, itemIds));
  await invalidateAnswerCacheForItems(itemIds);
}

/**
 * Attach free-text follow-up feedback to an answer — the natural-language reply
 * a user gives after a `down`. Fills the comment on their most recent negative
 * feedback for this answer, or records a new negative row with the comment.
 */
export async function addFeedbackComment(
  answerId: string,
  input: { comment: string; actorRef?: string; surface?: Surface },
): Promise<Feedback> {
  const conds = [eq(feedback.answerId, answerId), eq(feedback.rating, "down")];
  if (input.actorRef) conds.push(eq(feedback.actorRef, input.actorRef));

  const [existing] = await db()
    .select()
    .from(feedback)
    .where(and(...conds))
    .orderBy(desc(feedback.createdAt))
    .limit(1);

  if (existing && !existing.comment) {
    const [updated] = await db()
      .update(feedback)
      .set({ comment: input.comment })
      .where(eq(feedback.id, existing.id))
      .returning();
    await recordUsage({ kind: "feedback", surface: input.surface, actor: input.actorRef, metadata: { answerId, rating: "down", comment: true } });
    return updated!;
  }

  return recordFeedback(answerId, {
    rating: "down",
    comment: input.comment,
    actorRef: input.actorRef,
    surface: input.surface,
  });
}
