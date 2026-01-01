# 0006. Grounded-only answers; abstain by text, backstopped by rerank

Date: 2026-01-01

## Status

Accepted

## Context

This answers developer questions on behalf of a product. A confident wrong
answer costs more than no answer. LLMs will produce a fluent reply with no
grounding if asked to.

## Decision

The answer model composes only from retrieved chunks and cites inline.

A sufficient pool answers deterministically. An insufficient pool, including
an empty one, goes to the agent: a streamed run of up to six steps with one
tool, `search_knowledge_base`, that can reformulate and search the index
again. The agent abstains in text. If it abstains while a reranked-sufficient
chunk sits in its grounding, a deterministic answer runs instead.

Nothing outside the index is consulted at answer time. What is not indexed
does not exist (see [0020](0020-sources-seed-and-refresh.md)).

Abstain is forced on both paths when the answer cites nothing and there is no
caller context. The hedge phrase regex in `citations.ts` is a second signal
on the deterministic path.

Caller-context answers are exempt. With caller-supplied `context` present
the model may answer citing nothing; the conversation is not a citable
source.

An abstain on a real question (12+ characters, contains a word) from a human
surface emits `question.unanswered` (see
[0022](0022-gap-ledger-and-backfill.md)). A `PRIVATE_EGRESS_ALLOWED=false`
refusal is marked `refused` and does not.

## Consequences

- No answer is composed from nothing. The agent may search more, but it
  cannot cite what it did not retrieve.
- An empty pool is not free. It costs an embed, a cache lookup, a retrieval
  pass, and an agent run before the abstain. Rerank is skipped on an empty
  pool.
- Users sometimes get "I don't have that yet" where a chat model would guess.
  That is the point.
