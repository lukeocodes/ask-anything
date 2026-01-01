import { createHash } from "node:crypto";
import {
  UpstreamFetchError,
  parseLocator,
  sourceItemInput,
  type AdapterDescription,
  type IndexContext,
  type IndexResult,
  type RefreshAction,
  type SourceAdapter,
} from "@ask/core";
import type { KnowledgeItem, KnowledgeSource } from "@ask/db";
import TurndownService from "turndown";
import { emptyResult, tally } from "./common.js";

/**
 * Website adapter (ADR-0020). Fetches one page or expands a sitemap (same
 * host, one index level, capped at INDEX_MAX_PAGES), converts HTML to
 * Markdown so headings survive into the chunk tree, and pushes every page
 * through the content-hash gate.
 */

const USER_AGENT = "ask-anything";
const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebsiteOptions {
  /** Injected fetch (tests). */
  fetch?: FetchLike;
  timeoutMs?: number;
}

// --- Locators ---------------------------------------------------------------

/** Any http(s) URL. Register this adapter after git: it would claim clone URLs too. */
export function looksLikeWebsite(locator: string): boolean {
  try {
    return /^https?$/.test(parseLocator(locator).scheme);
  } catch {
    return false;
  }
}

/** provider `web` and a `host/path` name. */
export function describeWebsite(locator: string): AdapterDescription {
  const { host, path } = parseLocator(locator);
  const bare = path.replace(/\/+$/, "");
  return { provider: "web", name: bare ? `${host}/${bare}` : host };
}

// --- HTML → Markdown --------------------------------------------------------

let turndown: TurndownService | undefined;

function converter(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "_",
    });
    // Chrome, not content: navigation, scripts, styles, and page furniture.
    turndown.remove(["nav", "script", "style", "noscript", "header", "footer", "aside", "iframe", "svg", "template", "form"]);
  }
  return turndown;
}

/** `<title>` text, entity-lite, or undefined. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = m?.[1]?.replace(/\s+/g, " ").trim();
  if (!raw) return undefined;
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * HTML to Markdown so headings survive into the chunk tree. Prefers the
 * `<main>` / `<article>` element when the page has one (drops the chrome
 * around it); otherwise converts the whole body.
 */
export function htmlToMarkdown(html: string): string {
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0];
  const md = converter().turndown(main ?? html);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

// --- Sitemaps ---------------------------------------------------------------

/** `<loc>` entries of a sitemap or sitemap index (decoded). */
export function parseSitemapLocs(xml: string): { kind: "index" | "urlset"; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : "urlset";
  const locs: string[] = [];
  const re = /<loc[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const loc = m[1]!.trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    if (loc) locs.push(loc);
  }
  return { kind, locs };
}

/** The sitemap to fetch for a locator: itself when it ends in .xml, else `<origin>/sitemap.xml`. */
export function sitemapUrlFor(locator: string): string {
  const u = new URL(locator);
  if (/\.xml$/i.test(u.pathname)) return u.toString();
  return `${u.origin}/sitemap.xml`;
}

/** Same-host page URLs from a sitemap, expanding an index one level, capped. */
export async function collectSitemapUrls(
  rootXml: string,
  host: string,
  maxPages: number,
  childXml: (url: string) => Promise<string | undefined>,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (loc: string) => {
    let u: URL;
    try {
      u = new URL(loc);
    } catch {
      return;
    }
    if (u.hostname.toLowerCase() !== host) return;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key) || out.length >= maxPages) return;
    seen.add(key);
    out.push(key);
  };
  const root = parseSitemapLocs(rootXml);
  if (root.kind === "urlset") {
    root.locs.forEach(add);
    return out;
  }
  for (const child of root.locs) {
    if (out.length >= maxPages) break;
    let u: URL;
    try {
      u = new URL(child);
    } catch {
      continue;
    }
    if (u.hostname.toLowerCase() !== host) continue;
    const xml = await childXml(child);
    if (!xml) continue;
    const parsed = parseSitemapLocs(xml);
    if (parsed.kind === "urlset") parsed.locs.forEach(add);
  }
  return out;
}

// --- Fetching ---------------------------------------------------------------

interface Page {
  url: string;
  title: string;
  body: string;
  format: "markdown" | "text";
  hash: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchText(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ status: number; text: string; contentType: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml,text/plain,text/markdown;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamFetchError(0, url, (err as Error).message);
  }
  const text = res.ok ? await res.text() : "";
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

/** Fetch one page and normalise it to Markdown / text. Undefined on 404/410. */
async function fetchPage(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Page | undefined> {
  const { status, text, contentType } = await fetchText(url, fetchImpl, timeoutMs);
  if (status === 404 || status === 410) return undefined;
  if (status < 200 || status >= 300) throw new UpstreamFetchError(status, url);
  const ct = contentType.toLowerCase();
  if (ct.includes("html") || ct.includes("xml") || (!ct && /<html|<body|<h1/i.test(text))) {
    const body = htmlToMarkdown(text);
    return { url, title: htmlTitle(text) ?? url, body, format: "markdown", hash: hash(text) };
  }
  const format = ct.includes("markdown") ? "markdown" : "text";
  return { url, title: url, body: text.trim(), format, hash: hash(text) };
}

function pageInput(source: KnowledgeSource, page: Page) {
  return sourceItemInput(source, {
    ref: page.url,
    title: page.title,
    body: page.body,
    format: page.format,
    url: page.url,
  });
}

// --- Indexing ---------------------------------------------------------------

/**
 * `page`: fetch the locator; unchanged content (by hash, vs `lastCommit`) is
 * skipped unless forced. `sitemap`: expand the sitemap (index files one level
 * deep, same host, capped at INDEX_MAX_PAGES) and push every page through the
 * content-hash gate — the sitemap hash is recorded but never short-circuits,
 * since pages change without it.
 */
async function index(ctx: IndexContext, opts: { force: boolean }, adapterOpts: WebsiteOptions): Promise<IndexResult> {
  const { source, persistence: p, log, env } = ctx;
  const fetchImpl: FetchLike = adapterOpts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = adapterOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = emptyResult();
  const seen: string[] = [];

  const ingestPage = async (page: Page) => {
    const input = pageInput(source, page);
    try {
      tally(result, await p.refresh(input));
      seen.push(input.sourceRef);
    } catch (err) {
      result.failed += 1;
      log.warn({ sourceId: source.id, url: page.url, err: (err as Error).message }, "page ingest failed");
    }
  };

  if ((source.crawl ?? "page") === "page") {
    const page = await fetchPage(source.locator, fetchImpl, timeoutMs);
    if (!page) throw new UpstreamFetchError(404, source.locator);
    result.lastCommit = page.hash;
    if (!opts.force && source.lastCommit === page.hash) {
      result.skipped = true;
      return result;
    }
    if (page.body) await ingestPage(page);
  } else {
    const host = new URL(source.locator).hostname.toLowerCase();
    const sitemapUrl = sitemapUrlFor(source.locator);
    const root = await fetchText(sitemapUrl, fetchImpl, timeoutMs);
    if (root.status < 200 || root.status >= 300) throw new UpstreamFetchError(root.status, sitemapUrl);
    result.lastCommit = hash(root.text);
    const urls = await collectSitemapUrls(root.text, host, env.maxPages, async (u) => {
      try {
        const r = await fetchText(u, fetchImpl, timeoutMs);
        return r.status >= 200 && r.status < 300 ? r.text : undefined;
      } catch (err) {
        log.warn({ sourceId: source.id, url: u, err: (err as Error).message }, "child sitemap fetch failed");
        return undefined;
      }
    });
    for (const url of urls) {
      try {
        const page = await fetchPage(url, fetchImpl, timeoutMs);
        if (page?.body) await ingestPage(page);
      } catch (err) {
        result.failed += 1;
        log.warn({ sourceId: source.id, url, err: (err as Error).message }, "page fetch failed");
      }
    }
  }

  result.seen = seen.length;
  result.pruned = await p.prune(source.id, seen);
  log.info({ sourceId: source.id, ...result }, "url source indexed");
  return result;
}

/** Re-fetch ONE source-owned page. `removed` on 404/410 — the record is deleted. */
async function refresh(item: KnowledgeItem, ctx: IndexContext, adapterOpts: WebsiteOptions): Promise<RefreshAction> {
  const { source, persistence: p } = ctx;
  const fetchImpl: FetchLike = adapterOpts.fetch ?? ((u, i) => fetch(u, i));
  const meta = item.metadata as { url?: string };
  if (!meta.url) throw new Error(`source-owned item ${item.id} has no metadata.url`);

  const page = await fetchPage(meta.url, fetchImpl, adapterOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!page || !page.body) {
    await p.remove(item.id);
    return "removed";
  }
  const r = await p.refresh(pageInput(source, page));
  return r.changed ? "refreshed" : "unchanged";
}

/** Build the adapter; inject `fetch` in tests. */
export function createWebsiteAdapter(opts: WebsiteOptions = {}): SourceAdapter {
  return {
    kind: "url",
    trust: "upstream",
    providers: ["web"],
    detect: looksLikeWebsite,
    describe: describeWebsite,
    index: (ctx, o) => index(ctx, o, opts),
    refresh: (item, ctx) => refresh(item, ctx, opts),
  };
}

export const website: SourceAdapter = createWebsiteAdapter();
