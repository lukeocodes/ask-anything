# @ask/sources

The shipped `SourceAdapter`s. The contract lives in core
(`packages/core/src/source-adapter.ts`); core never imports this package.
Decided in [ADR-0020](../../docs/0020-sources-seed-and-refresh.md).

| Adapter | File | Trust | Does |
|---|---|---|---|
| `git` | `src/git-public.ts` | upstream | Public repositories with plain `git`: shallow clone, fetch, `HEAD` compare, `git ls-files`, globs, binary and size skip, hash-gated refresh, prune. |
| `url` | `src/website.ts` | upstream | One page, or a sitemap (one level of sitemap index), same host, HTML to Markdown, hash-gated refresh, prune. |

`registerBuiltinAdapters()` in `src/index.ts` registers both at API startup.

## Adding an adapter

1. Export one object implementing `SourceAdapter`: `kind`, `trust`,
   `detect(locator)`, `describe(locator)`, `index(ctx, {force})`,
   `refresh(item, ctx)`, and `verify(item, ctx)` if `trust` is `review`.
2. Persist only through `ctx.persistence` (`refresh`, `prune`, `remove`,
   `registerSource`). Import `@ask/db` for types only, never for queries.
   Read non-secret settings from `ctx.config` and a credential from
   `ctx.secret` (the env var named by the source's `credentialEnv`).
3. Set `sourceRef` to `${source.id}:${stable path or url}` and put whatever
   `refresh` needs to find the thing again in `metadata`.
4. Register it in `src/index.ts` (`registerAdapter(a, { before: "git" })`
   if it must win detection over the general git adapter). `sourceType` is
   text, so no migration. The CLI, REST, scheduler, and management MCP pick
   it up from the registry; `ask sources adapters` lists it.
5. Write its ADR and cite it in the commit. Planned adapters and their trust
   levels are laid out in ADR-0020.
