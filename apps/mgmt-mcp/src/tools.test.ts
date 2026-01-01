import { commands } from "@ask/cli";
import { describe, expect, it } from "vitest";
import { SKIPPED_COMMANDS, buildTools, toolName } from "./tools.js";

describe("mgmt-mcp tools", () => {
  it("is the CLI registry minus the streaming commands", () => {
    const expected = commands
      .filter((c) => !SKIPPED_COMMANDS.includes(c.name))
      .map((c) => c.name.replace(/ /g, "_"))
      .sort();
    expect(buildTools().map((t) => t.name).sort()).toEqual(expected);
    expect(SKIPPED_COMMANDS).toEqual(["ask stream", "events tail"]);
  });

  it("names tools with underscores and keeps descriptions", () => {
    expect(toolName("proposals approve")).toBe("proposals_approve");
    for (const t of buildTools()) {
      expect(t.name).toMatch(/^[a-z_-]+$/);
      expect(t.description).toBe(t.command.description);
    }
  });
});
