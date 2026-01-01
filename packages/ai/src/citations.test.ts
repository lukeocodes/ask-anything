import { describe, expect, it } from "vitest";
import type { GroundingChunk } from "./answer.js";
import { CitationRewriter, isAbstain, stripHedge, tidyCitations } from "./citations.js";

const chunk = (over: Partial<GroundingChunk> & { id: string }): GroundingChunk => ({
  title: over.id,
  body: "",
  source: "db",
  ...over,
});

const grounding: GroundingChunk[] = [
  chunk({ id: "a", url: "https://docs.example.com/a" }),
  chunk({ id: "b" }), // cited but nothing to link
  chunk({ id: "c", source: "url", url: "https://docs.example.com/c" }),
  chunk({ id: "priv", visibility: "private", url: "https://docs.example.com/priv" }),
  chunk({ id: "prv", url: "https://intranet.example.com/page", visibility: "private" }),
];

describe("CitationRewriter", () => {
  it("rewrites [id] to a numbered link and reuses the number on repeat", () => {
    const rw = new CitationRewriter(grounding);
    const out = rw.push("See [a], then [a] again.") + rw.flush();
    expect(out).toBe("See [1](https://docs.example.com/a), then [1](https://docs.example.com/a) again.");
    expect(rw.citedIds).toEqual(["a"]);
  });

  it("numbers linkable sources contiguously in first-appearance order", () => {
    const rw = new CitationRewriter(grounding);
    const out = rw.push("[c] then [b] then [a]") + rw.flush();
    expect(out).toBe("[1](https://docs.example.com/c) then  then [2](https://docs.example.com/a)");
    expect(rw.citedIds).toEqual(["c", "b", "a"]);
  });

  it("drops a marker for a grounded source with no url but still records it as cited", () => {
    const rw = new CitationRewriter(grounding);
    expect(rw.push("x [b] y") + rw.flush()).toBe("x  y");
    expect(rw.citedIds).toEqual(["b"]);
  });

  it("holds an unclosed marker across deltas", () => {
    const rw = new CitationRewriter(grounding);
    expect(rw.push("See [")).toBe("See ");
    expect(rw.push("a")).toBe("");
    expect(rw.push("] ok")).toBe("[1](https://docs.example.com/a) ok");
    expect(rw.flush()).toBe("");
  });

  it("flush() emits a still-unclosed [ verbatim", () => {
    const rw = new CitationRewriter(grounding);
    expect(rw.push("foo [bar")).toBe("foo ");
    expect(rw.flush()).toBe("[bar");
    expect(rw.flush()).toBe("");
  });

  it("drops invented citation-shaped markers not in the grounding", () => {
    const rw = new CitationRewriter(grounding);
    const out = rw.push("[0123456789abcdef0123-4567] and [6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f]") + rw.flush();
    expect(out).toBe(" and ");
    expect(rw.citedIds).toEqual([]);
  });

  it("leaves non-citation brackets alone", () => {
    const rw = new CitationRewriter(grounding);
    expect(rw.push("[link text](https://x) and [note]") + rw.flush()).toBe("[link text](https://x) and [note]");
  });

  it("never references a private source to a public caller", () => {
    const pub = new CitationRewriter(grounding);
    expect(pub.push("[priv]") + pub.flush()).toBe("");
    expect(pub.citedIds).toEqual(["priv"]);

    const priv = new CitationRewriter(grounding, { callerVisibility: "private" });
    expect(priv.push("[priv]") + priv.flush()).toBe("[1](https://docs.example.com/priv)");
  });


  it("defaults the caller to public (fail closed)", () => {
    const rw = new CitationRewriter(grounding, {});
    expect(rw.push("[priv][prv][a]") + rw.flush()).toBe("[1](https://docs.example.com/a)");
  });
});

describe("tidyCitations", () => {
  it("removes space before punctuation and collapses doubles", () => {
    expect(tidyCitations("See this .  And  that , ok !")).toBe("See this. And that, ok!");
  });
  it("trims", () => {
    expect(tidyCitations("  hi  ")).toBe("hi");
  });
});

describe("isAbstain", () => {
  it("is true only for the bare hedge with no citations", () => {
    expect(isAbstain("I don't have that yet.", [])).toBe(true);
    expect(isAbstain("  I dont have that yet  ", [])).toBe(true);
    expect(isAbstain("I don't have that yet!", [])).toBe(true);
  });
  it("is false when the hedge is followed by content", () => {
    expect(isAbstain("I don't have that yet. But the SDK supports X.", [])).toBe(false);
  });
  it("is false when anything was cited", () => {
    expect(isAbstain("I don't have that yet.", ["a"])).toBe(false);
  });
  it("is false for a normal answer", () => {
    expect(isAbstain("Use the client.", [])).toBe(false);
  });
});

describe("stripHedge", () => {
  it("strips a leading hedge and keeps the content", () => {
    expect(stripHedge("I don't have that yet. But X works.")).toBe("But X works.");
    expect(stripHedge("I dont have that yet\nX")).toBe("X");
  });
  it("leaves text without a leading hedge alone", () => {
    expect(stripHedge("X. I don't have that yet.")).toBe("X. I don't have that yet.");
  });
});
