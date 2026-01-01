# 0017. Question logging off the critical path

Date: 2026-01-01

## Status

Accepted

## Context

Operators want "N users asked this". That needs normalisation and clustering,
which cost a cheap-model call and an embedding. Doing it before answering adds
latency to every question.

## Decision

`logQuestionEvent` is awaited first in `prepareContext`: one `question_events`
insert, no model call. `clusterQuestionEvent` is fired inside `finalize()`
without being awaited, errors swallowed. It embeds the normalised question,
fetches the single nearest canonical `questions` row, and clusters when
similarity is at or above 0.9, bumping `askCount`.

## Consequences

- Answer latency carries one insert, nothing model-bound.
- Every occurrence is captured even if clustering fails later.
- Clusters are eventually consistent.
- Machine surfaces (`backfill`, `warm`) skip clustering, so `askCount` counts
  people.
