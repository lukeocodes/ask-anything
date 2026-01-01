import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskEngine } from "./types.js";

export interface AskMcpServerOptions {
  /** Server name advertised in `serverInfo` (ASK_NAME). Default "ask-anything". */
  name?: string;
  /** One-line description of what the configured sources cover (ASK_DESCRIPTION). */
  description?: string;
}

const DEFAULT_NAME = "ask-anything";
const DEFAULT_DESCRIPTION = "a grounded knowledge engine over the configured sources";

/**
 * Build the MCP server: the `ask` and `search` tools over an injected engine.
 * Transport-agnostic — the caller connects it to stdio, Streamable HTTP, or
 * anything else. One server instance per session/connection. The name and
 * description come from the deployment (ASK_NAME / ASK_DESCRIPTION); this
 * package never reads env itself so thin clients can build it without one.
 */
export function createAskMcpServer(engine: AskEngine, opts: AskMcpServerOptions = {}): McpServer {
  const name = opts.name ?? DEFAULT_NAME;
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const server = new McpServer(
    { name, version: "0.1.0" },
    {
      instructions:
        `${name}: ${description}. It indexes the configured sources — ` +
        "registered repositories and sites, the documentation site, and saved " +
        "knowledge. Prefer these tools over cloning or browsing the sources " +
        "directly: any question about what exists, how something works, or how " +
        "to use the API should go here first. Use `ask` for a " +
        "grounded, cited answer to a natural-language question. Use `search` to " +
        "retrieve raw source passages when you want to reason over the grounding " +
        "yourself.",
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask",
      description:
        "Ask a question over the configured sources — registered repositories " +
        "and sites, the documentation site, and saved knowledge — and get a " +
        "grounded answer in Markdown with citations. Use it for how-it-works " +
        "questions, API and library usage, and anything the sources document. " +
        "Answers only from public knowledge.",
      inputSchema: {
        question: z.string().min(1).describe("The natural-language question to answer."),
        context: z
          .string()
          .optional()
          .describe("Optional prior conversation or extra context for the question."),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Max grounding sources to consult (default 8)."),
      },
    },
    async ({ question, context, limit }) => {
      const r = await engine.ask(question, { context, limit });
      const sources = r.citations.length
        ? "\n\n---\nSources:\n" +
          r.citations
            .map((c, i) => `${i + 1}. ${c.title ?? c.id}${c.url ? ` — ${c.url}` : ""}`)
            .join("\n")
        : "";
      return { content: [{ type: "text", text: r.answer + sources }] };
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search the configured sources for raw passages relevant to a query " +
        "(no synthesis) — registered repositories and sites, the documentation " +
        "site, and saved knowledge. Returns " +
        "ranked public knowledge chunks with titles and URLs.",
      inputSchema: {
        query: z.string().min(1).describe("The search query."),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Max passages to return (default 8)."),
      },
    },
    async ({ query, limit }) => {
      const hits = await engine.search(query, { limit });
      const text = hits.length
        ? hits
            .map(
              (h, i) =>
                `[${i + 1}] ${h.title ?? h.id}${h.url ? ` (${h.url})` : ""}\n${h.body}`,
            )
            .join("\n\n")
        : "No results.";
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
