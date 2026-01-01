# 0008. Tier-exact semantic answer cache

Date: 2026-01-01

## Status

Accepted

## Context

Questions repeat, phrased twenty ways. Each costs retrieval, rerank,
and an answer-model call.

## Decision

Each answer is stored with its question embedding. A new question is embedded
(one embeddings call), the nearest live entry in the same tier is fetched, and
the similarity is thresholded against `CACHE_SIMILARITY` in application code.
A hit returns the stored answer with no LLM call.

TTL is `CACHE_TTL_HOURS` (default 24).

The cache is skipped when `context` is present (conversation questions).

Each entry stores the `answerId` it came from. A `down` evicts that entry
directly and every entry citing the same DB items. An item change evicts by
item.

`WARM_CACHE_CRON` (default every 4 hours) re-asks the top 30 clustered
questions at public tier to keep entries warm.

The cache stores canonical Markdown. Surface formatting happens after.

## Consequences

- Repeat questions skip the model. Biggest cost lever, independent of model
  choice.
- A private-derived answer can never be served publicly. Lookups are
  tier-exact.
- A question with caller-supplied context never hits the cache.
- Every probe costs one embeddings call, which is also an egress.
