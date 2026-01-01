import { describe, expect, it } from "vitest";
import { defaultDecayRate, defaultVisibility } from "./knowledge.js";

describe("source-type defaults", () => {
  it("keeps the known kinds' values", () => {
    expect(defaultDecayRate("manual")).toBe(0.01);
    expect(defaultDecayRate("api")).toBe(0.015);
    expect(defaultDecayRate("git")).toBe(0.03);
    expect(defaultDecayRate("url")).toBe(0.03);
    expect(defaultVisibility("manual")).toBe("public");
    expect(defaultVisibility("api")).toBe("private");
    expect(defaultVisibility("git")).toBe("private");
  });

  it("falls back for an unknown adapter kind: decays like git, fails closed to private", () => {
    expect(defaultDecayRate("github-org")).toBe(defaultDecayRate("git"));
    expect(defaultVisibility("github-org")).toBe("private");
  });
});
