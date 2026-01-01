# 0010. Trust decides: refresh in place, or propose for review

Date: 2026-01-01

## Status

Accepted

## Context

Letting an automated process rewrite canonical knowledge means a bad upstream
edit or a misparsed page silently replaces a good answer. But indexing a
registered repo produces thousands of records; a human cannot approve each
one, and the repo is already the truth.

## Decision

Two refresh paths with different trust:

Each adapter declares a `trust` level ([0020](0020-sources-seed-and-refresh.md)).

**`review` adapters** (`MONITOR_CRON`, default every 6 hours). For each
`active` or `stale` record owned by a review-trust source, the adapter's
`verify` runs. A change becomes an `update_proposal` with status `pending`,
deduplicated against existing pending proposals. Proposals wait in the DB;
`ask proposals list` shows them and `ask proposals approve|reject` acts.
Approval calls `applyRevision`: a new revision, decay reset, and cache
invalidation always; when the body changed, also re-chunk, re-embed, replace
the chunk tree, and recompute `metadata.contentHash`. No shipped adapter is
review-trust yet; the tick no-ops until one is.

**`upstream` adapters** (both shipped ones). An index run stamps every
record `metadata.origin = "source"` and `refreshCanonical` rewrites changed
bodies in place, re-embeds, replaces chunks, and writes a revision. No
proposal, no approval. The verify tick skips them.

## Consequences

- Hand-curated and cited knowledge changes only with a human approval.
- Source-owned knowledge tracks upstream automatically. Upstream is the
  truth there; a proposal per file would never be reviewed.
- Coverage grows through registered sources and the write API.
- An approved edit to a source-owned record lasts until the next index run,
  which restores upstream. Upstream is the truth for source-owned records.
