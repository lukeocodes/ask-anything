import type { GroundingChunk } from "./answer.js";

/**
 * Rewrites the model's inline `[id]` citations into clickable numbered links
 * (`[n](url)`), so a citation renders as a single plain number that links to its
 * source — no brackets shown, no end-of-message Sources list.
 *
 * It is stateful and stream-safe: feed it text with push() (deltas may split a
 * marker across boundaries — it holds an unclosed `[…` until the `]` arrives),
 * then flush() at the end. Numbers are assigned on first appearance so they stay
 * contiguous across the linkable (URL-bearing) sources, and a repeated citation
 * keeps its number. The same rewriter drives both the streamed and the final
 * text, so what the user watches type out matches the stored answer exactly.
 *
 * Marker handling mirrors the id space:
 *  - id in the grounding WITH a url → `[n](url)` (and recorded as cited)
 *  - id in the grounding WITHOUT a url → dropped (cited, but nothing to link to)
 *  - stray citation-shaped token (a bare uuid) the model invented → dropped,
 *    so no dead marker leaks
 *  - anything else (e.g. a real Markdown link's `[text]`) → left untouched
 */
export type Visibility = "public" | "private";

export interface CitationOptions {
  /**
   * The caller's tier. A private caller may see private sources; a public
   * caller sees only public sources.
   * Anything not allowed for the tier becomes cited-but-unreferenced (the number
   * is dropped) rather than leaked. Defaults to public (fail closed).
   */
  callerVisibility?: Visibility;
}

export class CitationRewriter {
  private readonly byId: Map<string, GroundingChunk>;
  private readonly numberOf = new Map<string, number>();
  private readonly callerPrivate: boolean;
  private nextNum = 1;
  private held = "";
  /** Ids actually cited, in first-appearance order (linkable and not). */
  readonly citedIds: string[] = [];

  constructor(chunks: GroundingChunk[], opts: CitationOptions = {}) {
    this.byId = new Map(chunks.map((c) => [c.id, c]));
    this.callerPrivate = (opts.callerVisibility ?? "public") === "private";
  }

  /** A source's link, only if this caller's tier may see it. */
  private usableUrl(chunk: GroundingChunk): string | undefined {
    // Source-visibility gate: a private source is never referenced to a public
    // caller (aligns with the keys schema; retrieval already filters, this is
    // defense in depth). Unset visibility is treated as public.
    if (chunk.visibility === "private" && !this.callerPrivate) return undefined;
    return chunk.url || undefined;
  }

  private renderMarker(id: string): string {
    const chunk = this.byId.get(id);
    if (chunk) {
      if (!this.citedIds.includes(id)) this.citedIds.push(id);
      const url = this.usableUrl(chunk);
      if (url) {
        let n = this.numberOf.get(id);
        if (!n) {
          n = this.nextNum++;
          this.numberOf.set(id, n);
        }
        return `[${n}](${url})`;
      }
      return ""; // cited but no link this caller may open → no reference
    }
    if (/^[0-9a-f-]{20,}$/i.test(id)) return ""; // invented citation-shaped marker
    return `[${id}]`; // not a citation — leave it alone
  }

  /** Feed a chunk of text; returns the rewritten text safe to display now. */
  push(text: string): string {
    this.held += text;
    let out = "";
    for (;;) {
      const open = this.held.indexOf("[");
      if (open === -1) {
        out += this.held;
        this.held = "";
        break;
      }
      out += this.held.slice(0, open);
      const close = this.held.indexOf("]", open + 1);
      if (close === -1) {
        // Unclosed marker — hold it until the rest of the stream arrives.
        this.held = this.held.slice(open);
        break;
      }
      out += this.renderMarker(this.held.slice(open + 1, close));
      this.held = this.held.slice(close + 1);
    }
    return out;
  }

  /** Emit any text still held (an unclosed `[…`), verbatim. */
  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }
}

/** Tidy spacing left by dropped markers (space before punctuation, doubles). */
export function tidyCitations(text: string): string {
  return text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// A genuine abstain is ONLY the bare hedge (the model was told to reply with
// exactly this and nothing else). A hedge followed by real content is NOT an
// abstain — the model found something and then second-guessed itself; we strip
// the hedge and keep the content rather than mislabeling the whole answer.
const PURE_HEDGE = /^i don'?t have that yet[\s.!—-]*$/i;

/** True when the answer is a pure abstain (no citations, nothing but the hedge). */
export function isAbstain(text: string, citedIds: string[]): boolean {
  return citedIds.length === 0 && PURE_HEDGE.test(text.trim());
}

/** Strip a leading "I don't have that yet." hedge from an answer that has content. */
export function stripHedge(text: string): string {
  return text.replace(/^i don'?t have that yet[.!]?\s*/i, "");
}
