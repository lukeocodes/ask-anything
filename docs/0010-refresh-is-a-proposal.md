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

## Consequences

- Hand-curated and cited knowledge changes only with a human approval.
- Source-owned knowledge tracks upstream automatically. Upstream is the
  truth there; a proposal per file would never be reviewed.
- Review is one endpoint. The CLI and management MCP get it for free, and an
  integration that needs review (a chat relay, a feed watcher, an agent)
  lives outside the engine with its own credentials and its own vendor SDK.
- The engine cannot tell a good proposer from a bad one. The key's write
  scope is the only gate; the approver is the review.
- An approved edit to a source-owned record lasts until the next index run,
  which restores upstream.

## Known gaps

Partially built. The store and the decision side are done; the way in is
not, and the earlier adapter-side shape is still in the code.

- Built: `proposeUpdate` (one pending per record), `listPendingProposals`,
  `approveProposal` via `applyRevision`, `rejectProposal`
  (`packages/core/src/proposals.ts`); `GET /v1/proposals`,
  `POST /v1/proposals/:id/approve|reject` recording the key label as
  `decidedBy` (`apps/api/src/routes/admin.ts`); `ask proposals
  list|approve|reject` and their management MCP tools; the
  `update_proposals` table.
- Missing: `POST /v1/knowledge/:id/proposals`, `ask proposals create <id>`,
  and a `proposed_by` column. `proposeUpdate` is reachable only from the
  verify tick, which no shipped adapter feeds.
- To remove: `trust` and `verify` on `SourceAdapter`
  (`packages/core/src/source-adapter.ts`), the verify tick
  (`apps/api/src/jobs/monitor.ts`, `MONITOR_CRON`,
  `POST /v1/admin/run-verify`, `ask jobs run verify`), and the `verify`
  branch in the reverify sink. The root README, `.env.example`, and
  `packages/sources/README.md` describe that code until it goes.
