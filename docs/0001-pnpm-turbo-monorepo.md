# 0001. pnpm + turbo TypeScript monorepo

Date: 2026-01-01

## Status

Accepted

## Context

Several deployables (API, stdio MCP proxy, CLI, management MCP) share domain
code. Publishing packages to a registry for one consumer slows
every change.

## Decision

One repo. `pnpm` workspaces, `turbo` for task orchestration, Node 22,
TypeScript everywhere. Apps in `apps/`, shared code in `packages/`, all scoped
`@ask/*`. pnpm version pinned only in `package.json` `packageManager`.

No build output and no `build` script. `tsx` runs the sources in dev and in
the Docker image. There is no linter.

CI runs `pnpm install --frozen-lockfile`, `typecheck` (turbo, per package),
and `test` (one root `vitest run` over `**/*.test.ts`).

The accuracy gate is `pnpm eval` over `eval/golden.jsonl`, run by hand. It
needs a database and provider keys, so it is not in CI.

## Consequences

- One lockfile, one install, cross-package changes in one commit.
- Dev dependencies ship in the production image because `tsx` is one.
- `pnpm/action-setup` must not set `version:` alongside `packageManager`.

## Known gaps

- `turbo run typecheck` is per package, and `scripts/` and `eval/` are not
  packages, so nothing type-checks them. `scripts/probe-ask.ts`,
  `scripts/warm-cache.ts` and `eval/run.ts` are run by `tsx` and checked by no
  CI step. There is no root `tsconfig.json` and the root has no `@ask/*`
  dependency, so a root-level check would not resolve their imports as written.
