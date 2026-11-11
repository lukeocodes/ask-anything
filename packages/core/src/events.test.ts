import { describe, expect, it } from "vitest";
import { gapAnsweredPayload } from "./events.js";

describe("gapAnsweredPayload", () => {
  it("names the cluster so one answer closes every paraphrase in it", () => {
    expect(gapAnsweredPayload({ question: "how do I stream?", questionId: "q1" }, "backfill")).toEqual({
      question: "how do I stream?",
      surface: "backfill",
      questionId: "q1",
    });
  });

  it("falls back to text alone for an unclustered gap", () => {
    expect(gapAnsweredPayload({ question: "how do I stream?", questionId: null }, "backfill")).toEqual({
      question: "how do I stream?",
      surface: "backfill",
    });
  });
});
