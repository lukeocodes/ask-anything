# ask-anything

A retrieval engine that refuses to guess. Register git repos and URLs, public
or private. Every file is indexed into a chunk tree that follows the
document's own headings. Hybrid recall over Postgres, a cross-encoder rerank
as the gate, grounded and cited answers, and an index refreshed on a
schedule, on demand, or one record at a time.

```bash
ask sources add https://github.com/you/your-repo
ask sources add https://docs.example.com --crawl sitemap
ask "how do I configure the thing"
```

```
                 ┌──────────────────────────────────────────────┐
                 │                  API (apps/api)               │
   MCP / REST    │  ┌─────────┐   ┌──────────┐   ┌────────────┐  │
   clients ────▶ │  │ /mcp    │──▶│ @ask/core │──▶│ @ask/ai    │  │──▶ LLM / embeddings
                 │  │ /v1/ask │   │ retrieve  │   │ answer/    │  │    / rerank
   ask CLI ────▶ │  │ /v1/*   │   │ rerank    │   │ embed/cheap│  │
   mgmt MCP      │  └─────────┘   │ decay     │   └────────────┘  │
                 │  ┌───────────┐ │ proposals │──▶ @ask/db ──────┼──▶ Postgres
                 │  │  jobs     │ └─────┬─────┘   (pgvector)     │    + pgvector
                 │  │  (cron)   │──▶ @ask/sources ───────────────┼──▶ git remotes / URLs
                 │  └───────────┘   adapters: git, url (+ planned) │    sites
                 └──────────────────────────────────────────────┘
```

## What it does

- **Registered sources.** `ask sources add <repo or url>`. Public git
  repositories are cloned with plain `git`; URLs index a page or a whole
  sitemap. Source types are adapters behind one contract, so the next one
  (private repos, chat tools, wikis, feeds) is a package, not a rewrite.
- **Every file, as a tree.** Chunking is progressive by heading depth: a
  section that fits is one chunk; one that does not splits at the next
  heading level, down to paragraphs. Each chunk row stores its parent, depth,
  heading path, and position, so relatives are a join, not a re-parse.
- **Hybrid retrieval.** Vector (pgvector HNSW) and lexical (Postgres full
  text) recall over chunks, fused with Reciprocal Rank Fusion. Exact tokens
  and paraphrase both hit.
- **Rerank is the gate.** A cross-encoder scores each candidate's
  answerability. The top score, with a freshness floor, decides whether the
  index answers directly or hands off to an agent that searches the index
  again. No reranker configured: it degrades to a fair merge.
- **Grounded only.** Answers are composed from retrieved chunks and cited
  inline. Nothing to cite means an abstain, and the abstain is logged as a
  gap.
- **Living index.** Records carry confidence that decays with age since last
  verification and is reinforced by use and feedback. Nothing is deleted on a
  schedule.
- **Three ways to refresh.** Scheduled index runs, forced runs from the
  CLI, and per-record refresh on demand.
- **Human in the loop where it matters.** Each adapter declares its trust:
  upstream-trust records track their source automatically; review-trust
  changes become proposals you approve.
- **Public and private tiers.** Every record and every API key carries a
  visibility tier. The server caps requests to the key. Fail closed.
- **Semantic answer cache.** Repeat questions in the same tier return
  instantly with no model call.
- **Configurable models.** Answer, cheap-ops, embedding, and rerank models are
  env. Anthropic, Vertex, Voyage, OpenAI-compatible, or a local embeddings
  server.

## How a question is answered

1. Log the raw question. One insert, no model call.
2. Recall a pool from the index: vector plus full-text, fused, filtered to the
   caller's tier.
3. Rerank the pool. If the top hit clears the relevance threshold and the
   freshness floor, answer from it.
4. Otherwise an agent searches the index again with different words, seeded
   with what was found. It abstains if it cannot cite.
5. Store the answer, reinforce what it cited, cache it, record cost and
   latency.

Nothing outside the index is consulted at answer time. What is not indexed
does not exist.

The full reasoning is in [docs/](./docs/README.md), one decision per file.

## Sources

Sources are records, not config. Add one and it is indexed on its schedule.

```bash
ask sources add https://github.com/you/your-repo --branch main
ask sources add https://gitlab.com/group/project --include "docs/**,*.md"
ask sources add https://docs.example.com/guide            # one page
ask sources add https://docs.example.com --crawl sitemap  # the site
ask sources list
ask sources adapters
```

| Adapter | Locator | How | Scope |
|---|---|---|---|
| `git` | any public clone URL | `git clone --depth 1`, then fetch | public repositories only |
| `url` | a page, or a site via `--crawl sitemap` | `fetch`; HTML to Markdown, other text stored as is | same host, up to `INDEX_MAX_PAGES` |

Each source has a `visibility` tier, optional `branch`, `include` and
`exclude` globs, and an optional cron `schedule`. Records it produces belong
to it: they refresh in place and are pruned when the file or page is gone.

Every source type is a `SourceAdapter` ([ADR-0020](./docs/0020-sources-seed-and-refresh.md)):
`detect`, `describe`, `index`, `refresh`, optional `verify`, and a `trust`
level that decides whether changes land in place or as proposals for review.
The engine ships the two above and nothing else. Private repositories, org
enumeration, local folders, docs platforms, OpenAPI, help centres, feeds,
forums, wikis, and chat tools are planned adapters, laid out in that ADR.
Anything else goes in through `ask knowledge add`.

## Indexing

**What indexing does.** Clone or fetch. Stop if `HEAD` has not moved (git;
a single page stops on an unchanged content hash, a sitemap always walks).
List tracked files, apply the globs, skip binaries, empty and oversized
files. Chunk each file into its tree. Embed only what changed, by content
hash. Prune what vanished.

**Scheduled.** The scheduler ticks on `INDEX_CRON` (default every 15 min)
and runs every enabled source whose own `schedule`, or
`INDEX_DEFAULT_SCHEDULE` (default daily 04:00), is due.

| Job | Env | Default | Does |
|---|---|---|---|
| Index tick | `INDEX_CRON` | every 15 min | Run due sources |
| Verify | `MONITOR_CRON` | every 6h | Ask review-trust adapters about their records. Changes become proposals. No shipped adapter is review-trust yet. |
| Decay | `DECAY_CRON` | daily 03:00 | Recompute confidence. Below threshold flips to `stale`. |
| Backfill | `BACKFILL_CRON` | daily 05:00 | Re-ask logged gaps. Answerable ones close. |
| Warm cache | `WARM_CACHE_CRON` | every 4h | Re-ask the most-asked questions. |

**Forced.** Now, ignoring the commit and hash gates with `--force`:

```bash
ask sources index <id> --force
ask sources index-all
ask jobs run verify
ask jobs run decay
ask jobs run backfill
ask cache invalidate
```

**Per record.** One file or page, re-read from the clone or the site:

```bash
ask knowledge refresh <id>     # refreshed | unchanged | removed
ask knowledge chunks <id>      # the record's chunk tree
ask chunks context <chunkId>   # parent, siblings, children
```

**Reactive.** Any source-owned record cited in an answer that has not been
verified in `REVERIFY_AGE_HOURS` is refreshed in the background.

## Interfaces

**Public MCP.** Two tools, `ask` and `search`, over both spec transports.
Streamable HTTP at `/mcp` on the API (`POST`, plus `GET` and `DELETE` for
the session), unauthenticated and pinned to the public tier. Stdio via `apps/mcp`, a thin proxy that carries your API key and
therefore your tier.

```jsonc
{ "mcpServers": { "ask-anything": { "type": "http", "url": "https://<host>/mcp" } } }
```

**REST.** Static keys, `Authorization: Bearer <key>`, scopes `read`, `write`,
`admin`, tier `public` or `private`.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/v1/ask` | read | Grounded answer with citations |
| `POST` | `/v1/ask/stream` | read | Same over SSE: `step`, `delta`, `done`, `error` |
| `POST` | `/v1/search` | read | Ranked chunks, no synthesis |
| `POST` | `/v1/knowledge` | write | Insert a record |
| `GET` | `/v1/knowledge/:id` | read | Fetch a record |
| `POST` | `/v1/knowledge/:id/refresh` | write | Force-refresh one record |
| `GET` | `/v1/knowledge/:id/chunks` | read | A record's chunk tree |
| `GET` | `/v1/chunks/:id/context` | read | A chunk with parent, siblings, children |
| `GET` `POST` | `/v1/sources` | write | List or register sources (`config`, `credentialEnv` optional) |
| `GET` | `/v1/sources/adapters` | read | The registered adapters and their trust |
| `GET` `PATCH` `DELETE` | `/v1/sources/:id` | write / admin | Inspect, update, remove (`?purge=true`) |
| `POST` | `/v1/sources/:id/index` | admin | Index one source now (`{force}`) |
| `POST` | `/v1/sources/index-all` | admin | Index every enabled source |
| `POST` | `/v1/knowledge/:id/visibility` | write | Set tier, clear review |
| `GET` | `/v1/knowledge/reviews` | read | Records awaiting a tier decision |
| `GET` | `/v1/knowledge/gaps` | read | Unanswered questions |
| `POST` | `/v1/answers/:id/feedback` | read | up/down |
| `POST` | `/v1/answers/:id/feedback/comment` | read | Free-text feedback |
| `GET` | `/v1/proposals` | write | Pending proposals from review-trust adapters |
| `POST` | `/v1/proposals/:id/approve` | write | Apply a proposal |
| `POST` | `/v1/proposals/:id/reject` | write | Discard a proposal |
| `GET` | `/v1/questions/top` | read | Most-asked questions |
| `GET` | `/v1/events` | read | Domain events over SSE |
| `GET` | `/v1/admin/stats` | admin | 24h latency, cache hit rate, cost |
| `GET` | `/v1/admin/knowledge-stats` | admin | Record and stale counts, age per source |
| `POST` | `/v1/admin/run-verify`, `run-decay`, `run-backfill` | admin | Force a job |
| `POST` | `/v1/admin/invalidate-cache` | admin | Flush the answer cache |
| `GET` | `/health` | none | Liveness |

**CLI.** `ask` is the management tool. One command per endpoint, `--json`
for machines.

```bash
ask sources add <locator>            ask sources list         ask sources index <id> --force
ask "how do I configure retries"    ask stream "..."         ask search "rate limits"
ask knowledge add --file notes.md    ask knowledge add --title T --body B
ask knowledge refresh <id>           ask knowledge chunks <id>
ask knowledge reviews                ask knowledge gaps
ask proposals list                   ask proposals approve <id>
ask feedback <answerId> down --comment "wrong version"
ask questions top                    ask stats                ask stats knowledge
ask jobs run verify                  ask events tail          ask health
```

**Management MCP.** `apps/mgmt-mcp` exposes one tool per CLI command,
generated from the CLI's registry at startup. It has no logic of its own. Give
an agent the same controls an operator has.

```jsonc
{ "mcpServers": { "ask-anything-admin": {
    "command": "pnpm", "args": ["--filter", "@ask/mgmt-mcp", "start"],
    "env": { "ASK_API_URL": "https://<host>", "ASK_API_KEY": "<admin key>" } } } }
```

## Quick start

```bash
pnpm install
docker compose up -d                 # Postgres with pgvector
cp .env.example .env                 # keys and models
pnpm db:migrate
pnpm start                           # API + jobs + hosted MCP on :3000

ask health
ask sources add https://github.com/you/your-repo
ask sources index <id>
ask "what does this repo do"
```

`ASK_API_URL` and `ASK_API_KEY` in the env point the CLI and the MCP proxies
at the API.

## Configuration

Everything is env. `.env.example` documents every variable with its default.
The ones that shape behaviour:

| Area | Variables |
|---|---|
| Identity | `ASK_NAME`, `ASK_DESCRIPTION` |
| Models | `LLM_PROVIDER`, `ASK_ANSWER_MODEL`, `ASK_CHEAP_MODEL`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_MODEL`, `EMBEDDING_DIM` |
| Rerank gate | `RERANK_ENABLED`, `RERANK_PROVIDER`, `RERANK_MODEL`, `RELEVANCE_ANSWER_THRESHOLD`, `FASTPATH_MIN_CONFIDENCE`, `RERANK_POOL_FACTOR` |
| Cache | `CACHE_ENABLED`, `CACHE_SIMILARITY`, `CACHE_TTL_HOURS` |
| Indexing | `ASK_WORKDIR`, `INDEX_CRON`, `INDEX_DEFAULT_SCHEDULE`, `INDEX_MAX_FILE_KB`, `INDEX_MAX_PAGES` |
| Freshness | `REVERIFY_AGE_HOURS`, the `*_CRON` jobs |
| Access | `API_KEYS` (`key:label:scope:visibility`), `RATE_LIMIT_PER_MINUTE`, `DAILY_COST_CAP_USD`, `PRIVATE_EGRESS_ALLOWED` |
| Telemetry | `LOGDRAIN_URL`, `LOGDRAIN_TOKEN` |

`EMBEDDING_DIM` must match the embedding model and the migrated column. The
API refuses to start if it does not.

## Layout

```
apps/
  api/            Fastify API, cron jobs, hosted MCP. The one deployable.
  mcp/            public stdio MCP proxy (ask, search)
  cli/            management CLI, binary `ask`
  mgmt-mcp/       management MCP, one tool per CLI command
packages/
  core/           adapter contract, chunk tree, retrieval, rerank gate, decay, sources, proposals, cache, events, telemetry
  ai/             provider hub, model tiers, citations
  db/             Drizzle schema and migrations (Postgres + pgvector)
  mcp/            transport-agnostic public MCP server factory
  sources/        the shipped adapters: git (public repos), url (sites)
  config/         env, logging, logdrain
docs/             Architecture Decision Records
eval/             golden-set accuracy harness (`pnpm eval`)
```

## Deploying

One process, one instance, one Postgres. [DEPLOY.md](./DEPLOY.md) walks
through Cloud Run and Cloud SQL; anything that runs a Node process and a
Postgres with `vector` works.

## Contributing

Every change cites an Architecture Decision Record. Read
[AGENTS.md](./AGENTS.md) first, then [docs/](./docs/README.md).

```bash
pnpm typecheck
pnpm test
```

## License

MIT. See [LICENSE](./LICENSE).
