# 0003. Postgres + pgvector as the single store

Date: 2026-01-01

## Status

Accepted

## Context

Retrieval needs vector search. Everything else is relational. A dedicated
vector DB is a second system to run and keep consistent.

## Decision

One Postgres with the `vector` extension. Schema and migrations are Drizzle
(`packages/db`), append-only SQL under `drizzle/`. `db:push` exists for local
iteration and bypasses migration files.

Retrieval vectors live on `knowledge_chunks.embedding` under an HNSW index.
`knowledge_items.embedding` holds a representative vector written at ingest
and is never queried. Lexical search is an expression GIN index over
`to_tsvector('english', knowledge_chunks.body)`.

The Drizzle column width is read from `EMBEDDING_DIM` at schema load (default
1024). `assertEmbeddingDim()` runs at API startup and refuses to serve if the
migrated column width differs. Changing the model dimension means a new
migration and a full re-embed.

`ingest()` writes item, chunks, and first revision in one transaction. Vector
queries order by `embedding <=> query` ascending so the HNSW index is usable;
similarity is derived afterwards for scoring.

## Consequences

- One connection string, one backup, one thing to run. Cloud SQL hosts it.
- Hybrid retrieval is two parallel queries against one database, fused in
  application code (see [0004](0004-hybrid-retrieval-rrf.md)).
- Vector scale is bounded by one pgvector instance. Fine for this corpus.
