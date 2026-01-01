#!/usr/bin/env -S npx tsx
import { createAskMcpServer, httpEngine } from "@ask/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Stdio MCP server for local clients (Claude Desktop, Cursor, …). It's a thin
 * proxy: the `ask`/`search` tools call the hosted REST API over HTTP with an API
 * key, so no DB/model access is needed on the client machine.
 *
 * Configure the client to run this with:
 *   ASK_API_URL=https://<service-url>  ASK_API_KEY=<key>
 * Never write anything but MCP protocol frames to stdout — diagnostics go to
 * stderr.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.ASK_API_URL;
  const apiKey = process.env.ASK_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(
      "[ask-mcp] Missing config. Set ASK_API_URL (hosted service URL) and ASK_API_KEY.",
    );
    process.exit(1);
  }

  const server = createAskMcpServer(httpEngine({ baseUrl, apiKey }), {
    name: process.env.ASK_NAME,
    description: process.env.ASK_DESCRIPTION,
  });
  await server.connect(new StdioServerTransport());
  console.error("[ask-mcp] stdio server ready");
}

main().catch((err) => {
  console.error("[ask-mcp] fatal:", err);
  process.exit(1);
});
