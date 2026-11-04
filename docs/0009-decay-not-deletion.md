# 0009. Knowledge decays; deletion only on upstream removal

Date: 2026-01-01

## Status

Accepted

## Context

Docs change. A chunk right in January may be wrong in June. Deleting on a
schedule loses history and feedback. Full confidence forever serves stale
answers.

## Decision

Each item carries `baseConfidence`, `decayRate`, `lastVerifiedAt`, and
`retrievalCount`. Effective confidence:

```
reinforce = 1 + ln(1 + retrievalCount)
lambdaEff = decayRate / reinforce
effective = baseConfidence * exp(-lambdaEff * ageDays)
```

`DECAY_CRON` (nightly) runs `runDecay`, which flips items below
`STALE_THRESHOLD` to `stale` and writes a `decay_events` row. Nothing else
happens on flip. `stale` is a label, not a queue: nothing re-reads stale
items first.

A source-owned item does not go stale while its source is indexed. Every
index run stamps `lastVerifiedAt` on every source-owned item it confirms
unchanged, and that includes a run the commit or page-hash gate skips
([0024](0024-sources-are-registered-records.md)). An unchanged `HEAD` or page
hash is a real upstream comparison: every file is the same. Edited items
([0010](0010-refresh-is-a-proposal.md)) are not stamped by an index run. They
decay like any hand-curated record, and `stale` on one tells a human to look.

What moves the numbers:

- Citation: `reinforce(id, {verify: false})`. Bumps `retrievalCount` only.
- `up`: `reinforce(id, {verify: false})`. Bumps `retrievalCount` only. A
  thumbs-up is popularity, not verification.
- `down`: `baseConfidence = max(0.1, baseConfidence * 0.85)`, plus cache
  invalidation.
- Refresh or re-verify: stamps `lastVerifiedAt`.

Deletion happens in one place: `pruneSourceItems()` after a source index
run, for source-owned items (`metadata.origin = "source"`) whose file or
page vanished upstream. An edited item whose file or page vanished is not
deleted. The index run proposes its removal instead
([0010](0010-refresh-is-a-proposal.md)).
Each deletion is logged with id, ref, and reason. Revisions, chunks, and decay
events cascade with the row.

## Consequences

- Heavily-used knowledge resists decay.
- Feedback survives refresh because it lives on the item row, not the body.
- `GET /v1/admin/knowledge-stats` exposes stale counts and age per source.

- Source-owned items decay only when their source stops being indexed.
  Intended.
- `stale` on an indexed source points at edited items, which is where a
  human is needed.

## Known gaps

- A run the commit or page-hash gate skips returns before reading any
  record (`index` in `packages/sources/src/git-public.ts` and
  `packages/sources/src/website.ts`), so nothing is stamped. A repo whose
  `HEAD` does not move goes `stale` while it is still indexed on schedule.
