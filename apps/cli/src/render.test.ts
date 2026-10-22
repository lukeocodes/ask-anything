import { describe, expect, it } from "vitest";
import { ask, keyValues, proposalCreate, proposalsList, search } from "./render.js";

describe("render", () => {
  it("ask prints the answer, numbered sources and the answer id", () => {
    const out = ask({
      answer: "Use a Bearer token.",
      citations: [{ id: "a", title: "Auth docs", url: "https://x/auth" }, { id: "b" }],
      answerId: "ans-1",
      model: "m",
      visibility: "public",
    });
    expect(out).toBe(
      "Use a Bearer token.\n\nSources:\n  1. Auth docs — https://x/auth\n  2. b\n\nanswer ans-1 · m · public",
    );
    expect(ask({ answer: "no", abstained: true, citations: [] })).toMatch(/^\(abstained\)\nno$/);
  });

  it("search lists hits or says so", () => {
    expect(search({ hits: [] })).toBe("No results.");
    expect(search({ hits: [{ id: "1", title: "T", url: "u", body: "some  body\ntext", score: 0.5 }] })).toBe(
      "[1] T (u) [0.50]\n    some body text",
    );
  });

  it("keyValues aligns keys and proposals fall back cleanly", () => {
    expect(keyValues({ p95: 1.23456, hits: 3 })).toBe("p95   1.235\nhits  3");
    expect(proposalsList({ proposals: [] })).toBe("No pending proposals.");
    expect(proposalsList({ proposals: [{ id: "p1", diff: { kind: "upstream_changed" }, itemId: "i1" }] })).toBe(
      "p1  upstream_changed  i1",
    );
    expect(proposalsList({ proposals: [{ id: "p2", status: "pending", itemId: "i2", proposedBy: "ops" }] })).toBe(
      "p2  pending  i2  by ops",
    );
  });

  it("proposalCreate says whether the proposal is new", () => {
    expect(proposalCreate({ proposal: { id: "p1", itemId: "i1" }, created: true })).toBe("Proposed: p1 for item i1");
    expect(proposalCreate({ proposal: { id: "p1", itemId: "i1" }, created: false })).toBe(
      "Already pending: p1 for item i1",
    );
  });
});
