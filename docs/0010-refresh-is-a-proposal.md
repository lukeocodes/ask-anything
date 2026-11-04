# 0010. Adapters refresh in place; everyone else proposes

Date: 2026-01-01

## Status

Accepted

## Context

Letting an automated process rewrite canonical knowledge means a bad upstream
edit or a misparsed page silently replaces a good answer. But indexing a
registered repo produces thousands of records; a human cannot approve each
one, and the repo is already the truth.

The changes that most need a human are not sources at all. A support
engineer with a correction, an agent that noticed a doc is stale, a chat
relay carrying a thread where someone said "that's wrong now". Building each
of those as an adapter puts a vendor integration in the engine for what is,
every time, the same action: here is a proposed change to record X, with
evidence.

## Decision

Who writes decides the path, not what kind of source.

**Registered adapters refresh in place.** An index run stamps every record
`metadata.origin = "source"` and `refreshCanonical` rewrites changed bodies,
re-embeds, replaces the chunk tree, and writes a revision. No proposal, no
approval. The adapter contract has no trust level and no verify hook
([0020](0020-sources-seed-and-refresh.md)); an adapter is trusted by being
registered.

**Everyone else proposes.** `POST /v1/knowledge/:id/proposals` takes a
candidate (`proposedTitle`, `proposedSummary`, `proposedBody`, `diff`,
`evidence[]`) from any write-scope key and writes an `update_proposal`,
status `pending`, carrying the record's `sourceType` and the label of the
key that sent it. One pending proposal per record: a second call while one
is pending returns the existing one. Nothing touches the record.

The caller is `ask proposals create <id>` in the CLI, the management MCP
tool the registry generates from it ([0002](0002-cli-is-management.md)),
or any tool or agent that can make an HTTP request with a key. The engine
does not know or care what the caller is.

Proposals wait in the DB. `ask proposals list` shows them;
`ask proposals approve|reject <id>` decides. Approval calls `applyRevision`:
a new revision, decay reset, and cache invalidation always; when the body
changed, also re-chunk, re-embed, replace the chunk tree, and recompute
`metadata.contentHash`.

There is no review cron. A source whose changes should be seen by a human
before they land is not an adapter. It is a tool outside the engine that
watches the thing and proposes.

**An approved edit detaches a source-owned record.** When a proposal on a
record with `metadata.origin = "source"` is approved, the record becomes
`metadata.origin = "edited"` and keeps a link back to where it came from:
the source id, the `sourceRef`, and the baseline, which is its
`contentHash` from just before the edit (the hash of the upstream body).
Index updates to that record pause. A human change outranks upstream until
upstream changes.

Every index run that reads the record's file or page compares the upstream
hash with the baseline:

- Same as the baseline: nothing happens. Upstream has not moved, the edit
  stands.
- Different, and equal to the edited body's `contentHash`: upstream caught
  up. The record goes back to `origin = "source"` with no approval.
- Different otherwise: the index run writes a source proposal (`proposedBy`
  is the source) carrying the new upstream body.
- The file or page is gone upstream: the index run proposes removal. Nothing
  is deleted without approval.

A source proposal follows the normal approve/reject path, with two extra
rules. Approved: the record takes the upstream body and goes back to
`origin = "source"`, so index updates resume. Rejected: the record stays
edited and the baseline moves to the rejected upstream hash, so the index
proposes again only when upstream moves again. A newer source proposal
replaces a pending source proposal on the same record and leaves the
baseline alone until one is decided. It never replaces a pending human
proposal; it waits for the next index run.

The indexer finds records by `sourceRef` whatever their origin, so it never
creates a second record for a file an edited record links to, and pruning
only deletes `origin = "source"` records.

## Consequences

- Hand-curated and cited knowledge changes only with a human approval.
- Source-owned knowledge tracks upstream automatically. Upstream is the
  truth there; a proposal per file would never be reviewed.
- Review is one endpoint. The CLI and management MCP get it for free, and an
  integration that needs review (a chat relay, a feed watcher, an agent)
  lives outside the engine with its own credentials and its own vendor SDK.
- The engine cannot tell a good proposer from a bad one. The key's write
  scope is the only gate; the approver is the review.
- An approved edit to a source-owned record lasts until upstream changes.
  Then a human decides again. A record has one owner at a time, and the link
  back to its source means there is never a duplicate.
- Edited records are not stamped by index runs, so they decay
  ([0009](0009-decay-not-deletion.md)) and surface as `stale` for a human.

## Known gaps

The proposals path is built. Detaching edited records is not:

- Approving a proposal on a source-owned record leaves
  `metadata.origin = "source"` (`applyRevision` in
  `packages/core/src/knowledge.ts`), so the next index run that sees a
  changed file overwrites the edit. There is no `edited` origin, no
  baseline, no source proposal, no re-attach, and no proposed removal.

- Built: `proposeUpdate` (one pending per record), `listPendingProposals`,
  `approveProposal` via `applyRevision`, `rejectProposal`
  (`packages/core/src/proposals.ts`); `POST /v1/knowledge/:id/proposals`
  recording the key label as `proposedBy`
  (`apps/api/src/routes/knowledge.ts`); `GET /v1/proposals`,
  `POST /v1/proposals/:id/approve|reject` recording the key label as
  `decidedBy` (`apps/api/src/routes/admin.ts`); `ask proposals
  create|list|approve|reject` and their management MCP tools; the
  `update_proposals` table with `proposed_by`.
- One pending per record is a select then an insert in `proposeUpdate`
  (`packages/core/src/proposals.ts`), not a constraint. Two requests for
  the same record at the same moment can both insert.
- `knowledgeStatusEnum` still carries `proposed` ("exists only as a
  candidate, not yet approved", `packages/db/src/schema.ts`). Nothing writes
  it. It is a leftover of an engine that proposed new knowledge; proposals
  here only target existing records.
