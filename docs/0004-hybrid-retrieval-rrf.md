# 0004. Hybrid retrieval: vector + FTS fused with RRF

Date: 2026-01-01

## Status

Accepted

## Context

Developer questions mix semantics with exact tokens (error codes, method
names, flags). Vector search misses exact tokens. Lexical search misses
paraphrase.

## Decision

Each retrieval issues two SQL queries in parallel over `knowledge_chunks`
joined to `knowledge_items`, restricted to chunks with an embedding and, for
public callers, to public items: a pgvector cosine query and a Postgres FTS
query. Results are fused in application code
with Reciprocal Rank Fusion (`k = 60`, hardcoded), collapsed to one best
chunk per item, and scored `rrf * (0.5 + 0.5 * effectiveConfidence)`.

Over-fetch is layered: `gatherPool` asks for `limit * RERANK_POOL_FACTOR`,
and `retrieveFromDb` multiplies by 4 again internally.

`ask` and `search` share `gatherPool -> fuseAndRank`. Only `ask` applies
`isSufficient`. Both read the index and nothing else.

## Consequences

- Exact identifiers and paraphrase both hit.
- The confidence term decides which items reach the pool. `rankChunks` then
  orders purely by rerank relevance, or by a round-robin over sources when
  no reranker scored, so decay and feedback shape pool membership, not final
  order.
- At defaults the DB pass fetches 128 rows per list before fusion.
- Fusion tuning is one constant in `retrieval.ts`, not env.
