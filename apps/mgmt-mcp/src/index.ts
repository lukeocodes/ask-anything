#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMgmtMcpServer } from "./server.js";
import { SKIPPED_COMMANDS, buildTools } from "./tools.js";

/**
 * Management MCP server (stdio) — the `ask` CLI's registry exposed as tools.
 *
 *   ASK_API_URL=https://<service-url>  ASK_API_KEY=<key>
 * Never write anything but MCP frames to stdout — diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const apiUrl = process.env.ASK_API_URL ?? "http://localhost:3000";
  const apiKey = process.env.ASK_API_KEY;
  if (!apiKey) {
    console.error("[ask-mgmt-mcp] Missing config. Set ASK_API_KEY (and ASK_API_URL for a hosted service).");
    process.exit(1);
  }
  const server = createMgmtMcpServer({ apiUrl, apiKey, surface: "mcp" });
  await server.connect(new StdioServerTransport());
  console.error(
    `[ask-mgmt-mcp] stdio server ready (${buildTools().length} tools; skipped streaming: ${SKIPPED_COMMANDS.join(", ")})`,
  );
}

main().catch((err) => {
  console.error("[ask-mgmt-mcp] fatal:", err);
  process.exit(1);
});
