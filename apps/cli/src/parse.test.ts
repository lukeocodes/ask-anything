import { describe, expect, it } from "vitest";
import { getCommand } from "./commands/registry.js";
import { invocation, kebab, parseCommandArgs, splitGlobals, usage } from "./parse.js";

const cmd = (name: string) => getCommand(name)!;

describe("splitGlobals", () => {
  it("extracts global flags from anywhere in argv", () => {
    const { globals, rest } = splitGlobals(["ask", "--json", "hi", "--api-url", "http://x", "--api-key=k"]);
    expect(globals).toEqual({ json: true, help: false, apiUrl: "http://x", apiKey: "k" });
    expect(rest).toEqual(["ask", "hi"]);
  });
});

describe("parseCommandArgs", () => {
  it("fills positionals in order and coerces flags from the schema", () => {
    expect(parseCommandArgs(cmd("ask"), ["why?", "--limit", "3", "--visibility=private"])).toEqual({
      question: "why?",
      limit: 3,
      visibility: "private",
    });
    expect(() => parseCommandArgs(cmd("ask"), ["why?", "--live"])).toThrow(/unknown flag --live/);
  });

  it("parses source config and credential env flags", () => {
    expect(
      parseCommandArgs(cmd("sources add"), ["https://x/y", "--config", '{"org":"acme"}', "--credential-env", "GH_TOKEN"]),
    ).toEqual({ locator: "https://x/y", config: { org: "acme" }, credentialEnv: "GH_TOKEN" });
    expect(parseCommandArgs(cmd("sources update"), ["id", "--credential-env=GH_TOKEN"])).toEqual({
      id: "id",
      credentialEnv: "GH_TOKEN",
    });
  });

  it("splits arrays on commas and parses json records", () => {
    expect(
      parseCommandArgs(cmd("knowledge add"), ["--body", "x", "--tags", "a, b", "--metadata", '{"k":1}']),
    ).toEqual({ body: "x", tags: ["a", "b"], metadata: { k: 1 } });
  });

  it("validates enums and rejects unknown flags", () => {
    expect(() => parseCommandArgs(cmd("jobs run"), ["nope"])).toThrow(/<job>/);
    expect(() => parseCommandArgs(cmd("jobs run"), ["verify", "--source", "x"])).toThrow(/unknown flag --source/);
    expect(parseCommandArgs(cmd("jobs run"), ["verify"])).toEqual({ job: "verify" });
    expect(() => parseCommandArgs(cmd("search"), ["q", "--bogus", "1"])).toThrow(/unknown flag --bogus/);
    expect(() => parseCommandArgs(cmd("search"), ["q", "--limit", "x"])).toThrow(/expects a number/);
    expect(() => parseCommandArgs(cmd("search"), ["q", "extra"])).toThrow(/unexpected argument/);
  });

  it("requires positionals", () => {
    expect(() => parseCommandArgs(cmd("feedback"), ["id"])).toThrow(/<rating>/);
    expect(parseCommandArgs(cmd("feedback"), ["id", "up", "--comment", "ok"])).toEqual({
      answerId: "id",
      rating: "up",
      comment: "ok",
    });
  });
});

describe("usage", () => {
  it("renders from the schema", () => {
    expect(kebab("sourceType")).toBe("source-type");
    expect(usage(cmd("jobs run"))).toBe("jobs run <verify|decay|backfill>");
    expect(usage(cmd("knowledge refresh"))).toBe("knowledge refresh <id>");
    expect(usage(cmd("knowledge visibility"))).toBe("knowledge visibility <id> <public|private>");
    expect(usage(cmd("ask"))).not.toContain("--live");
    expect(usage(cmd("knowledge add"))).toContain("[--file <text>]");
    expect(usage(cmd("sources add"))).toContain("[--config <json>] [--credential-env <text>]");
    expect(usage(cmd("sources adapters"))).toBe("sources adapters");
  });

  it("shows the question commands as the root of the `ask` binary", () => {
    expect(invocation(cmd("ask"))).toMatch(/^ask "<question>" \[--visibility/);
    expect(invocation(cmd("ask stream"))).toMatch(/^ask stream "<question>" /);
    expect(invocation(cmd("stats"))).toBe("ask stats");
    expect(invocation(cmd("knowledge refresh"))).toBe("ask knowledge refresh <id>");
  });
});
