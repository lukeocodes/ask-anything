import { describe, expect, it } from "vitest";
import { buildChunkTree, type ChunkRow } from "./chunks.js";

const row = (id: string, parentId: string | null, ord: number): ChunkRow => ({
  id,
  itemId: "item",
  ord,
  parentId,
  depth: 0,
  heading: null,
  headingPath: [],
  path: id,
  kind: "section",
  startLine: 1,
  endLine: 1,
  body: id,
  createdAt: new Date(0),
});

describe("buildChunkTree", () => {
  it("nests rows by parentId, keeping document order", () => {
    const rows = [row("0", null, 0), row("0.0", "0", 1), row("0.0.0", "0.0", 2), row("0.1", "0", 3)];
    const tree = buildChunkTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.chunk.id).toBe("0");
    expect(tree[0]!.children.map((n) => n.chunk.id)).toEqual(["0.0", "0.1"]);
    expect(tree[0]!.children[0]!.children.map((n) => n.chunk.id)).toEqual(["0.0.0"]);
  });

  it("treats a row whose parent is absent as a root", () => {
    const tree = buildChunkTree([row("0.1", "0", 0), row("0.1.0", "0.1", 1)]);
    expect(tree.map((n) => n.chunk.id)).toEqual(["0.1"]);
    expect(tree[0]!.children.map((n) => n.chunk.id)).toEqual(["0.1.0"]);
  });

  it("returns an empty forest for no rows", () => {
    expect(buildChunkTree([])).toEqual([]);
  });
});
