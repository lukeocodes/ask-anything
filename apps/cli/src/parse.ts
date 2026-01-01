import { z } from "zod";
import type { Command } from "./commands/registry.js";

/**
 * argv → command args, driven entirely by the command's zod schema: positionals
 * fill the keys listed in `positionals` in order; everything else is a flag
 * whose name is the kebab-case of its key (`sourceType` → `--source-type`).
 * Values are coerced from their zod type — numbers parsed, booleans take no
 * value, arrays split on commas, records parsed as JSON.
 */

export const GLOBAL_FLAGS = ["json", "api-url", "api-key", "help"] as const;

export interface Globals {
  json: boolean;
  help: boolean;
  apiUrl?: string;
  apiKey?: string;
}

export function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

type Kind = "string" | "number" | "boolean" | "array" | "json" | "enum";

/** Unwrap optional/default/nullable wrappers to the underlying schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodDefault) s = s._def.innerType;
    else return s;
  }
}

export function kindOf(schema: z.ZodTypeAny): Kind {
  const s = unwrap(schema);
  if (s instanceof z.ZodNumber) return "number";
  if (s instanceof z.ZodBoolean) return "boolean";
  if (s instanceof z.ZodArray) return "array";
  if (s instanceof z.ZodRecord || s instanceof z.ZodObject) return "json";
  if (s instanceof z.ZodEnum) return "enum";
  return "string";
}

export function enumValues(schema: z.ZodTypeAny): string[] | undefined {
  const s = unwrap(schema);
  return s instanceof z.ZodEnum ? (s.options as string[]) : undefined;
}

export function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional();
}

function coerce(kind: Kind, raw: string, flag: string): unknown {
  switch (kind) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${raw}"`);
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${flag} expects true|false, got "${raw}"`);
    case "array":
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`${flag} expects JSON, got "${raw}"`);
      }
    default:
      return raw;
  }
}

/** Pull the global flags out of argv (they may appear anywhere). */
export function splitGlobals(argv: readonly string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = { json: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const eq = tok.indexOf("=");
    const name = tok.startsWith("--") ? (eq === -1 ? tok.slice(2) : tok.slice(2, eq)) : undefined;
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    if (name === "json") globals.json = true;
    else if (name === "help" || tok === "-h") globals.help = true;
    else if (name === "api-url" || name === "api-key") {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      if (name === "api-url") globals.apiUrl = value;
      else globals.apiKey = value;
    } else rest.push(tok);
  }
  return { globals, rest };
}

/** Parse the tokens after the command name into the command's args. */
export function parseCommandArgs(command: Command, tokens: readonly string[]): Record<string, unknown> {
  const shape = command.args.shape;
  const byFlag = new Map<string, string>(Object.keys(shape).map((k) => [kebab(k), k]));
  const positionals = [...(command.positionals ?? [])];
  const out: Record<string, unknown> = {};
  let onlyPositionals = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!onlyPositionals && tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const flag = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      const key = byFlag.get(flag);
      if (!key) throw new Error(`unknown flag --${flag} for "${command.name}"`);
      const kind = kindOf(shape[key]!);
      if (kind === "boolean" && inline === undefined) {
        out[key] = true;
        continue;
      }
      const raw = inline ?? tokens[++i];
      if (raw === undefined) throw new Error(`--${flag} needs a value`);
      out[key] = coerce(kind, raw, `--${flag}`);
      continue;
    }
    const key = positionals.shift();
    if (!key) throw new Error(`unexpected argument "${tok}" for "${command.name}"`);
    out[key] = coerce(kindOf(shape[key]!), tok, `<${key}>`);
  }

  const parsed = command.args.safeParse(out);
  if (!parsed.success) {
    const declared = command.positionals ?? [];
    const issues = parsed.error.issues
      .map((i) => {
        const key = i.path[0] === undefined ? undefined : String(i.path[0]);
        const where = key === undefined ? "args" : declared.includes(key) ? `<${key}>` : `--${kebab(key)}`;
        return `${where}: ${i.message}`;
      })
      .join("; ");
    throw new Error(`invalid arguments for "${command.name}": ${issues}`);
  }
  return parsed.data as Record<string, unknown>;
}

/** One-line usage for a command, generated from its schema. */
export function usage(command: Command): string {
  const shape = command.args.shape;
  const positionals = command.positionals ?? [];
  const parts = [command.name];
  for (const key of positionals) {
    const opts = enumValues(shape[key]!);
    const name = opts ? opts.join("|") : key;
    parts.push(isOptional(shape[key]!) ? `[${name}]` : `<${name}>`);
  }
  for (const [key, schema] of Object.entries(shape)) {
    if (positionals.includes(key)) continue;
    const kind = kindOf(schema);
    const opts = enumValues(schema);
    const value =
      kind === "boolean" ? "" : opts ? ` <${opts.join("|")}>` : kind === "array" ? " <a,b>" : kind === "json" ? " <json>" : kind === "number" ? " <n>" : " <text>";
    const flag = `--${kebab(key)}${value}`;
    parts.push(isOptional(schema) ? `[${flag}]` : flag);
  }
  return parts.join(" ");
}

/**
 * How a command is typed at the shell. The binary is `ask`, and the question
 * commands are the root: `ask "<question>"`, `ask stream "<question>"`;
 * everything else is `ask <command> …`.
 */
export function invocation(command: Command): string {
  const u = usage(command);
  const isAsk = command.name === "ask" || command.name.startsWith("ask ");
  return isAsk ? u.replace("<question>", '"<question>"') : `ask ${u}`;
}
