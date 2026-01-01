# 0011. Non-destructive index refresh

Date: 2026-01-01

## Status

Accepted

## Context

An index run that purges and recreates records resets `id`,
`baseConfidence`, `retrievalCount`, feedback, and history every time. Decay
and feedback would be meaningless.

## Decision

An index run refreshes each record in place via `refreshCanonical()`, keyed
on `(source_type, source_ref)` and gated on `metadata.contentHash`.

Unchanged bodies: stamp `lastVerifiedAt`, recover `stale` to `active`
(other statuses are kept), and refresh `metadata`, `tags`, `title`,
`summary`, `updatedAt`. `visibility` is not touched here; a source's
visibility change is pushed to its records by `updateSource`. No embedding
cost. Changed bodies: re-chunk into the tree
([0025](0025-chunks-are-a-tree.md)), re-embed, replace chunks, bump a
revision, invalidate cached answers.

`pruneSourceItems()` deletes source-owned rows of that source whose
`sourceRef` is not in this run's keep set. A run that saw nothing keeps
everything.

## Consequences

- Feedback, decay, and history survive every index run.
- Embedding cost per run scales with what changed.
- A record inserted by hand is never pruned by any source and has no
  automatic refresh.
