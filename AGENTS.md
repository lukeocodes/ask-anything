# AGENTS.md

Read this before touching the repo. It is agent-agnostic; never add
harness-specific instructions here.

## What this is

`ask`: a grounded, cited knowledge Q&A engine exposed as an MCP server and a
REST API, managed by a CLI. Sources are adapters; two ship. There is no
architecture doc. The design and the reasons for it are in `docs/` as
Architecture Decision Records; the system diagram is in the root README.

## ADRs are the source of truth for "why"

Every decision that shapes this codebase has an ADR in `docs/`, numbered
`NNNN-short-title.md`, indexed in `docs/README.md`. Template: `docs/template.md`.

**Every change links back to an ADR. No exceptions.**

- Before you change behaviour, structure, a dependency, a boundary, a schema, a
  model, a deploy shape, or a default: find the ADR that covers it. Read it.
- If your change fits the ADR, cite it. Commit message and PR body carry
  `ADR-NNNN` on its own line. One line per ADR touched.
- If your change contradicts the ADR: before the first release, rewrite that
  ADR in place so it reads as the decision, then change the code to match,
  same commit, same number. After the first release, write a new ADR that
  supersedes it and flip the old one's status to `Superseded by [NNNN](...)`.
  The maintainer says which stage the repo is in; do not infer it.
- If no ADR covers it and the change is a decision (something a future reader
  would ask "why" about), write one first. Same commit.
- If no ADR covers it and it is not a decision (a typo, a bug fix inside the
  existing design), cite the ADR whose territory it is in. There is always one.
- A PR with no `ADR-NNNN` line is not mergeable.

Before the first release, ADRs are the current design, not a changelog, and
git history records what changed. After it, they are append-only and
superseding is how a decision changes. Either way, an ADR that no longer
describes the code is a bug in one of them, and the commit that notices it
fixes one of them.

## Layout

```
apps/api      Fastify API + cron jobs + hosted MCP (/mcp). The one deployable  (ADR-0002, 0012, 0015)
apps/mcp      public stdio MCP proxy to the API (ask, search)               (ADR-0012)
apps/cli      management CLI, binary `ask`, one command per REST endpoint  (ADR-0002)
apps/mgmt-mcp management MCP: one tool per CLI command, wraps the registry (ADR-0002)
packages/core chunk tree, retrieval, decay, sources, proposals, cache     (ADR-0004..0011, 0014, 0017, 0021..0025)
packages/ai   provider hub, model tiers                                    (ADR-0013)
packages/db   Drizzle schema + migrations, Postgres + pgvector             (ADR-0003) tables: packages/db/README.md
packages/mcp  transport-agnostic public MCP server factory                 (ADR-0012)
packages/sources  shipped adapters: git (public repos), url (sites)       (ADR-0020, 0024) adding one: packages/sources/README.md
packages/config  env schema, dotenv loader, logging, logdrain              (ADR-0016)
eval/         golden-set accuracy harness, `pnpm eval`                     (ADR-0001)
scripts/      operator scripts: warm-cache, probe-ask                      (ADR-0008)
docs/         ADRs                                                         (docs/README.md)
```

Surfaces are `api`, `cli`, `mcp`, `backfill`, `warm`.

## Working here

- Work in a worktree under `.claude/worktrees/`, `.opencode/worktrees/`, or
  `.agents/worktrees/`. Never in the project root unless told to.
- `pnpm install`, `pnpm typecheck`, `pnpm test` must pass. CI runs exactly
  those. Tests are vitest, `*.test.ts` next to the source, pure functions.
- No build step, no linter. `tsx` runs the sources. Do not add either without
  an ADR.
- Management goes through the CLI. If a thing cannot be done with `ask ...`,
  add the REST endpoint and the CLI command together, then the MCP tool
  appears on its own. Never add a management path that skips the CLI.
- Identity is `lukeocodes`. No co-author trailers, no agent names, anywhere.
