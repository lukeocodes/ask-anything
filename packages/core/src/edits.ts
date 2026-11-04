/**
 * Approved edits detach source-owned records (ADR-0010). The rules here are
 * pure so they can be tested without a database; `sources.ts` and
 * `proposals.ts` do the reads and writes.
 *
 * A record's owner is `metadata.origin`:
 *  - `source`: the adapter refreshes it in place on every index run.
 *  - `edited`: a human edit was approved on a source record. It keeps its
 *    `sourceId` and `sourceRef`, plus `metadata.baselineHash`, the upstream
 *    hash from just before the edit. Index runs compare, never overwrite.
 */

/** `metadata.origin` stamped on every record a registered source produces. */
export const SOURCE_ORIGIN = "source";

/** `metadata.origin` on a source record that carries an approved human edit. */
export const EDITED_ORIGIN = "edited";

/** `proposedBy` prefix on proposals an index run writes. */
export const SOURCE_PROPOSER_PREFIX = "source:";

type WithMetadata = { metadata: Record<string, unknown> | null };

export function isEdited(item: WithMetadata): boolean {
  return item.metadata?.origin === EDITED_ORIGIN;
}

/** The upstream hash an edited record was detached at (or last rejected at). */
export function baselineOf(item: WithMetadata): string | undefined {
  const b = item.metadata?.baselineHash;
  return typeof b === "string" ? b : undefined;
}

export function sourceProposer(sourceId: string): string {
  return `${SOURCE_PROPOSER_PREFIX}${sourceId}`;
}

/** True when an index run wrote the proposal, not an API key. */
export function isSourceProposal(p: { proposedBy: string | null }): boolean {
  return p.proposedBy?.startsWith(SOURCE_PROPOSER_PREFIX) ?? false;
}

/** True when a source proposal asks to delete the record. */
export function isRemovalProposal(p: { diff: Record<string, unknown> | null }): boolean {
  return p.diff?.action === "remove";
}

export type EditedAction = "hold" | "reattach" | "propose";

/**
 * What an index run does with an edited record it has just read upstream:
 *  - upstream equals the baseline: `hold`, the edit stands
 *  - upstream equals the edited body: `reattach`, upstream caught up
 *  - anything else: `propose` the upstream body
 *
 * A missing baseline means the record was edited but never got one. Treat
 * any upstream that is not the edited body as a change worth a human.
 */
export function editedAction(baseline: string | undefined, editedHash: string | undefined, upstreamHash: string): EditedAction {
  if (baseline !== undefined && upstreamHash === baseline) return "hold";
  if (editedHash !== undefined && upstreamHash === editedHash) return "reattach";
  return "propose";
}

export type PendingAction = "insert" | "replace" | "wait";

/**
 * A source proposal meets whatever is already pending on the record:
 * nothing pending → `insert`; a pending source proposal → `replace` it;
 * a pending human proposal → `wait` for the next index run.
 */
export function pendingAction(pending: { proposedBy: string | null } | undefined): PendingAction {
  if (!pending) return "insert";
  return isSourceProposal(pending) ? "replace" : "wait";
}

/**
 * The metadata a record carries after an approved human proposal. A source
 * record detaches with its pre-edit hash as the baseline. An edited record
 * keeps its baseline. Anything else is untouched.
 */
export function metadataAfterHumanApproval(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const origin = before?.origin;
  if (origin === SOURCE_ORIGIN) {
    const baseline = before?.contentHash;
    return {
      ...(after ?? {}),
      origin: EDITED_ORIGIN,
      ...(typeof baseline === "string" ? { baselineHash: baseline } : {}),
    };
  }
  if (origin === EDITED_ORIGIN) {
    return { ...(after ?? {}), origin: EDITED_ORIGIN, ...(before?.baselineHash ? { baselineHash: before.baselineHash } : {}) };
  }
  return after;
}

/** Metadata for a record going back to its source: `origin = "source"`, no baseline. */
export function reattachedMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  const { baselineHash: _drop, ...rest } = meta ?? {};
  return { ...rest, origin: SOURCE_ORIGIN };
}
