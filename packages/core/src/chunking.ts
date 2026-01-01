/**
 * Structured chunking (ADR-0025): a document becomes a TREE of chunks, and the
 * structure lives in fields, not in the body.
 *
 * The body is parsed into a heading tree. A section (a heading and everything
 * under it) that fits in `size` chars is one `section` chunk. One that does not
 * emits its preamble (heading + the prose before its first child heading) as
 * its own row — always, even when that is only the heading line, so every
 * child has a real parent — and recurses into each child one level deeper. A
 * leaf that still does not fit is packed by paragraph into `paragraph`
 * children, fenced code kept whole as `code` children, with `overlap` chars of
 * tail bleeding between adjacent paragraph chunks. Text without headings gets a
 * single `file` root, paragraph-packed the same way if too long.
 *
 * Bodies are the source text alone (no breadcrumb). `headingPath` carries the
 * context; the embedding input is built from both at ingest time.
 */
export type ChunkKind = "file" | "section" | "paragraph" | "code";
export type ChunkFormat = "markdown" | "text";

export interface ChunkNode {
  /** Document order across the whole file, 0-based. */
  ord: number;
  /** Materialised position, e.g. "0.2.1". Subtree = path prefix. */
  path: string;
  /** Heading level for sections (1-6), 0 for a file root, parent+1 for packed children. */
  depth: number;
  parentPath: string | null;
  /** This chunk's own heading text, if it is a section. */
  heading: string | null;
  /** Ancestor headings root → self (self included when this is a section). */
  headingPath: string[];
  kind: ChunkKind;
  /** 1-based, inclusive line span in the source. */
  startLine: number;
  endLine: number;
  body: string;
}

export interface ChunkOptions {
  /** Target max chars per chunk (default 1800). */
  size?: number;
  /** Tail chars carried between adjacent paragraph chunks (default 200). */
  overlap?: number;
  /** `text` disables heading parsing. Default: markdown when ATX headings are present. */
  format?: ChunkFormat;
}

export function chunkDocument(body: string, opts?: ChunkOptions): ChunkNode[] {
  const size = opts?.size ?? 1800;
  const overlap = opts?.overlap ?? 200;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");

  const root = buildTree(lines, opts?.format !== "text");
  // A file whose only top-level content is one heading IS that section: don't
  // wrap it in an empty file row.
  const top =
    root.children.length === 1 && slice(lines, root.start, root.children[0]!.start) === null
      ? root.children[0]!
      : root;

  const out: ChunkNode[] = [];
  emit(lines, top, "0", null, [], size, overlap, out);
  out.forEach((c, i) => (c.ord = i));
  return out;
}

// --- Parsing -----------------------------------------------------------------

interface Section {
  level: number; // 0 = synthetic file root, 1..6 = heading depth
  title: string | null;
  /** First line of the subtree: the heading line, or 0 for the root. */
  start: number;
  /** One past the last line of the subtree. */
  end: number;
  children: Section[];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

/** Parse lines into a tree of sections by heading level (fences are opaque). */
function buildTree(lines: string[], headings: boolean): Section {
  const root: Section = { level: 0, title: null, start: 0, end: lines.length, children: [] };
  const stack: Section[] = [root];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (!headings) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const node: Section = { level, title: m[2]!.trim(), start: i, end: lines.length, children: [] };
    while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }

  finalize(root, lines.length);
  return root;
}

function finalize(node: Section, end: number): void {
  node.end = end;
  node.children.forEach((child, i) => finalize(child, node.children[i + 1]?.start ?? end));
}

function closesFence(line: string, fence: string): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
}

// --- Text slices -------------------------------------------------------------

/** A span's row fields: text becomes the chunk body. */
function span(s: Span): Pick<ChunkNode, "body" | "startLine" | "endLine"> {
  return { body: s.text, startLine: s.startLine, endLine: s.endLine };
}

interface Span {
  text: string;
  /** 1-based inclusive. */
  startLine: number;
  endLine: number;
}

/** Lines [a, b) with leading/trailing blank lines dropped, or null when all blank. */
function slice(lines: string[], a: number, b: number): Span | null {
  let s = a;
  let e = b;
  while (s < e && lines[s]!.trim() === "") s++;
  while (e > s && lines[e - 1]!.trim() === "") e--;
  if (s >= e) return null;
  return { text: lines.slice(s, e).join("\n").trim(), startLine: s + 1, endLine: e };
}

// --- Emission ----------------------------------------------------------------

function emit(
  lines: string[],
  node: Section,
  path: string,
  parentPath: string | null,
  ancestors: string[],
  size: number,
  overlap: number,
  out: ChunkNode[],
): void {
  const headingPath = node.title !== null ? [...ancestors, node.title] : ancestors;
  const kind: ChunkKind = node.level === 0 ? "file" : "section";
  const base = { path, parentPath, depth: node.level, heading: node.title, headingPath, kind };

  const full = slice(lines, node.start, node.end);
  if (full === null) return; // blank document
  if (full.text.length <= size) {
    out.push({ ord: 0, ...base, ...span(full) });
    return;
  }

  // Too big: the preamble becomes this node's own row; everything else descends.
  const ownEnd = node.children[0]?.start ?? node.end;
  const own = slice(lines, node.start, ownEnd);
  let packStart: number | null = null;
  let row: ChunkNode;
  if (own !== null && own.text.length <= size) {
    row = { ord: 0, ...base, ...span(own) };
  } else if (node.level > 0) {
    // Heading line alone; its prose is packed into children below.
    row = { ord: 0, ...base, startLine: node.start + 1, endLine: node.start + 1, body: lines[node.start]! };
    packStart = node.start + 1;
  } else {
    // A file root with an oversized preamble holds no text of its own.
    row = { ord: 0, ...base, startLine: full.startLine, endLine: full.endLine, body: "" };
    packStart = node.start;
  }
  out.push(row);

  let idx = 0;
  if (packStart !== null) {
    for (const piece of packLines(lines, packStart, ownEnd, size, overlap)) {
      out.push({
        ord: 0,
        path: `${path}.${idx++}`,
        parentPath: path,
        depth: node.level + 1,
        heading: null,
        headingPath,
        kind: piece.kind,
        ...span(piece),
      });
    }
  }
  for (const child of node.children) {
    emit(lines, child, `${path}.${idx++}`, path, headingPath, size, overlap, out);
  }
}

// --- Paragraph packing -------------------------------------------------------

interface Piece extends Span {
  kind: "paragraph" | "code";
}

/** Split lines [a, b) into paragraphs (blank-line separated) and whole code fences. */
function blocks(lines: string[], a: number, b: number): Piece[] {
  const out: Piece[] = [];
  let i = a;
  while (i < b) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      let j = i + 1;
      while (j < b && !closesFence(lines[j]!, open[1]!)) j++;
      const end = Math.min(j + 1, b);
      out.push({ kind: "code", ...slice(lines, i, end)! });
      i = end;
      continue;
    }
    let j = i;
    while (j < b && lines[j]!.trim() !== "" && !FENCE_OPEN.test(lines[j]!)) j++;
    out.push({ kind: "paragraph", ...slice(lines, i, j)! });
    i = j;
  }
  return out;
}

/** Pack paragraphs up to ~`size`, carrying ~`overlap` chars across cuts; fences stay whole. */
function packLines(lines: string[], a: number, b: number, size: number, overlap: number): Piece[] {
  const out: Piece[] = [];
  let cur: Span | null = null;
  let tail = "";

  const flush = () => {
    if (!cur) return;
    out.push({ kind: "paragraph", ...cur });
    tail = overlap > 0 ? cur.text.slice(-overlap) : "";
    cur = null;
  };

  for (const block of blocks(lines, a, b)) {
    if (block.kind === "code") {
      flush();
      tail = "";
      out.push({ kind: "code", text: block.text, startLine: block.startLine, endLine: block.endLine });
      continue;
    }
    if (block.text.length > size) {
      flush();
      for (const text of hardSplit(block.text, size, overlap)) {
        out.push({ kind: "paragraph", text, startLine: block.startLine, endLine: block.endLine });
      }
      tail = "";
      continue;
    }
    if (cur !== null) {
      const candidate = `${cur.text}\n\n${block.text}`;
      if (candidate.length <= size) {
        cur.text = candidate;
        cur.endLine = block.endLine;
        continue;
      }
      flush();
    }
    // First block of a fresh chunk: always taken, prefixed with the carried tail.
    cur = {
      text: tail ? `${tail}\n\n${block.text}` : block.text,
      startLine: block.startLine,
      endLine: block.endLine,
    };
  }
  flush();

  return out.filter((p) => p.text.length > 0);
}

function hardSplit(text: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  let i = 0;
  const step = Math.max(1, size - overlap);
  while (i < text.length) {
    const piece = text.slice(i, i + size).trim();
    if (piece) out.push(piece);
    i += step;
  }
  return out;
}

/** Embedding input for a chunk: the heading breadcrumb plus the body (ADR-0025). */
export function chunkEmbeddingInput(chunk: Pick<ChunkNode, "headingPath" | "body">): string {
  return chunk.headingPath.length > 0 ? `${chunk.headingPath.join(" > ")}\n\n${chunk.body}` : chunk.body;
}
