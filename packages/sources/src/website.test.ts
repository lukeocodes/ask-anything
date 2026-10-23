import { describe, expect, it } from "vitest";
import type { KnowledgeItem, KnowledgeSource } from "@ask/db";
import { memoryPersistence, testContext } from "./test-helpers.js";
import {
  collectSitemapUrls,
  createWebsiteAdapter,
  describeWebsite,
  htmlTitle,
  htmlToMarkdown,
  looksLikeWebsite,
  parseSitemapLocs,
  sitemapUrlFor,
  website,
  type FetchLike,
} from "./website.js";

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc> https://docs.example.com/guide?x=1&amp;y=2 </loc></url>
  <url><loc><![CDATA[https://docs.example.com/cdata]]></loc></url>
  <url><loc>https://other.example.com/elsewhere</loc></url>
</urlset>`;

const INDEX = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://docs.example.com/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>https://docs.example.com/sitemap-b.xml</loc></sitemap>
  <sitemap><loc>https://cdn.example.net/sitemap-c.xml</loc></sitemap>
</sitemapindex>`;

describe("adapter shape", () => {
  it("is the website adapter", () => {
    expect(website.kind).toBe("url");
    expect(website.providers).toEqual(["web"]);
  });

  it("claims any http(s) URL and names it host/path", () => {
    expect(looksLikeWebsite("https://docs.example.com")).toBe(true);
    expect(looksLikeWebsite("http://docs.example.com/x")).toBe(true);
    expect(looksLikeWebsite("git@github.com:acme/sdk.git")).toBe(false);
    expect(looksLikeWebsite("not a url")).toBe(false);
    expect(describeWebsite("https://docs.example.com")).toEqual({ provider: "web", name: "docs.example.com" });
    expect(describeWebsite("https://docs.example.com/guide/start/")).toEqual({ provider: "web", name: "docs.example.com/guide/start" });
    expect(describeWebsite("https://github.com/acme/sdk")).toEqual({ provider: "web", name: "github.com/acme/sdk" });
  });
});

describe("sitemap parsing", () => {
  it("reads loc entries from a urlset, decoding entities and CDATA", () => {
    const r = parseSitemapLocs(URLSET);
    expect(r.kind).toBe("urlset");
    expect(r.locs).toEqual([
      "https://docs.example.com/",
      "https://docs.example.com/guide?x=1&y=2",
      "https://docs.example.com/cdata",
      "https://other.example.com/elsewhere",
    ]);
  });

  it("recognises a sitemap index", () => {
    expect(parseSitemapLocs(INDEX)).toEqual({
      kind: "index",
      locs: ["https://docs.example.com/sitemap-a.xml", "https://docs.example.com/sitemap-b.xml", "https://cdn.example.net/sitemap-c.xml"],
    });
  });

  it("expands an index one level, same host only, capped", async () => {
    const fetched: string[] = [];
    const urls = await collectSitemapUrls(INDEX, "docs.example.com", 4, async (u) => {
      fetched.push(u);
      if (u.endsWith("sitemap-a.xml")) return URLSET;
      if (u.endsWith("sitemap-b.xml")) return `<urlset><url><loc>https://docs.example.com/b1</loc></url><url><loc>https://docs.example.com/b2</loc></url></urlset>`;
      return INDEX; // a nested index is not followed
    });
    expect(fetched).toEqual(["https://docs.example.com/sitemap-a.xml", "https://docs.example.com/sitemap-b.xml"]);
    expect(urls).toEqual([
      "https://docs.example.com/",
      "https://docs.example.com/guide?x=1&y=2",
      "https://docs.example.com/cdata",
      "https://docs.example.com/b1",
    ]);
  });

  it("dedupes and drops fragments in a plain urlset", async () => {
    const xml = `<urlset><url><loc>https://d.example.com/a#top</loc></url><url><loc>https://d.example.com/a</loc></url></urlset>`;
    expect(await collectSitemapUrls(xml, "d.example.com", 10, async () => undefined)).toEqual(["https://d.example.com/a"]);
  });

  it("derives the sitemap url from the locator", () => {
    expect(sitemapUrlFor("https://docs.example.com/guide/start")).toBe("https://docs.example.com/sitemap.xml");
    expect(sitemapUrlFor("https://docs.example.com/custom-map.xml")).toBe("https://docs.example.com/custom-map.xml");
  });
});

describe("html to markdown", () => {
  const html = `<!doctype html><html><head><title>Rate &amp; limits — Docs</title>
<style>h1{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/">Home</a> · <a href="/x">X</a></nav>
<main>
<h1>Rate limits</h1>
<p>The API allows <strong>100</strong> requests per second.</p>
<h2>Bursting</h2>
<ul><li>Short bursts are fine.</li><li>Sustained load is throttled.</li></ul>
<pre><code>curl -H "Authorization: Bearer x" https://api.example.com</code></pre>
</main>
<footer>© Example</footer></body></html>`;

  it("keeps headings, lists and code; drops nav, script, style, footer", () => {
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Rate limits");
    expect(md).toContain("## Bursting");
    expect(md).toContain("**100**");
    expect(md).toMatch(/^-\s+Short bursts are fine\./m);
    expect(md).toContain("```");
    expect(md).not.toContain("Home");
    expect(md).not.toContain("alert(1)");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("© Example");
  });

  it("extracts the title", () => {
    expect(htmlTitle(html)).toBe("Rate & limits — Docs");
    expect(htmlTitle("<p>no title</p>")).toBeUndefined();
  });
});

function fakeFetch(pages: Record<string, { status?: number; body: string; type?: string }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect((init?.headers as Record<string, string>)["user-agent"]).toBe("ask-anything");
    const page = pages[url];
    if (!page) return new Response("", { status: 404 });
    return new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8" } });
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const base = {
  id: "33333333-3333-3333-3333-333333333333",
  kind: "url",
  provider: "web",
  locator: "https://docs.example.com/guide",
  name: "docs.example.com/guide",
  visibility: "public",
  branch: null,
  include: [],
  exclude: [],
  crawl: "page",
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

describe("website.index", () => {
  it("page mode: fetches the locator, stores markdown, then skips when unchanged", async () => {
    const source = base;
    const { p, items } = memoryPersistence();
    const fetch = fakeFetch({ [source.locator]: { body: "<html><head><title>Guide</title></head><body><h1>Guide</h1><p>Hi</p></body></html>" } });
    const adapter = createWebsiteAdapter({ fetch });

    const r = await adapter.index(testContext(source, p), { force: false });
    expect(r).toMatchObject({ skipped: false, seen: 1, created: 1, pruned: 0, failed: 0 });
    expect(r.lastCommit).toMatch(/^[0-9a-f]{64}$/);
    const item = items.get(`${source.id}:${source.locator}`)!;
    expect(item).toMatchObject({ sourceType: "url", title: "Guide", format: "markdown", metadata: { origin: "source", url: source.locator } });
    expect(item.body).toContain("# Guide");

    const again = await adapter.index(testContext({ ...source, lastCommit: r.lastCommit ?? null }, p), { force: false });
    expect(again).toMatchObject({ skipped: true, lastCommit: r.lastCommit, seen: 0 });
    const forced = await adapter.index(testContext({ ...source, lastCommit: r.lastCommit ?? null }, p), { force: true });
    expect(forced).toMatchObject({ skipped: false, unchanged: 1 });
  });

  it("sitemap mode: expands the sitemap, ingests same-host pages, prunes the rest", async () => {
    const source = { ...base, locator: "https://docs.example.com", crawl: "sitemap" } as KnowledgeSource;
    const { p, items, calls } = memoryPersistence();
    // A stale page from an earlier run that the sitemap no longer lists.
    await p.refresh({ sourceType: "url", sourceRef: `${source.id}:https://docs.example.com/old`, body: "old" });
    const fetch = fakeFetch({
      "https://docs.example.com/sitemap.xml": { body: URLSET, type: "application/xml" },
      "https://docs.example.com/": { body: "<title>Home</title><h1>Home</h1>" },
      "https://docs.example.com/guide?x=1&y=2": { body: "<h1>Guide</h1><h2>Part</h2>" },
      "https://docs.example.com/cdata": { body: "plain text page", type: "text/plain" },
    });

    const r = await createWebsiteAdapter({ fetch }).index(testContext(source, p, { maxPages: 500 }), { force: false });
    expect(r).toMatchObject({ skipped: false, seen: 3, created: 3, pruned: 1, failed: 0 });
    expect(fetch.calls).not.toContain("https://other.example.com/elsewhere");
    expect([...items.keys()].sort()).toEqual([
      `${source.id}:https://docs.example.com/`,
      `${source.id}:https://docs.example.com/cdata`,
      `${source.id}:https://docs.example.com/guide?x=1&y=2`,
    ]);
    expect(items.get(`${source.id}:https://docs.example.com/cdata`)!.format).toBe("text");
    expect(calls.prune).toHaveLength(1);
  });

  it("sitemap mode: caps pages and counts fetch failures", async () => {
    const source = { ...base, locator: "https://docs.example.com", crawl: "sitemap" } as KnowledgeSource;
    const { p } = memoryPersistence();
    const fetch = fakeFetch({
      "https://docs.example.com/sitemap.xml": { body: URLSET, type: "application/xml" },
      "https://docs.example.com/": { body: "<h1>Home</h1>" },
      "https://docs.example.com/guide?x=1&y=2": { body: "boom", status: 500 },
    });
    const r = await createWebsiteAdapter({ fetch }).index(testContext(source, p, { maxPages: 2 }), { force: false });
    expect(r).toMatchObject({ seen: 1, created: 1, failed: 1 });
  });

  it("refresh reports refreshed / unchanged / removed", async () => {
    const source = base;
    const { p, calls } = memoryPersistence();
    const item = { id: "item-1", sourceId: source.id, metadata: { origin: "source", sourceId: source.id, url: source.locator } } as unknown as KnowledgeItem;

    let body = "<h1>V1</h1>";
    const fetch: FetchLike = async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    const adapter = createWebsiteAdapter({ fetch });
    expect(await adapter.refresh(item, testContext(source, p))).toBe("refreshed");
    expect(await adapter.refresh(item, testContext(source, p))).toBe("unchanged");
    body = "<h1>V2</h1>";
    expect(await adapter.refresh(item, testContext(source, p))).toBe("refreshed");

    const gone = createWebsiteAdapter({ fetch: async () => new Response("", { status: 404 }) });
    expect(await gone.refresh(item, testContext(source, p))).toBe("removed");
    expect(calls.removed).toEqual(["item-1"]);
  });
});
