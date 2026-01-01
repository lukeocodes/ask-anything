import { describe, expect, it } from "vitest";
import { type ChunkNode, chunkDocument, chunkEmbeddingInput } from "./chunking.js";

const para = (tag: string, len: number): string =>
  `${tag} `.repeat(Math.ceil(len / (tag.length + 1))).slice(0, len).trim();

const byPath = (chunks: ChunkNode[]): Map<string, ChunkNode> => new Map(chunks.map((c) => [c.path, c]));

/** Every parentPath points at an emitted row, ords are sequential, paths unique. */
function expectWellFormed(chunks: ChunkNode[]): void {
  const paths = byPath(chunks);
  expect(paths.size).toBe(chunks.length);
  chunks.forEach((c, i) => {
    expect(c.ord).toBe(i);
    if (c.parentPath === null) expect(c.path).toBe("0");
    else {
      expect(paths.has(c.parentPath)).toBe(true);
      expect(c.path.startsWith(`${c.parentPath}.`)).toBe(true);
    }
    expect(c.startLine).toBeLessThanOrEqual(c.endLine);
    if (c.kind === "paragraph" || c.kind === "code") expect(c.body.length).toBeGreaterThan(0);
  });
}

describe("chunkDocument", () => {
  it("returns a short heading-less body as one file root", () => {
    const chunks = chunkDocument("  hello world\n");
    expect(chunks).toEqual([
      {
        ord: 0,
        path: "0",
        depth: 0,
        parentPath: null,
        heading: null,
        headingPath: [],
        kind: "file",
        startLine: 1,
        endLine: 1,
        body: "hello world",
      },
    ]);
  });

  it("returns a short single-heading doc as one section", () => {
    const chunks = chunkDocument("# Title\n\nintro\n\n## A\nbody a\n");
    expect(chunks).toHaveLength(1);
    const [root] = chunks;
    expect(root).toMatchObject({
      path: "0",
      depth: 1,
      parentPath: null,
      heading: "Title",
      headingPath: ["Title"],
      kind: "section",
      startLine: 1,
      endLine: 6,
    });
    expect(root!.body).toBe("# Title\n\nintro\n\n## A\nbody a");
  });

  it("returns an empty document as no chunks", () => {
    expect(chunkDocument("\n\n  \n")).toEqual([]);
  });

  it("emits a body exactly at the size budget unchanged", () => {
    const body = "x".repeat(100);
    expect(chunkDocument(body, { size: 100 }).map((c) => c.body)).toEqual([body]);
  });

  it("breaks an oversized doc into a preamble row plus one section per child", () => {
    const a = para("alpha", 175);
    const b = para("beta", 175);
    const body = `# Title\nintro\n\n## A\n${a}\n\n## B\n${b}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0 });
    expectWellFormed(chunks);

    expect(chunks.map((c) => c.path)).toEqual(["0", "0.0", "0.1"]);
    expect(chunks[0]).toMatchObject({
      kind: "section",
      depth: 1,
      heading: "Title",
      headingPath: ["Title"],
      parentPath: null,
      body: "# Title\nintro",
      startLine: 1,
      endLine: 2,
    });
    expect(chunks[1]).toMatchObject({
      kind: "section",
      depth: 2,
      heading: "A",
      headingPath: ["Title", "A"],
      parentPath: "0",
      body: `## A\n${a}`,
      startLine: 4,
      endLine: 5,
    });
    expect(chunks[2]).toMatchObject({
      heading: "B",
      headingPath: ["Title", "B"],
      parentPath: "0",
      startLine: 7,
      endLine: 8,
    });
    expect(chunks[2]!.body).not.toContain(a);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(200);
  });

  it("keeps a section whole when it fits, only descending when it does not", () => {
    const small = para("tiny", 40);
    const big = para("huge", 175);
    const body = `# Doc\n\n## Small\n${small}\n\n## Big\n${big}\n\n### Deep\n${big}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0 });
    expectWellFormed(chunks);
    const paths = byPath(chunks);

    expect(paths.get("0.0")).toMatchObject({ heading: "Small", body: `## Small\n${small}` });
    // "Big" is too large with its child: it is emitted as its own preamble row,
    // and "Deep" descends from it.
    expect(paths.get("0.1")).toMatchObject({ heading: "Big", depth: 2, body: `## Big\n${big}` });
    expect(paths.get("0.1.0")).toMatchObject({
      heading: "Deep",
      depth: 3,
      parentPath: "0.1",
      headingPath: ["Doc", "Big", "Deep"],
      body: `### Deep\n${big}`,
    });
  });

  it("always emits an ancestor row, even when its preamble is only the heading", () => {
    const big = para("body", 175);
    const body = `# Guide\n\n## Install\n\n### macOS\n${big}\n\n### Linux\n${big}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0 });
    expectWellFormed(chunks);
    const paths = byPath(chunks);

    expect(paths.get("0")).toMatchObject({ heading: "Guide", body: "# Guide", startLine: 1, endLine: 1 });
    expect(paths.get("0.0")).toMatchObject({
      heading: "Install",
      parentPath: "0",
      body: "## Install",
      startLine: 3,
      endLine: 3,
    });
    expect(paths.get("0.0.0")).toMatchObject({ heading: "macOS", parentPath: "0.0", headingPath: ["Guide", "Install", "macOS"] });
    expect(paths.get("0.0.1")).toMatchObject({ heading: "Linux", parentPath: "0.0", headingPath: ["Guide", "Install", "Linux"] });
    // Bodies carry no breadcrumb.
    for (const c of chunks) expect(c.body.startsWith(">")).toBe(false);
  });

  it("wraps a preamble plus several top-level headings in a file root", () => {
    const big = para("text", 150);
    const body = `Lead-in.\n\n# One\n${big}\n\n# Two\n${big}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0 });
    expectWellFormed(chunks);
    expect(chunks[0]).toMatchObject({ kind: "file", depth: 0, heading: null, headingPath: [], body: "Lead-in." });
    expect(chunks[1]).toMatchObject({ kind: "section", depth: 1, parentPath: "0", headingPath: ["One"] });
    expect(chunks[2]).toMatchObject({ kind: "section", depth: 1, parentPath: "0", headingPath: ["Two"] });
  });

  it("packs an oversized leaf into paragraph children with overlap", () => {
    const paras = Array.from({ length: 6 }, (_, i) => para(`p${i}`, 90));
    const body = `# Leaf\n\n${paras.join("\n\n")}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 20 });
    expectWellFormed(chunks);

    expect(chunks[0]).toMatchObject({ kind: "section", heading: "Leaf", body: "# Leaf", path: "0" });
    const kids = chunks.slice(1);
    expect(kids.length).toBeGreaterThanOrEqual(3);
    for (const k of kids) {
      expect(k).toMatchObject({ kind: "paragraph", parentPath: "0", depth: 2, heading: null, headingPath: ["Leaf"] });
    }
    // Each paragraph chunk after the first opens with the tail of the previous one.
    for (let i = 1; i < kids.length; i++) {
      expect(kids[i - 1]!.body.endsWith(kids[i]!.body.slice(0, 20))).toBe(true);
    }
    // Line numbers point at the real paragraphs, not the bled tail.
    expect(kids[0]!.startLine).toBe(3);
    expect(kids[kids.length - 1]!.endLine).toBe(3 + (paras.length - 1) * 2);
  });

  it("keeps a fenced code block whole as a `code` child", () => {
    const code = ["```ts", ...Array.from({ length: 12 }, (_, i) => `const v${i} = ${i}; // ${"pad".repeat(8)}`), "```"].join("\n");
    expect(code.length).toBeGreaterThan(200);
    const body = `# Snippet\n\n${para("before", 120)}\n\n${code}\n\n${para("after", 120)}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0 });
    expectWellFormed(chunks);

    const codeChunk = chunks.find((c) => c.kind === "code");
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.body).toBe(code);
    expect(codeChunk!.parentPath).toBe("0");
    expect(codeChunk!.startLine).toBe(5);
    expect(codeChunk!.endLine).toBe(5 + 13);
    expect(chunks.filter((c) => c.kind === "paragraph").map((c) => c.body)).toEqual([para("before", 120), para("after", 120)]);
  });

  it("does not treat a '#' line inside a fence as a heading", () => {
    const body = "# Real\n\n```sh\n# not a heading\necho hi\n```\n\n## Next\ntext";
    const chunks = chunkDocument(body, { size: 30, overlap: 0 });
    expectWellFormed(chunks);
    expect(chunks.map((c) => c.heading)).toEqual(["Real", null, "Next"]);
    expect(chunks[1]).toMatchObject({ kind: "code", body: "```sh\n# not a heading\necho hi\n```" });
  });

  it("gives plain text one file root with paragraph children when too long", () => {
    // Unique tokens so any window of text identifies one position in the body.
    const body = Array.from({ length: 200 }, (_, i) => `t${String(i).padStart(3, "0")}`).join(" ");
    expect(body.length).toBeGreaterThan(400);

    const overlapped = chunkDocument(body, { size: 400, overlap: 50 });
    expectWellFormed(overlapped);
    expect(overlapped[0]).toMatchObject({ kind: "file", depth: 0, path: "0", body: "" });
    const kids = overlapped.slice(1);
    expect(kids.length).toBeGreaterThanOrEqual(3);
    for (const k of kids) expect(k).toMatchObject({ kind: "paragraph", depth: 1, parentPath: "0", headingPath: [] });
    for (let i = 1; i < kids.length; i++) {
      expect(kids[i - 1]!.body).toContain(kids[i]!.body.slice(0, 30));
    }

    const clean = chunkDocument(body, { size: 400, overlap: 0 }).slice(1);
    expect(clean.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < clean.length; i++) {
      expect(clean[i - 1]!.body).not.toContain(clean[i]!.body.slice(0, 30));
    }
    // With no overlap the chunks partition the body exactly.
    expect(clean.map((c) => c.body).join("").replace(/\s+/g, "")).toBe(body.replace(/\s+/g, ""));
    for (const c of clean) expect(c.body.length).toBeLessThanOrEqual(400);
  });

  it("ignores headings when format is text", () => {
    const body = `# A\n${para("a", 150)}\n\n# B\n${para("b", 150)}`;
    const chunks = chunkDocument(body, { size: 200, overlap: 0, format: "text" });
    expectWellFormed(chunks);
    expect(chunks.every((c) => c.heading === null)).toBe(true);
    expect(chunks[0]!.kind).toBe("file");
    expect(chunks.slice(1).every((c) => c.kind === "paragraph")).toBe(true);
  });

  it("tracks line numbers through blank lines and CRLF", () => {
    const body = "\r\n\r\n# Top\r\n\r\ntext\r\n\r\n";
    const [chunk] = chunkDocument(body);
    expect(chunk).toMatchObject({ startLine: 3, endLine: 5, body: "# Top\n\ntext" });
  });
});

describe("chunkEmbeddingInput", () => {
  it("prefixes the body with the heading breadcrumb", () => {
    expect(chunkEmbeddingInput({ headingPath: ["README", "Install"], body: "run it" })).toBe(
      "README > Install\n\nrun it",
    );
  });

  it("is just the body when there are no headings", () => {
    expect(chunkEmbeddingInput({ headingPath: [], body: "plain" })).toBe("plain");
  });
});
