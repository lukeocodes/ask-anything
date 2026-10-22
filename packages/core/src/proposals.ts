import {
  and,
  db,
  desc,
  eq,
  updateProposals,
  type KnowledgeItem,
  type UpdateProposal,
} from "@ask/db";
import { applyRevision } from "./knowledge.js";
import { recordUsage } from "./telemetry.js";

export interface ProposalCandidate {
  proposedTitle?: string;
  proposedSummary?: string;
  proposedBody?: string;
  diff: Record<string, unknown>;
  evidence: { url?: string; note?: string }[];
}

export interface ProposeResult {
  proposal: UpdateProposal;
  /** False when a pending proposal for the item already existed and was returned instead. */
  created: boolean;
}

/**
 * Create a pending update proposal for an existing item (ADR-0010). Nothing
 * touches the item; the proposal waits for `approveProposal` / `rejectProposal`.
 * One pending proposal per item: a second call while one is pending returns
 * the existing one with `created: false`. `proposedBy` is the label of the
 * API key that sent it; the engine's own verify tick passes none.
 */
export async function proposeUpdate(
  itemId: string,
  sourceType: string,
  candidate: ProposalCandidate,
  proposedBy?: string,
): Promise<ProposeResult> {
  const [existing] = await db()
    .select()
    .from(updateProposals)
    .where(
      and(
        eq(updateProposals.itemId, itemId),
        eq(updateProposals.status, "pending"),
      ),
    )
    .limit(1);
  if (existing) return { proposal: existing, created: false };

  const [proposal] = await db()
    .insert(updateProposals)
    .values({
      itemId,
      sourceType,
      proposedBy,
      proposedTitle: candidate.proposedTitle,
      proposedSummary: candidate.proposedSummary,
      proposedBody: candidate.proposedBody,
      diff: candidate.diff,
      evidence: candidate.evidence,
      status: "pending",
    })
    .returning();
  if (!proposal) throw new Error("proposeUpdate: insert returned no row");

  await recordUsage({
    kind: "watch",
    actor: proposedBy,
    metadata: { proposalId: proposal.id, itemId, sourceType },
  });
  return { proposal, created: true };
}

export async function listPendingProposals(limit = 50): Promise<UpdateProposal[]> {
  return db()
    .select()
    .from(updateProposals)
    .where(eq(updateProposals.status, "pending"))
    .orderBy(desc(updateProposals.createdAt))
    .limit(limit);
}

export async function getProposal(id: string): Promise<UpdateProposal | undefined> {
  const [p] = await db()
    .select()
    .from(updateProposals)
    .where(eq(updateProposals.id, id))
    .limit(1);
  return p;
}

/** Outcome of resolving a proposal — lets callers answer cleanly (e.g. 404). */
export type ProposalOutcome = "not_found" | "already_decided" | "done";

/** An operator rejects a proposal. */
export async function rejectProposal(id: string, decidedBy: string): Promise<ProposalOutcome> {
  const proposal = await getProposal(id);
  if (!proposal) return "not_found";
  if (proposal.status !== "pending") return "already_decided";

  await db()
    .update(updateProposals)
    .set({ status: "rejected", decidedBy, decidedAt: new Date() })
    .where(eq(updateProposals.id, id));
  return "done";
}

/**
 * An operator approves a proposal — apply the change (new revision, re-embed, reset
 * decay) and mark the proposal applied.
 */
export async function approveProposal(
  id: string,
  decidedBy: string,
): Promise<ProposalOutcome> {
  const proposal = await getProposal(id);
  if (!proposal) return "not_found";
  if (proposal.status !== "pending") return "already_decided";

  await applyRevision(proposal.itemId, {
    title: proposal.proposedTitle ?? undefined,
    summary: proposal.proposedSummary ?? undefined,
    body: proposal.proposedBody ?? undefined,
    changeReason: `approved proposal ${id} (${proposal.sourceType})`,
    createdBy: "proposal",
  });

  await db()
    .update(updateProposals)
    .set({ status: "applied", decidedBy, decidedAt: new Date() })
    .where(eq(updateProposals.id, id));
  return "done";
}

/** Link a proposal to an external approval reference. */
export async function setProposalApprovalRef(id: string, ref: string): Promise<void> {
  await db()
    .update(updateProposals)
    .set({ approvalRef: ref })
    .where(eq(updateProposals.id, id));
}
