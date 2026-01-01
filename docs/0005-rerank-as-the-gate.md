# 0005. Cross-encoder rerank is the answerability gate

Date: 2026-01-01

## Status

Accepted

## Context

Gating "can the index answer this" on decayed confidence let fresh,
off-topic chunks answer. Freshness is not relevance. Deciding when to hand
off to the searching agent is the accuracy lever.

## Decision

The pool is scored by a cross-encoder (`RERANK_PROVIDER`, default `voyage`,
model default `rerank-2.5-lite`, `RERANK_ENABLED` default `true`). The gate is
the top hit's rerank relevance against `RELEVANCE_ANSWER_THRESHOLD` AND a
freshness floor (`FASTPATH_MIN_CONFIDENCE`). Below the gate, the pool goes to
the agent, seeded with the ranked pool, which searches the index again with
different words.

`rerank()` returns `null` when no provider is configured or the 6,000 ms
timeout fires. On `null`, ranking degrades to a round-robin-by-source merge
and the gate falls back to the confidence floor. Every successful rerank call
records a `usage_events` row; a timeout or failure records nothing.

Up to two rerank calls per question: the index pass and the agent's numeric
abstain guard, plus one per agent search.

## Consequences

- Off-topic-but-fresh chunks hand off to the agent instead of answering.
