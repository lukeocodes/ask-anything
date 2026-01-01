import { commands, type Command } from "@ask/cli";

/**
 * The MCP tool list is the CLI registry, nothing more. Streaming commands have
 * no place in a request/response tool call, so they are skipped and listed.
 */
export const SKIPPED_COMMANDS: readonly string[] = commands
  .filter((c) => c.streaming)
  .map((c) => c.name);

/** "proposals approve" → "proposals_approve". */
export function toolName(commandName: string): string {
  return commandName.replace(/ /g, "_");
}

export interface ToolSpec {
  name: string;
  description: string;
  command: Command;
}

export function buildTools(): ToolSpec[] {
  return commands
    .filter((c) => !c.streaming)
    .map((c) => ({ name: toolName(c.name), description: c.description, command: c }));
}
