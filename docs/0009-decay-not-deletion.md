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
happens on flip; the verify tick selects `active` and `stale` items alike.

What moves the numbers:

- Citation: `reinforce(id, {verify: false})`. Bumps `retrievalCount` only.
- `up`: `reinforce(id, {verify: false})`. Bumps `retrievalCount` only. A
  thumbs-up is popularity, not verification.
- `down`: `baseConfidence = max(0.1, baseConfidence * 0.85)`, plus cache
  invalidation.
- Refresh or re-verify: stamps `lastVerifiedAt`.

Deletion happens in one place: `pruneSourceItems()` after a source index
run, for source-owned items (`metadata.origin = "source"`) whose file or
page vanished upstream.
Each deletion is logged with id, ref, and reason. Revisions, chunks, and decay
events cascade with the row.

## Consequences

- Heavily-used knowledge resists decay.
- Feedback survives refresh because it lives on the item row, not the body.
- `GET /v1/admin/knowledge-stats` exposes stale counts and age per source.

- A source index run stamps `lastVerifiedAt` on every unchanged item. That
  is a real upstream comparison, so source-owned items decay only when their
  source stops being indexed. Intended.

## Known gaps

- `stale` is a label, not a queue. Scheduled indexing and the verify tick
  take records in no particular order, so stale items are no likelier to be
  checked first.
