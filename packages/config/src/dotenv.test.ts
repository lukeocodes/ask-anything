import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv.js";
import { loadEnv, resetEnvCache } from "./env.js";

describe("parseDotenv", () => {
  it("strips unquoted inline comments and keeps # inside quotes", () => {
    const env = parseDotenv(
      [
        "DAILY_COST_CAP_USD=0   # 0 = disabled",
        "PLAIN=value # trailing",
        'DQ="a # not a comment" # real comment',
        "SQ='x#y'",
        "URL=https://host/path#fragment",
        "# a comment line",
        "export EXPORTED=1",
      ].join("\n"),
    );
    expect(Object.fromEntries(env)).toEqual({
      DAILY_COST_CAP_USD: "0",
      PLAIN: "value",
      DQ: "a # not a comment",
      SQ: "x#y",
      URL: "https://host/path#fragment",
      EXPORTED: "1",
    });
  });

  it("treats KEY= as unset, including unsetting an earlier value", () => {
    const env = parseDotenv(["EMPTY=", "SET=1", "SET=", "SPACES=   ", "QUOTED_EMPTY=\"\""].join("\n"));
    expect(env.has("EMPTY")).toBe(false);
    expect(env.has("SET")).toBe(false);
    expect(env.has("SPACES")).toBe(false);
    // An explicitly quoted empty string is a value, not an unset.
    expect(env.get("QUOTED_EMPTY")).toBe("");
  });
});

describe(".env.example", () => {
  beforeEach(() => resetEnvCache());
  afterEach(() => resetEnvCache());

  it("loads through the parser and the env schema once a DB and a key are set", () => {
    const text = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
    const parsed = parseDotenv(text);
    // Blank optional fields (ANTHROPIC_BASE_URL=, LOGDRAIN_URL=, …) must not
    // reach the schema as "", which `.url().optional()` would reject.
    for (const v of parsed.values()) expect(v).not.toBe("");
    const source = {
      ...Object.fromEntries(parsed),
      DATABASE_URL: "postgres://ask:ask@localhost:5432/ask",
      ANTHROPIC_API_KEY: "sk-test",
      VOYAGE_API_KEY: "pa-test",
    };
    const env = loadEnv(source);
    expect(env.DATABASE_URL).toBe(source.DATABASE_URL);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.DAILY_COST_CAP_USD).toBe(0);
    expect(env.apiKeys.length).toBeGreaterThan(0);
  });
});
