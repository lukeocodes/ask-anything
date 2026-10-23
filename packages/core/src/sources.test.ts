import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@ask/db";
import {
  adapterFor,
  detectAdapter,
  listAdapters,
  registerAdapter,
  resetAdapters,
  type SourceAdapter,
} from "./source-adapter.js";
import {
  SOURCE_ORIGIN,
  assertCron,
  formatForPath,
  isDue,
  isSourceOwned,
  parseLocator,
  resolveAdapter,
  sourceItemInput,
} from "./sources.js";

describe("parseLocator", () => {
  it("splits https, ssh and scp-like locators into host + path", () => {
    expect(parseLocator("https://github.com/acme/sdk.git")).toEqual({ scheme: "https", host: "github.com", path: "acme/sdk.git" });
    expect(parseLocator("git@gitlab.com:group/sub/repo.git")).toEqual({ scheme: "ssh", host: "gitlab.com", path: "group/sub/repo.git" });
    expect(parseLocator("ssh://git@code.example.com/team/repo")).toMatchObject({ scheme: "ssh", host: "code.example.com", path: "team/repo" });
    expect(parseLocator("https://docs.example.com/guide/start/")).toMatchObject({ host: "docs.example.com", path: "guide/start/" });
  });

  it("rejects garbage", () => {
    expect(() => parseLocator("not a url")).toThrow(/not a clone URL/);
  });
});

describe("adapter registry", () => {
  const fake = (kind: string, accept: (l: string) => boolean): SourceAdapter => ({
    kind,
    detect: accept,
    describe: (locator) => ({ provider: kind, name: locator }),
    index: async () => ({ created: 0, changed: 0, unchanged: 0, pruned: 0 }),
    refresh: async () => "unchanged",
  });

  beforeEach(() => resetAdapters());
  afterEach(() => resetAdapters());

  it("registers by kind and detects in registration order", () => {
    registerAdapter(fake("git", (l) => l.endsWith(".git")));
    registerAdapter(fake("url", (l) => l.startsWith("https://")));
    expect(listAdapters().map((a) => a.kind)).toEqual(["git", "url"]);
    expect(detectAdapter("https://github.com/acme/sdk.git")?.kind).toBe("git");
    expect(detectAdapter("https://docs.example.com")?.kind).toBe("url");
    expect(detectAdapter("ftp://x")).toBeNull();
    expect(adapterFor("url").kind).toBe("url");
    expect(() => adapterFor("nope")).toThrow(/no source adapter registered for kind "nope"/);
  });

  it("registers ahead of a named kind with { before }", () => {
    registerAdapter(fake("git", (l) => l.endsWith(".git")));
    registerAdapter(fake("url", (l) => l.startsWith("https://")));
    // A more specific adapter that also claims .git locators wins only if it sits before git.
    registerAdapter(fake("github-org", (l) => l.includes("github.com")), { before: "git" });
    expect(listAdapters().map((a) => a.kind)).toEqual(["github-org", "git", "url"]);
    expect(detectAdapter("https://github.com/acme/sdk.git")?.kind).toBe("github-org");
    expect(detectAdapter("https://gitlab.com/acme/sdk.git")?.kind).toBe("git");
    // Re-registering a kind without `before` replaces it in place.
    registerAdapter(fake("git", () => false));
    expect(listAdapters().map((a) => a.kind)).toEqual(["github-org", "git", "url"]);
    // `before` naming an unregistered kind appends.
    registerAdapter(fake("rss", () => false), { before: "nope" });
    expect(listAdapters().map((a) => a.kind)).toEqual(["github-org", "git", "url", "rss"]);
    // `before` can move an already-registered kind.
    registerAdapter(fake("rss", () => false), { before: "github-org" });
    expect(listAdapters().map((a) => a.kind)).toEqual(["rss", "github-org", "git", "url"]);
  });

  it("resolveAdapter honours an explicit kind and rejects unknown locators", () => {
    registerAdapter(fake("git", (l) => l.endsWith(".git")));
    expect(resolveAdapter("https://x/y", "git").kind).toBe("git");
    expect(() => resolveAdapter("https://x/y")).toThrow(/no source adapter accepts/);
    expect(() => resolveAdapter("not a url")).toThrow(/not a clone URL/);
    expect(() => resolveAdapter("https://x/y", "nope")).toThrow(/no source adapter registered/);
  });
});

describe("isDue", () => {
  const daily = "0 4 * * *";
  const now = new Date("2026-01-02T05:00:00Z");

  it("is due when never indexed", () => {
    expect(isDue(daily, null, now, "UTC")).toBe(true);
  });

  it("is due when the last fire time is after the last index", () => {
    expect(isDue(daily, new Date("2026-01-01T04:30:00Z"), now, "UTC")).toBe(true);
    expect(isDue(daily, new Date("2026-01-02T03:59:59Z"), now, "UTC")).toBe(true);
  });

  it("is not due when indexed since the last fire time", () => {
    expect(isDue(daily, new Date("2026-01-02T04:00:00Z"), now, "UTC")).toBe(false);
    expect(isDue(daily, new Date("2026-01-02T04:10:00Z"), now, "UTC")).toBe(false);
  });

  it("handles sub-hourly schedules", () => {
    const every15 = "*/15 * * * *";
    const at = new Date("2026-01-02T05:16:00Z");
    expect(isDue(every15, new Date("2026-01-02T05:14:00Z"), at, "UTC")).toBe(true);
    expect(isDue(every15, new Date("2026-01-02T05:15:30Z"), at, "UTC")).toBe(false);
  });

  it("rejects invalid cron through assertCron", () => {
    expect(() => assertCron("not cron")).toThrow(/invalid cron/);
    expect(() => assertCron("0 4 * * *")).not.toThrow();
  });
});

describe("source records", () => {
  const source = {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "git",
    provider: "github",
    locator: "https://github.com/acme/sdk",
    name: "acme/sdk",
    visibility: "public",
    branch: null,
    include: [],
    exclude: [],
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

  it("stamps origin, sourceId, sourceRef and visibility", () => {
    const input = sourceItemInput(source, { ref: "docs/a.md", title: "docs/a.md", body: "# A", format: "markdown", commit: "abc" });
    expect(input).toMatchObject({
      sourceType: "git",
      sourceRef: `${source.id}:docs/a.md`,
      sourceId: source.id,
      visibility: "public",
      createdBy: "system",
      enrich: false,
      format: "markdown",
      metadata: { origin: SOURCE_ORIGIN, sourceId: source.id, path: "docs/a.md", commit: "abc", format: "markdown" },
    });
    expect(isSourceOwned({ metadata: input.metadata! })).toBe(true);
    expect(isSourceOwned({ metadata: { origin: "crawl" } })).toBe(false);
    expect(isSourceOwned({ metadata: null })).toBe(false);
  });

  it("uses url instead of path for url sources", () => {
    const input = sourceItemInput({ ...source, kind: "url", provider: "web" }, { ref: "https://x/y", title: "Y", body: "b", format: "markdown" });
    expect(input.sourceType).toBe("url");
    expect(input.metadata).toMatchObject({ url: "https://x/y" });
    expect(input.metadata).not.toHaveProperty("path");
  });

  it("picks markdown only for markdown extensions", () => {
    expect(formatForPath("README.md")).toBe("markdown");
    expect(formatForPath("docs/x.MDX")).toBe("markdown");
    expect(formatForPath("a.markdown")).toBe("markdown");
    expect(formatForPath("src/index.ts")).toBe("text");
    expect(formatForPath("Makefile")).toBe("text");
  });
});
