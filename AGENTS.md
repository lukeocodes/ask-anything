# AGENTS.md

Read this before touching the repo. It is agent-agnostic; never add
harness-specific instructions here.

## What this is

`ask`: a grounded, cited knowledge Q&A engine exposed as an MCP server and a
REST API, managed by a CLI. Goals, in order, are in `docs/goals.md`. Sources are adapters; two ship. There is no
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
cao/          scheduler profile, flows, and guard for the daily run        (ADR-0026)
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

## Daily run

A scheduler runs an agent here once a day, two turns: work, then
housekeeping (ADR-0026, files in `cao/`). The agent reads this section and
`docs/goals.md`. Nothing below applies to a human.

**State is git and GitHub.** You remember nothing between turns. Start every
turn the same way:

```bash
gh pr list --repo lukeocodes/ask-anything --state open --label daily --json number,url,headRefName,isDraft,labels
```

- One open PR labelled `daily` without `needs-decision`: that is your work.
  Check its branch out as a worktree under `.agents/worktrees/<branch>` and
  read its body for the stage you are at.
- None: take the first item in the Queue of `docs/goals.md`, branch
  `daily/<short-slug>` from `main`, open a draft PR labelled `daily` with
  the stage checklist below, and start at stage 1.
- Only PRs labelled `needs-decision`: start the next goal that no open PR
  covers. Never touch a `needs-decision` PR.

**Stages.** The PR body is this checklist. Tick a box in the commit that
completes it; keep the notes under each box current.

```
- [ ] 1 Ideation: the goal, the ADR line it closes, why it is next, what "done" is
- [ ] 2 Plan: files, what could go wrong, how it is verified
- [ ] 3 Build
- [ ] 4 Verify: pnpm typecheck, pnpm test, CI green, pnpm eval if retrieval or answering changed
- [ ] 5 Adversarial review: a fresh read of the whole diff against the ADR as a hostile reviewer; what it found, what was fixed
- [ ] 6 Ready: ADR Known gaps and docs/goals.md updated, body final, marked ready, @lukeocodes mentioned
```

**Work turn.** Advance the PR by at least one stage. Stop at a clean point:
code compiles, tests pass, or the broken state is described in the body.
Do not start stage 3 until stages 1 and 2 are in the body.

**Housekeeping turn.** Commit anything uncommitted (`ADR-NNNN` lines, no
trailers), push, make sure the draft PR exists and its body matches the
branch, wait for CI. If stage 5 is ticked: remove the Known gaps lines the PR
closes, update `docs/goals.md`, tick 6, `gh pr ready`, comment
`@lukeocodes ready for review`. Otherwise leave it draft.

**No decisions.** The Decision section of every ADR is read-only to you.
You may remove a Known gaps line you fixed and add one you found, with the
file. If the work needs a choice no ADR settles, the ADRs disagree with each
other, or `docs/goals.md` asks for something an ADR forbids: stop, write the
choice and the options in the PR body under `## Needs a decision`, add the
`needs-decision` label, comment `@lukeocodes`, and end the turn. The
maintainer decides and tells you separately.

**Never:** merge, push to `main`, force-push, edit a PR you did not open,
rewrite an ADR Decision, add a goal to `docs/goals.md`, open a second
`daily` PR, or work outside the worktree.
