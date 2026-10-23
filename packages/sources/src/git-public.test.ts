import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpstreamFetchError, type SourcePersistence } from "@ask/core";
import type { KnowledgeItem, KnowledgeSource } from "@ask/db";
import { isBinary } from "./common.js";
import { blobUrl, describeGit, gitPublic, looksLikeGit, makeFileFilter } from "./git-public.js";
import { memoryPersistence, testContext } from "./test-helpers.js";

describe("adapter shape", () => {
  it("is the public git adapter", () => {
    expect(gitPublic.kind).toBe("git");
    expect(gitPublic.providers).toEqual(["github", "gitlab", "git"]);
  });
});

describe("looksLikeGit / describeGit", () => {
  it("claims clone URLs by suffix, scheme, and host", () => {
    for (const l of [
      "https://github.com/acme/sdk",
      "https://github.com/acme/sdk.git",
      "git@github.com:acme/sdk.git",
      "git@gitlab.com:group/sub/repo.git",
      "https://gitlab.example.com/group/repo",
      "https://code.example.com/team/repo.git",
      "ssh://git@code.example.com/team/repo",
      "file:///tmp/fixtures/repo.git",
    ]) {
      expect(looksLikeGit(l), l).toBe(true);
    }
    expect(looksLikeGit("https://docs.example.com")).toBe(false);
    expect(looksLikeGit("https://docs.example.com/guide/start/")).toBe(false);
    expect(looksLikeGit("not a url")).toBe(false);
  });

  it("derives provider and owner/repo name", () => {
    expect(describeGit("https://github.com/acme/sdk")).toEqual({ provider: "github", name: "acme/sdk" });
    expect(describeGit("https://github.com/acme/sdk.git")).toEqual({ provider: "github", name: "acme/sdk" });
    expect(describeGit("git@gitlab.com:group/sub/repo.git")).toEqual({ provider: "gitlab", name: "sub/repo" });
    expect(describeGit("https://github.example.com/org/repo")).toEqual({ provider: "github", name: "org/repo" });
    expect(describeGit("https://code.example.com/team/repo.git")).toEqual({ provider: "git", name: "team/repo" });
    expect(describeGit("file:///tmp/fixtures/repo.git")).toEqual({ provider: "git", name: "fixtures/repo" });
    expect(describeGit("https://docs.example.com/repo")).toEqual({ provider: "git", name: "repo" });
  });
});

describe("makeFileFilter", () => {
  it("keeps everything with no globs", () => {
    const keep = makeFileFilter([], []);
    expect(keep("README.md")).toBe(true);
    expect(keep(".github/workflows/ci.yml")).toBe(true);
  });

  it("applies include then exclude", () => {
    const keep = makeFileFilter(["docs/**", "*.md"], ["**/CHANGELOG.md", "docs/internal/**"]);
    expect(keep("README.md")).toBe(true);
    expect(keep("docs/guide/start.md")).toBe(true);
    expect(keep("docs/internal/secret.md")).toBe(false);
    expect(keep("CHANGELOG.md")).toBe(false);
    expect(keep("src/index.ts")).toBe(false);
  });

  it("exclude alone drops only matches", () => {
    const keep = makeFileFilter([], ["node_modules/**", "**/*.lock"]);
    expect(keep("src/a.ts")).toBe(true);
    expect(keep("node_modules/x/index.js")).toBe(false);
    expect(keep("pnpm-lock.lock")).toBe(false);
  });
});

describe("isBinary", () => {
  it("flags a NUL byte in the first 8 KB", () => {
    expect(isBinary(Buffer.from("plain text\nwith lines"))).toBe(false);
    expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]))).toBe(true);
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(isBinary(late)).toBe(false);
  });
});

describe("blobUrl", () => {
  it("builds github and gitlab blob links, nothing for plain git", () => {
    const base = { provider: "github", locator: "https://github.com/acme/sdk.git" } as KnowledgeSource;
    expect(blobUrl(base, "abc", "docs/a.md")).toBe("https://github.com/acme/sdk/blob/abc/docs/a.md");
    expect(blobUrl({ ...base, provider: "gitlab", locator: "https://gitlab.com/g/r" }, "abc", "x.md")).toBe("https://gitlab.com/g/r/-/blob/abc/x.md");
    expect(blobUrl({ ...base, provider: "git", locator: "file:///tmp/r" }, "abc", "x.md")).toBeUndefined();
    expect(blobUrl({ ...base, locator: "git@github.com:acme/sdk.git" }, "abc", "x.md")).toBeUndefined();
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();

describe("gitPublic against a local repo", () => {
  let root: string;
  let repo: string;
  let workdir: string;
  let source: KnowledgeSource;
  const ctx = (s: KnowledgeSource, p: SourcePersistence) => testContext(s, p, { workdir, maxFileKb: 2 });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ask-git-public-"));
    repo = join(root, "upstream");
    workdir = join(root, "work");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "commit.gpgsign", "false");
    await mkdir(join(repo, "docs"), { recursive: true });
    await mkdir(join(repo, "assets"), { recursive: true });
    await writeFile(join(repo, "README.md"), "# Upstream\n\nHello.\n");
    await writeFile(join(repo, "docs", "guide.md"), "# Guide\n\n## Install\n\nnpm i\n");
    await writeFile(join(repo, "src.ts"), "export const x = 1;\n");
    await writeFile(join(repo, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a]));
    await writeFile(join(repo, "big.txt"), "x".repeat(3 * 1024));
    await writeFile(join(repo, "empty.txt"), "\n\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    source = {
      id: "22222222-2222-2222-2222-222222222222",
      kind: "git",
      provider: "git",
      locator: `file://${repo}`,
      name: "upstream",
      visibility: "public",
      branch: null,
      include: [],
      exclude: ["assets/**"],
      crawl: null,
      schedule: null,
      config: {},
      credentialEnv: null,
      enabled: true,
      status: "idle",
      lastIndexedAt: null,
      lastCommit: null,
      lastError: null,
      itemCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as KnowledgeSource;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clones, lists tracked text files, applies globs and gates, and prunes", async () => {
    const { p, items, calls } = memoryPersistence();
    const r = await gitPublic.index(ctx(source, p), { force: false });

    expect(r.skipped).toBe(false);
    expect(r.lastCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.lastCommit).toBe(git(repo, "rev-parse", "HEAD"));
    // README.md, docs/guide.md, src.ts. Excluded: assets/logo.png (glob + binary),
    // big.txt (> 2 KB), empty.txt (blank).
    const refs = [...items.keys()].sort();
    expect(refs).toEqual([`${source.id}:README.md`, `${source.id}:docs/guide.md`, `${source.id}:src.ts`]);
    expect(r).toMatchObject({ seen: 3, created: 3, changed: 0, unchanged: 0, pruned: 0, failed: 0 });
    expect(calls.prune).toHaveLength(1);
    expect([...calls.prune[0]!].sort()).toEqual(refs);

    const guide = items.get(`${source.id}:docs/guide.md`)!;
    expect(guide).toMatchObject({
      sourceType: "git",
      sourceId: source.id,
      title: "docs/guide.md",
      format: "markdown",
      visibility: "public",
      createdBy: "system",
      metadata: { origin: "source", path: "docs/guide.md", commit: r.lastCommit, format: "markdown" },
    });
    expect(items.get(`${source.id}:src.ts`)!.format).toBe("text");
  });

  it("skips when HEAD matches lastCommit, unless forced", async () => {
    const { p, items } = memoryPersistence();
    const head = git(repo, "rev-parse", "HEAD");
    const skipped = await gitPublic.index(ctx({ ...source, lastCommit: head }, p), { force: false });
    expect(skipped).toMatchObject({ skipped: true, lastCommit: head, seen: 0, created: 0 });
    expect(items.size).toBe(0);

    const forced = await gitPublic.index(ctx({ ...source, lastCommit: head }, p), { force: true });
    expect(forced).toMatchObject({ skipped: false, seen: 3, created: 3 });
  });

  it("fetches new commits and reports changed / unchanged / pruned", async () => {
    const { p, items } = memoryPersistence();
    const first = await gitPublic.index(ctx(source, p), { force: false });
    expect(first.created).toBe(3);

    await writeFile(join(repo, "docs", "guide.md"), "# Guide\n\n## Install\n\npnpm add\n");
    await writeFile(join(repo, "docs", "new.md"), "# New\n");
    git(repo, "rm", "-q", "src.ts");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "update");

    const second = await gitPublic.index(ctx({ ...source, lastCommit: first.lastCommit ?? null }, p), { force: false });
    expect(second.lastCommit).not.toBe(first.lastCommit);
    expect(second).toMatchObject({ skipped: false, seen: 3, created: 1, changed: 1, unchanged: 1, pruned: 1, failed: 0 });
    expect([...items.keys()].sort()).toEqual([`${source.id}:README.md`, `${source.id}:docs/guide.md`, `${source.id}:docs/new.md`]);
  });

  it("refresh re-reads one path from the clone", async () => {
    const { p, items, calls } = memoryPersistence();
    await gitPublic.index(ctx(source, p), { force: false });

    const item = (path: string) =>
      ({ id: `item-${path}`, sourceId: source.id, metadata: { origin: "source", sourceId: source.id, path } }) as unknown as KnowledgeItem;

    expect(await gitPublic.refresh(item("README.md"), ctx(source, p))).toBe("unchanged");

    await writeFile(join(repo, "README.md"), "# Upstream\n\nChanged.\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "readme");
    expect(await gitPublic.refresh(item("README.md"), ctx(source, p))).toBe("refreshed");
    expect(items.get(`${source.id}:README.md`)!.body).toContain("Changed.");

    expect(await gitPublic.refresh(item("gone.md"), ctx(source, p))).toBe("removed");
    expect(calls.removed).toEqual(["item-gone.md"]);
  });

  it("counts a failing ingest without aborting the run", async () => {
    const { p } = memoryPersistence();
    const flaky: SourcePersistence = {
      ...p,
      async refresh(input) {
        if (input.sourceRef.endsWith("README.md")) throw new Error("embed down");
        return p.refresh(input);
      },
    };
    const r = await gitPublic.index(ctx(source, flaky), { force: true });
    expect(r.failed).toBe(1);
    expect(r.seen).toBe(2);
  });

  it("fails an unreachable clone with the public-only message", async () => {
    const { p } = memoryPersistence();
    const missing = { ...source, id: "22222222-2222-2222-2222-222222222299", locator: `file://${root}/does-not-exist` } as KnowledgeSource;
    const err = await gitPublic.index(ctx(missing, p), { force: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamFetchError);
    expect((err as UpstreamFetchError).status).toBe(502);
    expect((err as Error).message).toMatch(/public repositories only/);
  });
});
