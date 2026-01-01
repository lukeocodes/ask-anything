# 0002. The CLI is the only management surface

Date: 2026-01-01

## Status

Accepted

## Context

A chat bot as the management surface is a second product: streaming,
feedback buttons, modals, approval buttons, a manifest, several tokens, a
socket, and a singleton renderer that forces single-instance deploys. Every
management action then has a chat rendering and a REST endpoint, and the two
drift. The consumers that matter are MCP clients, and the operators are
people at a terminal or an agent with tools.

## Decision

**The CLI is the only management tool.** `apps/cli` (`@ask/cli`, binary
`ask`) is a typed command registry over the REST API: one command per
endpoint, `--json` for machines, a compact rendering for people. It sends
`surface: "cli"`.

**A management MCP wraps the CLI and nothing else.** `apps/mgmt-mcp`
(`@ask/mgmt-mcp`) is a stdio MCP server that generates one tool per registry
command at startup, with the input schema derived from the command's zod
schema, and executes by calling the registry. It has no logic of its own and
no direct API calls. Streaming-only commands (`ask stream`, `events tail`)
are not exposed. It sends `surface: "mcp"`.

**There is no chat surface.** Chat tools are sources at most, through an
adapter ([0020](0020-sources-seed-and-refresh.md)), never a place the engine
posts to or answers in.

The public MCP (`packages/mcp`, `ask` and `search`) is unchanged. Two MCP
servers, two audiences: the public one for asking, the management one for
operating.

Surfaces are `api`, `cli`, `mcp`, `backfill`, `warm`.

## Consequences

- One deployable: `@ask/api` (API, jobs, hosted MCP). The single-instance
  constraint in [0015](0015-single-process-single-instance.md) exists only
  for cron.
- The REST API is the whole management contract. A capability without an
  endpoint does not exist in the CLI or the MCP. That is the point.
- The CLI and the management MCP cannot drift: the MCP has exactly the
  commands the registry has.
- Nobody is notified of anything. Proposals, reviews, and gaps are pulled
  (`ask proposals list`, `ask knowledge reviews`, `ask knowledge gaps`,
  `ask events tail`), not pushed. Push, if wanted, is a consumer of
  `/v1/events`, decided in its own ADR.
- Feedback is `ask feedback <answerId> up|down [--comment]` (see
  [0019](0019-feedback-through-the-api-and-cli.md)).
