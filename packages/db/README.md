# @ask/db

Postgres + pgvector schema and client, via Drizzle. Migrations are append-only
SQL under `drizzle/`; `db:push` exists for local iteration and bypasses them.
Why one store: [ADR-0003](../../docs/0003-postgres-pgvector-single-store.md).

| Table | Purpose |
|---|---|
| `knowledge_sources` | Registered sources ([ADR-0024](../../docs/0024-sources-are-registered-records.md)): adapter kind, locator, provider hint, name, visibility, branch, include/exclude globs, crawl mode, schedule, enabled, status, last indexed, last commit, last error, item count, non-secret `config`, `credential_env` (name of the env var holding a secret) |
| `knowledge_items` | The living knowledge base: body, a representative embedding (the first non-empty chunk's; written for convenience, not queried), decay params, visibility, status |
| `knowledge_chunks` | The chunk tree per item ([ADR-0025](../../docs/0025-chunks-are-a-tree.md)): `parent_id` (self FK, cascade), `depth`, `heading`, `heading_path`, `path`, `kind`, line range, body, embedding. Retrieval's HNSW and FTS GIN indexes are here |
| `knowledge_revisions` | Append-only history per item: revision 1 at ingest, then one per refresh or approved proposal. No rollback code exists |
| `questions` | Canonical, clustered questions with `askCount` |
| `question_events` | Each raw occurrence (who / where / surface) |
| `answers` | Generated answers with provenance, tier, and token usage |
| `feedback` | up/down and comments per answer |
| `answer_cache` | Semantic answer cache, tier-exact, per-entry TTL |
| `usage_events` | Telemetry: recorded model and job actions |
| `update_proposals` | Changes proposed by review-trust adapters, awaiting operator approval |
| `decay_events` | Decay recomputation audit trail |
| `events` | Domain event log; `pg_notify` rides on top |

The Drizzle column width reads `EMBEDDING_DIM` at schema load (default 1024)
and migration `0000` fixes the migrated width. `assertEmbeddingDim()` runs
at API startup and refuses to serve on a mismatch. Changing the model
dimension means a new migration and a full re-embed.

```bash
pnpm db:generate   # SQL from the schema
pnpm db:migrate
```
