import { describe, expect, it } from "vitest";
import {
  EDITED_ORIGIN,
  SOURCE_ORIGIN,
  baselineOf,
  editedAction,
  isEdited,
  isRemovalProposal,
  isSourceProposal,
  metadataAfterHumanApproval,
  pendingAction,
  reattachedMetadata,
  sourceProposer,
} from "./edits.js";

describe("editedAction", () => {
  it("holds while upstream still matches the baseline", () => {
    expect(editedAction("base", "edit", "base")).toBe("hold");
  });

  it("re-attaches when upstream caught up with the edit", () => {
    expect(editedAction("base", "edit", "edit")).toBe("reattach");
  });

  it("proposes when upstream moved somewhere else", () => {
    expect(editedAction("base", "edit", "new")).toBe("propose");
  });

  it("holds a title-only edit (edited hash equals baseline) until upstream moves", () => {
    expect(editedAction("same", "same", "same")).toBe("hold");
    expect(editedAction("same", "same", "new")).toBe("propose");
  });

  it("proposes on a missing baseline unless upstream equals the edit", () => {
    expect(editedAction(undefined, "edit", "edit")).toBe("reattach");
    expect(editedAction(undefined, "edit", "other")).toBe("propose");
  });
});

describe("pendingAction", () => {
  it("inserts with nothing pending", () => {
    expect(pendingAction(undefined)).toBe("insert");
  });

  it("replaces a pending source proposal", () => {
    expect(pendingAction({ proposedBy: sourceProposer("s1") })).toBe("replace");
  });

  it("waits behind a pending human proposal", () => {
    expect(pendingAction({ proposedBy: "support-bot" })).toBe("wait");
    expect(pendingAction({ proposedBy: null })).toBe("wait");
  });
});

describe("proposal kinds", () => {
  it("tells source proposals from key proposals by proposedBy", () => {
    expect(isSourceProposal({ proposedBy: "source:abc" })).toBe(true);
    expect(isSourceProposal({ proposedBy: "ops" })).toBe(false);
    expect(isSourceProposal({ proposedBy: null })).toBe(false);
  });

  it("spots removal proposals", () => {
    expect(isRemovalProposal({ diff: { action: "remove" } })).toBe(true);
    expect(isRemovalProposal({ diff: { upstreamHash: "x" } })).toBe(false);
    expect(isRemovalProposal({ diff: null })).toBe(false);
  });
});

describe("owner metadata", () => {
  it("detaches a source record with its pre-edit hash as the baseline", () => {
    const before = { origin: SOURCE_ORIGIN, contentHash: "upstream", path: "a.md" };
    const after = { origin: SOURCE_ORIGIN, contentHash: "edited", path: "a.md" };
    const m = metadataAfterHumanApproval(before, after);
    expect(m).toEqual({ origin: EDITED_ORIGIN, contentHash: "edited", path: "a.md", baselineHash: "upstream" });
    expect(isEdited({ metadata: m })).toBe(true);
    expect(baselineOf({ metadata: m })).toBe("upstream");
  });

  it("keeps the baseline on a second edit", () => {
    const before = { origin: EDITED_ORIGIN, contentHash: "edit1", baselineHash: "upstream" };
    const after = { origin: EDITED_ORIGIN, contentHash: "edit2" };
    expect(metadataAfterHumanApproval(before, after)).toMatchObject({ origin: EDITED_ORIGIN, contentHash: "edit2", baselineHash: "upstream" });
  });

  it("leaves hand-curated records alone", () => {
    const after = { contentHash: "x" };
    expect(metadataAfterHumanApproval({ contentHash: "y" }, after)).toBe(after);
    expect(metadataAfterHumanApproval(null, null)).toBeNull();
  });

  it("re-attach drops the baseline and sets origin back to source", () => {
    expect(reattachedMetadata({ origin: EDITED_ORIGIN, baselineHash: "b", path: "a.md" })).toEqual({ origin: SOURCE_ORIGIN, path: "a.md" });
    expect(reattachedMetadata(null)).toEqual({ origin: SOURCE_ORIGIN });
  });
});
