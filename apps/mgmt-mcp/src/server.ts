import type { CommandContext } from "@ask/cli";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTools } from "./tools.js";

/**
 * One tool per CLI command, generated from the `@ask/cli` registry; each call
 * is exactly `registry.run(args, ctx)` with surface "mcp", returning what
 * `ask <cmd> --json` would print. No other logic lives here.
 */
export function createMgmtMcpServer(ctx: CommandContext): McpServer {
  const server = new McpServer(
    { name: "ask-mgmt", version: "0.1.0" },
    {
      instructions:
        "Management tools for the Ask knowledge engine: ask/search, add and " +
        "review knowledge, approve update proposals, rate answers, read stats, " +
        "trigger jobs. Each tool mirrors one `ask` CLI command and returns JSON.",
    },
  );

  for (const tool of buildTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.command.args.shape },
      async (args) => {
        try {
          const data = await tool.command.run(args, ctx);
          return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }
  return server;
}
