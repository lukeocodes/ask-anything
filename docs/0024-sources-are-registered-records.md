# 0024. Sources are registered records; repos are cloned with native git

Date: 2026-01-01

## Status

Accepted

## Context

An engine whose sources are env variables can index what its operator
hardcoded at deploy time and nothing else. Adding a repo is a redeploy.
Provider APIs (tarballs, tree listings) differ per host and miss what `git`
already does: clone shallowly, fetch incrementally, list tracked files, and
say in one hash whether anything changed.

## Decision

A source is a row in `knowledge_sources`, created and managed through the
API and the CLI (`ask sources add <locator>`). The row carries the adapter
`kind` ([0020](0020-sources-seed-and-refresh.md)), `locator`, `provider`
hint, `name`, `visibility`, optional `branch`, `include` and `exclude`
globs, optional `crawl` mode for sites, optional per-source cron `schedule`,
`enabled`, `status`, `lastIndexedAt`, `lastCommit`, `lastError`, `itemCount`,
non-secret `config`, and `credentialEnv` (the name of an env var holding a
secret the adapter may need; the value is never stored).

The `git` adapter handles **public repositories** with plain `git`: `git
clone --depth 1 [--branch]` into `ASK_WORKDIR/sources/<id>`, then `git
fetch` and `reset --hard FETCH_HEAD` on later runs. No tokens, no host CLIs,
no credential handling. A clone that needs authentication fails with a
message saying so. Private repositories are a planned adapter.

The `url` adapter handles a page, or a site via its sitemap
(`--crawl sitemap`), same host only, capped at `INDEX_MAX_PAGES`.

Records a source produces carry `source_id`, `sourceType` equal to the
adapter kind, `sourceRef` `<sourceId>:<path|url>`, and `metadata.origin =
"source"`. The source owns them: refreshed in place, pruned when the file or
page is gone, never proposed.

Indexing a git source: clone or fetch, compare `HEAD` to `lastCommit` and
stop if equal, list files with `git ls-files`, apply globs, skip binaries
and files over `INDEX_MAX_FILE_KB`, ingest each text file through the
content-hash gate. Every text file is indexed, not only Markdown. Chunking
is [0025](0025-chunks-are-a-tree.md).

Three ways to run it: the scheduler ticks `INDEX_CRON` and runs sources
whose own schedule (or `INDEX_DEFAULT_SCHEDULE`) is due; `ask sources index
<id> [--force]` runs one now, `--force` ignoring the commit and hash gates;
`ask knowledge refresh <id>` re-reads one file or page.

## Consequences

- Adding a source is a command, not a deploy.
- An unchanged repo costs one `git fetch` and one hash compare. An unchanged
  file costs one hash compare.
- The workdir is a cache. Deleting it forces a full clone, nothing else.
- The API host needs `git`. The Docker image installs it.
- `ask sources remove <id>` deletes the row; `--purge` also deletes its
  records. Without `--purge` the records stay, lose their owner, and decay.
