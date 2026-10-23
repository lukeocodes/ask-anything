import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  UpstreamFetchError,
  formatForPath,
  parseLocator,
  sourceItemInput,
  type AdapterDescription,
  type IndexContext,
  type IndexResult,
  type RefreshAction,
  type SourceAdapter,
} from "@ask/core";
import type { KnowledgeItem, KnowledgeSource } from "@ask/db";
import picomatch from "picomatch";
import { CommandError, emptyResult, isBinary, run, runBuffer, tally } from "./common.js";

/**
 * Public git repository adapter (ADR-0020). Plain `git clone --depth 1` and
 * `git fetch` / `reset --hard FETCH_HEAD` — no tokens, no `gh` / `glab`, no
 * credential plumbing. Anything the host's git cannot reach anonymously is out
 * of scope: private repositories are a future adapter.
 */

const PUBLIC_ONLY = "the git adapter supports public repositories only";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface GitPublicOptions {
  /** Per-subprocess timeout. */
  timeoutMs?: number;
}

/** `<workdir>/sources/<id>` */
export function cloneDir(source: Pick<KnowledgeSource, "id">, workdir: string): string {
  return join(workdir, "sources", source.id);
}

/**
 * Build include/exclude matchers. Empty include = everything. A path is kept
 * when it matches an include (or there are none) and matches no exclude.
 */
export function makeFileFilter(include: readonly string[], exclude: readonly string[]): (path: string) => boolean {
  const opts = { dot: true };
  const inc = include.length ? picomatch([...include], opts) : null;
  const exc = exclude.length ? picomatch([...exclude], opts) : null;
  return (path) => (inc ? inc(path) : true) && !(exc && exc(path));
}

/** True for anything that looks like a clone URL: `.git` suffix, `git@`, ssh/git scheme, or a github / gitlab host. */
export function looksLikeGit(locator: string): boolean {
  const trimmed = locator.trim();
  let host = "";
  let scheme = "";
  try {
    ({ host, scheme } = parseLocator(trimmed));
  } catch {
    return false;
  }
  return /\.git$/i.test(trimmed) || /^git@/.test(trimmed) || scheme === "ssh" || scheme === "git" || /github|gitlab/.test(host);
}

/** provider (github | gitlab | git) and an `owner/repo` name from a clone locator. */
export function describeGit(locator: string): AdapterDescription {
  const { host, path } = parseLocator(locator);
  const bare = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const provider = host.includes("github") ? "github" : host.includes("gitlab") ? "gitlab" : "git";
  const segs = bare.split("/").filter(Boolean);
  const name = segs.length >= 2 ? segs.slice(-2).join("/") : segs[0] || host;
  return { provider, name };
}

/** Browsable blob URL for github / gitlab https locators; undefined otherwise. */
export function blobUrl(source: KnowledgeSource, commit: string, path: string): string | undefined {
  if (source.provider !== "github" && source.provider !== "gitlab") return undefined;
  const m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(source.locator);
  if (!m) return undefined;
  const segment = source.provider === "gitlab" ? "-/blob" : "blob";
  return `https://${m[1]}/${m[2]}/${segment}/${commit}/${path}`;
}

interface GitContext {
  dir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function upstream(source: KnowledgeSource, err: unknown): never {
  const detail = err instanceof CommandError ? err.stderr.trim().slice(0, 500) : (err as Error).message;
  throw new UpstreamFetchError(502, source.locator, `${detail} (${PUBLIC_ONLY})`);
}

/**
 * Clone if absent (shallow, optionally one branch); otherwise shallow-fetch the
 * branch (or HEAD) and hard reset. Git never prompts: a repo that needs
 * credentials fails here with the public-only message. Returns HEAD's sha.
 */
async function ensureClone(ctx: IndexContext, opts: GitPublicOptions): Promise<{ git: GitContext; head: string }> {
  const { source, env: { workdir } } = ctx;
  const dir = cloneDir(source, workdir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const branch = source.branch?.trim() || undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  const git: GitContext = { dir, env, timeoutMs };

  let exists = false;
  try {
    exists = (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    exists = false;
  }

  try {
    if (exists) {
      await run("git", ["fetch", "--depth", "1", "origin", branch ?? "HEAD"], { cwd: dir, env, timeoutMs });
      await run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: dir, env, timeoutMs });
    } else {
      await mkdir(join(workdir, "sources"), { recursive: true });
      const branchArgs = branch ? ["--branch", branch] : [];
      await run("git", ["clone", "--depth", "1", ...branchArgs, "--", source.locator, dir], { env, timeoutMs });
    }
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: dir, env, timeoutMs })).trim();
    return { git, head };
  } catch (err) {
    ctx.log.warn({ sourceId: source.id, locator: source.locator, err: (err as Error).message }, "git fetch/clone failed");
    upstream(source, err);
  }
}

/** Tracked files, NUL-separated so any filename survives. */
async function listTrackedFiles(git: GitContext): Promise<string[]> {
  const out = await run("git", ["ls-files", "-z"], { cwd: git.dir, env: git.env, timeoutMs: git.timeoutMs });
  return out.split("\0").filter(Boolean);
}

type ReadOutcome = { ok: true; text: string } | { ok: false; reason: "too_large" | "binary" | "missing" };

async function readIndexable(git: GitContext, path: string, maxFileKb: number): Promise<ReadOutcome> {
  const full = join(git.dir, path);
  let size: number;
  try {
    size = (await stat(full)).size;
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (size > maxFileKb * 1024) return { ok: false, reason: "too_large" };
  const buf = await readFile(full);
  if (isBinary(buf)) return { ok: false, reason: "binary" };
  return { ok: true, text: buf.toString("utf8") };
}

/**
 * Full index: clone or fetch, stop when HEAD matches `lastCommit` (unless
 * forced), list tracked files, apply globs and the size / binary gates, push
 * every text file through the content-hash gate, prune what vanished.
 */
async function index(ctx: IndexContext, opts: { force: boolean }, adapterOpts: GitPublicOptions): Promise<IndexResult> {
  const { source, persistence: p, log, env } = ctx;
  const result = emptyResult();

  const { git, head } = await ensureClone(ctx, adapterOpts);
  result.lastCommit = head;
  if (!opts.force && source.lastCommit === head) {
    result.skipped = true;
    log.info({ sourceId: source.id, commit: head }, "git source unchanged; skipped");
    return result;
  }

  const keep = makeFileFilter(source.include, source.exclude);
  const files = (await listTrackedFiles(git)).filter(keep);
  const seen: string[] = [];
  let skippedFiles = 0;

  for (const path of files) {
    const read = await readIndexable(git, path, env.maxFileKb);
    if (!read.ok) {
      skippedFiles += 1;
      log.debug({ sourceId: source.id, path, reason: read.reason }, "file skipped");
      continue;
    }
    if (!read.text.trim()) {
      skippedFiles += 1;
      continue;
    }
    const input = sourceItemInput(source, {
      ref: path,
      title: path,
      body: read.text,
      format: formatForPath(path),
      commit: head,
      url: blobUrl(source, head, path),
    });
    try {
      tally(result, await p.refresh(input));
      seen.push(input.sourceRef);
    } catch (err) {
      result.failed += 1;
      log.warn({ sourceId: source.id, path, err: (err as Error).message }, "file ingest failed");
    }
  }

  result.seen = seen.length;
  result.pruned = await p.prune(source.id, seen);
  log.info({ sourceId: source.id, ...result, skippedFiles }, "git source indexed");
  return result;
}

/**
 * Re-index ONE source-owned file: fetch the clone, `git show HEAD:<path>`,
 * and run the same content-hash gate the full index would. `removed` when
 * the file is gone (or no longer indexable) — the record is deleted.
 */
async function refresh(item: KnowledgeItem, ctx: IndexContext, adapterOpts: GitPublicOptions): Promise<RefreshAction> {
  const { source, persistence: p, log, env } = ctx;
  const meta = item.metadata as { path?: string };
  if (!meta.path) throw new Error(`source-owned item ${item.id} has no metadata.path`);

  const { git, head } = await ensureClone(ctx, adapterOpts);

  let buf: Buffer;
  try {
    buf = await runBuffer("git", ["show", `HEAD:${meta.path}`], { cwd: git.dir, env: git.env, timeoutMs: git.timeoutMs });
  } catch (err) {
    if (err instanceof CommandError && /does not exist|exists on disk, but not in|invalid object name|bad revision/i.test(err.stderr)) {
      await p.remove(item.id);
      log.info({ itemId: item.id, path: meta.path }, "source file removed upstream; record deleted");
      return "removed";
    }
    upstream(source, err);
  }

  const keep = makeFileFilter(source.include, source.exclude);
  if (!keep(meta.path) || buf.length > env.maxFileKb * 1024 || isBinary(buf) || !buf.toString("utf8").trim()) {
    await p.remove(item.id);
    return "removed";
  }

  const r = await p.refresh(
    sourceItemInput(source, {
      ref: meta.path,
      title: meta.path,
      body: buf.toString("utf8"),
      format: formatForPath(meta.path),
      commit: head,
      url: blobUrl(source, head, meta.path),
    }),
  );
  return r.changed ? "refreshed" : "unchanged";
}

/** Build the adapter; `timeoutMs` is the per-git-command cap (tests). */
export function createGitPublicAdapter(opts: GitPublicOptions = {}): SourceAdapter {
  return {
    kind: "git",
    providers: ["github", "gitlab", "git"],
    detect: looksLikeGit,
    describe: describeGit,
    index: (ctx, o) => index(ctx, o, opts),
    refresh: (item, ctx) => refresh(item, ctx, opts),
  };
}

export const gitPublic: SourceAdapter = createGitPublicAdapter();
