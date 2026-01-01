# 0020. Sources are adapters behind one contract

Date: 2026-01-01

## Status

Accepted

## Context

Every place knowledge can come from has its own authentication, its own
change detection, and its own idea of what a record is. If each one is wired
straight into the engine, the engine's pipeline, prompts, schema, and config
all grow a vendor's shape, and the second integration copies the first one's
mistakes. A docs vendor's search API ends up being "the docs tier"; a chat
tool's thread becomes "the context"; a token for one host becomes an env var
everyone has to set.

## Decision

The engine knows one thing about sources: the `SourceAdapter` contract in
`packages/core/src/source-adapter.ts`. Core never imports an adapter.

```ts
interface SourceAdapter {
  kind: string;                       // "git", "url", ...
  trust: "upstream" | "review";       // refresh in place, or propose for review
  providers?: string[];               // hints for the adapters listing
  detect(locator): boolean;           // can this adapter take this locator
  describe(locator): { provider, name };
  index(ctx, { force }): IndexResult; // clone/fetch, list, hash-gate, prune
  refresh(item, ctx): "refreshed" | "unchanged" | "removed";
  verify?(item, ctx): UpdateCandidate | null;   // review-trust adapters only
}
```

Adapters register at startup (`registerBuiltinAdapters()` in
`packages/sources`). Resolution is first `detect` wins in registration
order; `registerAdapter(a, { before })` lets a more specific adapter go
ahead of a general one, and `--kind` on `sources add` overrides detection.
Core stores the adapter's `kind` on the source row and on every record it
produces (`sourceType` is text, not an enum, so a new kind needs no
migration), and dispatches `index`, `refresh`, and `verify` through the
registry.

Adapters receive an `IndexContext`: the source row, `ctx.config` (the
source's non-secret JSON config), `ctx.secret` (the value of the env var
named by the source's `credentialEnv`, resolved at run time, never stored
or logged), limits from env, a logger, and a `SourcePersistence` seam
(`refresh`, `prune`, `remove`, `registerSource`). They never touch the
database directly.

**Two adapters ship.** Both are `trust: "upstream"`:

- `git`: public repositories, cloned with plain `git`. See
  [0024](0024-sources-are-registered-records.md).
- `url`: a page or a sitemap, HTML converted to Markdown.

**Nothing else is wired in.** There is no live retrieval at answer time, no
vendor search API in the pipeline, no chat tool, no feed poller. The engine
answers from its own index ([0006](0006-grounded-only-answers.md)). What is
not indexed does not exist.

Records entering through `POST /v1/knowledge` have `sourceType: "api"` or
`"manual"`, no adapter, and no automatic refresh.

## Planned adapters

Each is a package exporting one `SourceAdapter`, registered in
`packages/sources/src/index.ts`, with its own ADR when it lands. The contract
already covers them; nothing in core changes.

| Adapter | Locator | Trust | Notes |
|---|---|---|---|
| Private git | same as `git`, registered `before: "git"` or chosen with `--kind` | upstream | Credentials via `credentialEnv` (a token the host already issued), the SSH agent, a deploy key, or a host app installation. Never a token on argv or in a row. Visibility defaults to `private`. |
| Git host organisation | `org:<name>` | upstream | Enumerates repositories via the host API and calls `registerSource` for each, as a `git` source. |
| Local filesystem | `file:///path` | upstream | Same walker as `git` without the clone. Dev and air-gapped use. |
| OpenAPI | spec URL | upstream | One record per operation, heading path from tags. |
| Documentation platforms | site URL | upstream | Docusaurus, GitBook, Mintlify, ReadMe, and the like. Most are the `url` adapter with a sitemap; a dedicated adapter only when the platform exposes structure the HTML loses. |
| Help centres | site URL | upstream | Usually the `url` adapter is enough. |
| Feeds (RSS, Atom) | feed URL | review | Entries as records; the feed is the change detector. |
| Forums and discussions | forum URL | review | Threads as records, accepted answers weighted. |
| Wikis and drives | space, database, or folder id | review | OAuth per deployment; the token lives in the env var named by `credentialEnv`. Page tree maps directly onto the chunk tree. |
| Chat tools | `chat://<workspace>/<channel>` | review | Messages are conversational and volatile; changes go through proposals. |

The `review` trust level exists for these: the adapter's `verify` returns an
`UpdateCandidate`, the engine writes an `update_proposal`, and an operator
approves it ([0010](0010-refresh-is-a-proposal.md)).

## Consequences

- Adding a source type is one package and one registration. The pipeline,
  prompts, schema, CLI, and MCP do not change.
- The answer path has one retrieval, the index. Latency and cost are
  predictable; there is no fan-out to third parties on the critical path.
- Freshness is the adapter's job, on its schedule. A source that is not
  indexed yet answers nothing, which is honest.
- `trust` is the only policy knob core knows about. Everything else about a
  source is the adapter's business.
