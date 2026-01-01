#!/usr/bin/env -S npx tsx
import { commands, resolveCommand, type CommandContext } from "./commands/registry.js";
import { ApiError } from "./api.js";
import { invocation, parseCommandArgs, splitGlobals } from "./parse.js";

/**
 * `ask` — the management CLI. Everything it can do is declared in the command
 * registry; this file only turns argv into a registry call and prints the
 * result. Env: ASK_API_URL (default http://localhost:3000), ASK_API_KEY.
 */

const DEFAULT_API_URL = "http://localhost:3000";

function help(): string {
  const lines = [
    'Usage: ask "<question>" [flags]',
    '       ask stream "<question>" [flags]',
    "       ask <command> [args]",
    "Global flags: [--json] [--api-url <url>] [--api-key <key>]",
    "",
    "Commands:",
  ];
  for (const c of commands) {
    lines.push(`  ${invocation(c)}`);
    lines.push(`      ${c.description}`);
  }
  lines.push("", "Env: ASK_API_URL (default http://localhost:3000), ASK_API_KEY");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { globals, rest } = splitGlobals(argv);
  const resolved = resolveCommand(rest);

  if (globals.help || !resolved) {
    if (!resolved && rest.length > 0 && !globals.help) {
      process.stderr.write(`unknown command: ${rest.join(" ")}\n\n`);
    }
    if (resolved) {
      process.stdout.write(`Usage: ${invocation(resolved.command)}\n    ${resolved.command.description}\n`);
    } else {
      process.stdout.write(help() + "\n");
    }
    return resolved ? 0 : rest.length > 0 && !globals.help ? 2 : 0;
  }

  const { command, rest: tokens } = resolved;
  const args = parseCommandArgs(command, tokens);

  const apiKey = globals.apiKey ?? process.env.ASK_API_KEY;
  if (!apiKey) throw new Error("ASK_API_KEY is not set (or pass --api-key)");
  const ctx: CommandContext = {
    apiUrl: globals.apiUrl ?? process.env.ASK_API_URL ?? DEFAULT_API_URL,
    apiKey,
    surface: "cli",
    write: (t) => process.stdout.write(t),
  };

  const data = await command.run(args, ctx);
  if (data === undefined) return 0;
  const text = globals.json
    ? JSON.stringify(data, null, 2)
    : (command.render ?? ((d: unknown) => JSON.stringify(d, null, 2)))(data);
  process.stdout.write(text + "\n");
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  });
