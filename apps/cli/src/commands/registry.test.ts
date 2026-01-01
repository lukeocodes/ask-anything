import { describe, expect, it } from "vitest";
import { commands, getCommand, resolveCommand } from "./registry.js";

describe("command registry", () => {
  it("has unique, lowercase, space-separated names", () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z-]*( [a-z][a-z-]*)*$/);
  });

  it("every command's example parses against its args schema", () => {
    for (const c of commands) {
      const r = c.args.safeParse(c.example);
      expect(r.success, `${c.name}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });

  it("every positional names a key in the schema", () => {
    for (const c of commands) {
      for (const p of c.positionals ?? []) expect(Object.keys(c.args.shape), c.name).toContain(p);
    }
  });

  it("only the two SSE commands stream", () => {
    expect(commands.filter((c) => c.streaming).map((c) => c.name).sort()).toEqual(["ask stream", "events tail"]);
  });

  it("covers every REST endpoint", () => {
    expect(commands.map((c) => c.name).sort()).toEqual(
      [
        "ask",
        "ask stream",
        "cache invalidate",
        "chunks context",
        "events tail",
        "feedback",
        "health",
        "jobs run",
        "knowledge add",
        "knowledge chunks",
        "knowledge gaps",
        "knowledge get",
        "knowledge refresh",
        "knowledge reviews",
        "knowledge visibility",
        "proposals approve",
        "proposals list",
        "proposals reject",
        "questions top",
        "search",
        "sources adapters",
        "sources add",
        "sources disable",
        "sources enable",
        "sources get",
        "sources index",
        "sources index-all",
        "sources list",
        "sources remove",
        "sources update",
        "stats",
        "stats knowledge",
      ].sort(),
    );
  });
});

describe("resolveCommand", () => {
  it("prefers the longest matching name", () => {
    expect(resolveCommand(["ask", "stream", "hi"])?.command.name).toBe("ask stream");
    expect(resolveCommand(["ask", "hi"])?.command.name).toBe("ask");
    expect(resolveCommand(["stats", "knowledge"])?.command.name).toBe("stats knowledge");
    expect(resolveCommand(["stats"])?.command.name).toBe("stats");
  });

  it("returns the remaining tokens", () => {
    expect(resolveCommand(["proposals", "approve", "abc"])?.rest).toEqual(["abc"]);
    expect(resolveCommand([])).toBeUndefined();
    expect(getCommand("knowledge add")?.name).toBe("knowledge add");
  });

  it("reads unmatched argv as the root `ask` command (the binary is `ask`)", () => {
    expect(resolveCommand(["How do I auth?"])).toMatchObject({ command: { name: "ask" }, rest: ["How do I auth?"] });
    expect(resolveCommand(["stream", "How do I auth?"])).toMatchObject({
      command: { name: "ask stream" },
      rest: ["How do I auth?"],
    });
    expect(resolveCommand(["nope", "--limit", "3"])).toMatchObject({ command: { name: "ask" }, rest: ["nope", "--limit", "3"] });
    // `ask ask "q"` still works; registry names are unchanged for the management MCP.
    expect(resolveCommand(["ask", "q"])?.rest).toEqual(["q"]);
  });
});
