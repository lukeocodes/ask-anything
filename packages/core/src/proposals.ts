import { logger } from "@ask/config";
import {
  and,
  db,
  desc,
  eq,
  knowledgeItems,
  updateProposals,
  type KnowledgeItem,
  type UpdateProposal,
} from "@ask/db";
import {
  isEdited,
  isRemovalProposal,
  isSourceProposal,
  metadataAfterHumanApproval,
  pendingAction,
  reattachedMetadata,
  sourceProposer,
} from "./edits.js";
import { applyRevision, getItem } from "./knowledge.js";
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
 * API key that sent it.
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

/**
 * An index run proposes a change to an edited record (ADR-0010): a new
 * upstream body, or removal when the file or page is gone. A pending source
 * proposal on the record is replaced in place. A pending human proposal is
 * left alone and the index run tries again next time. Returns the proposal,
 * or undefined when it waited.
 */
export async function proposeFromSource(
  item: Pick<KnowledgeItem, "id" | "sourceType">,
  sourceId: string,
  candidate: ProposalCandidate,
): Promise<UpdateProposal | undefined> {
  const [pending] = await db()
    .select()
    .from(updateProposals)
    .where(and(eq(updateProposals.itemId, item.id), eq(updateProposals.status, "pending")))
    .limit(1);

  const action = pendingAction(pending);
  if (action === "wait") return undefined;

  const values = {
    proposedTitle: candidate.proposedTitle ?? null,
    proposedSummary: candidate.proposedSummary ?? null,
    proposedBody: candidate.proposedBody ?? null,
    diff: candidate.diff,
    evidence: candidate.evidence,
  };

  if (action === "replace" && pending) {
    const [proposal] = await db()
      .update(updateProposals)
      .set(values)
      .where(eq(updateProposals.id, pending.id))
      .returning();
    return proposal;
  }

  const proposedBy = sourceProposer(sourceId);
  const [proposal] = await db()
    .insert(updateProposals)
    .values({ itemId: item.id, sourceType: item.sourceType, proposedBy, status: "pending", ...values })
    .returning();
  if (!proposal) throw new Error("proposeFromSource: insert returned no row");
  await recordUsage({
    kind: "watch",
    actor: proposedBy,
    metadata: { proposalId: proposal.id, itemId: item.id, sourceType: item.sourceType, action: candidate.diff.action ?? "update" },
  });
  return proposal;
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

  // A rejected source proposal moves the edited record's baseline to the
  // upstream it rejected, so the index proposes again only when upstream
  // moves again (ADR-0010).
  const upstreamHash = proposal.diff?.upstreamHash;
  if (isSourceProposal(proposal) && !isRemovalProposal(proposal) && typeof upstreamHash === "string") {
    const item = await getItem(proposal.itemId);
    if (item) {
      await db()
        .update(knowledgeItems)
        .set({ metadata: { ...(item.metadata ?? {}), baselineHash: upstreamHash } })
        .where(eq(knowledgeItems.id, item.id));
    }
  }
  return "done";
}

/**
 * An operator approves a proposal: apply the change (new revision, re-embed,
 * reset decay) and mark the proposal applied. On a source-owned record the
 * owner changes too (ADR-0010):
 *  - a human proposal detaches it (`origin = "edited"`, baseline = the hash
 *    from before the edit); on an edited record the baseline stays
 *  - a source proposal applies the upstream body and re-attaches it
 *  - a source removal proposal deletes the record
 */
export async function approveProposal(
  id: string,
  decidedBy: string,
): Promise<ProposalOutcome> {
  const proposal = await getProposal(id);
  if (!proposal) return "not_found";
  if (proposal.status !== "pending") return "already_decided";

  const markApplied = () =>
    db()
      .update(updateProposals)
      .set({ status: "applied", decidedBy, decidedAt: new Date() })
      .where(eq(updateProposals.id, id));

  const before = await getItem(proposal.itemId);
  if (!before) return "not_found";

  if (isSourceProposal(proposal) && isRemovalProposal(proposal)) {
    await markApplied();
    // The proposal row cascades with the item; the log line is the record.
    await db().delete(knowledgeItems).where(eq(knowledgeItems.id, before.id));
    logger("proposals").info(
      { itemId: before.id, sourceRef: before.sourceRef, proposalId: id, decidedBy, reason: "vanished_upstream_approved" },
      "removed edited source item",
    );
    return "done";
  }

  const updated = await applyRevision(proposal.itemId, {
    title: proposal.proposedTitle ?? undefined,
    summary: proposal.proposedSummary ?? undefined,
    body: proposal.proposedBody ?? undefined,
    changeReason: `approved proposal ${id} (${proposal.sourceType})`,
    createdBy: isSourceProposal(proposal) ? "source" : "proposal",
  });

  // Only an edited record re-attaches. A source proposal left pending on a
  // record that has since re-attached or lost its source changes no owner.
  const metadata = !isSourceProposal(proposal)
    ? metadataAfterHumanApproval(before.metadata, updated.metadata)
    : isEdited(before)
      ? reattachedMetadata(updated.metadata)
      : updated.metadata;
  if (metadata && metadata !== updated.metadata) {
    await db().update(knowledgeItems).set({ metadata }).where(eq(knowledgeItems.id, updated.id));
  }

  await markApplied();
  return "done";
}

/** Link a proposal to an external approval reference. */
export async function setProposalApprovalRef(id: string, ref: string): Promise<void> {
  await db()
    .update(updateProposals)
    .set({ approvalRef: ref })
    .where(eq(updateProposals.id, id));
}
