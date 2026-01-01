# 0023. Usage telemetry on billable steps

Date: 2026-01-01

## Status

Accepted

## Context

Model calls happen on several paths. Without per-step accounting there is no
way to see cost, enforce a cap, or notice a latency regression.

## Decision

`recordUsage` writes a `usage_events` row: kind, surface, actor, model,
tokens, estimated cost, latency, metadata. The DB is the source of truth. If
`LOGDRAIN_URL` is set, a copy ships there.

Recorded kinds: `answer`, `answer_cache_hit`, `cheap_op`, `embed` (query,
clustering, ingest, refresh, revision), `rerank`, `ingest`, `watch`,
`feedback`. Latency is recorded on the answer path only. Backfill and
warm-cache asks record with `surface: "backfill"` or `"warm"`.

Cost comes from the rate table in `models.ts`. `costSpentTodayUsd` sums
today's rows with the day computed in UTC; `costCapGuard` memoises it for
30 s. `usage_events.created_at` is indexed.

`GET /v1/admin/stats` (24h p95 latency, cache hit rate, cost, tokens) and
`GET /v1/admin/knowledge-stats` (item and stale counts, age per source)
require `admin` scope.

## Consequences

- Cost and latency are queryable per kind, surface, and model.
- Cap and stats read the same table.
- A model id missing from the rate table logs one warning, yields no cost,
  and is invisible to the cap. Add it to the table.
- The cap can lag real spend by up to 30 s.
