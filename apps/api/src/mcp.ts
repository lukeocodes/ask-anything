import { randomUUID } from "node:crypto";
import { loadEnv } from "@ask/config";
import { ask, reverifyItems } from "@ask/core";
import { type AskEngine, createAskMcpServer } from "@ask/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicSearch } from "./search.js";

/**
 * In-process engine: the MCP tools call core `ask()` + retrieval directly.
 * PUBLIC visibility only — this endpoint is unauthenticated (see mcpRoutes), so
 * it must never reach private knowledge or private egress.
 */
const coreEngine: AskEngine = {
  async ask(question, opts) {
    const r = await ask(question, {
      surface: "mcp",
      visibility: "public",
      context: opts?.context,
      limit: opts?.limit,
      scheduleReverify: (itemIds) => void reverifyItems(itemIds).catch(() => {}),
    });
    return {
      answer: r.answer,
      citations: r.citations,
      abstained: r.abstained,
      model: r.model,
    };
  },
  async search(query, opts) {
    const hits = await publicSearch(query, opts?.limit);
    return hits.map((h) => ({
      id: h.id,
      title: h.title,
      url: h.url,
      body: h.body,
      source: h.source,
      confidence: h.confidence,
      score: h.score,
    }));
  },
};

function jsonRpcError(reply: FastifyReply, status: number, message: string): void {
  reply.hijack();
  reply.raw.statusCode = status;
  reply.raw.setHeader("content-type", "application/json");
  reply.raw.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

/**
 * Mount the Streamable HTTP MCP transport at `/mcp` (the current MCP spec's
 * remote transport). Stateful sessions keyed by `Mcp-Session-Id`:
 *   - POST with no session + an `initialize` request → new session (server + transport)
 *   - POST/GET/DELETE with a known session id → routed to that transport
 *   - GET streams server→client messages (SSE); DELETE ends the session
 *
 * This route is intentionally UNAUTHENTICATED (public engine). The engine is
 * pinned to public visibility, so no private data is reachable here. Session
 * state is in-memory — safe because the service runs as a single pinned instance.
 */
export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        // Known session id, but we have no transport for it — it expired (e.g.
        // the server restarted). 404 tells a spec-compliant client to drop the
        // id and re-initialize, rather than retry the dead session forever.
        return jsonRpcError(reply, 404, "Session expired or unknown; reinitialize.");
      }
      if (!isInitializeRequest(req.body)) {
        return jsonRpcError(reply, 400, "No valid session: send an initialize request first.");
      }
      // New session.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const env = loadEnv();
      const server = createAskMcpServer(coreEngine, {
        name: env.ASK_NAME,
        description: env.ASK_DESCRIPTION,
      });
      await server.connect(transport);
    }

    reply.hijack();
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error({ err }, "mcp POST failed");
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("content-type", "application/json");
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error." },
            id: null,
          }),
        );
      }
    }
  });

  // GET (server→client SSE stream) and DELETE (end session) — both require a
  // live session id.
  const bySession = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      jsonRpcError(reply, 400, "Unknown or missing Mcp-Session-Id.");
      return;
    }
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);
}
