import type { AskEngine, AskEngineResult, SearchHit } from "./types.js";

/**
 * An AskEngine that proxies to the hosted REST API. Used by the stdio binary so
 * a local MCP client (Claude Desktop, Cursor, …) reaches the hosted engine over
 * HTTP with an API key — no DB/model access needed on the client.
 */
export function httpEngine(cfg: { baseUrl: string; apiKey: string }): AskEngine {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
  };

  return {
    async ask(question, opts) {
      const res = await fetch(`${base}/v1/ask`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          question,
          surface: "mcp",
          context: opts?.context,
          limit: opts?.limit,
        }),
      });
      if (!res.ok) {
        throw new Error(`ask failed: HTTP ${res.status} — ${await res.text()}`);
      }
      const j = (await res.json()) as {
        answer: string;
        citedIds?: string[];
        citations?: { id: string; title?: string; url?: string }[];
        abstained?: boolean;
        model?: string;
      };
      return {
        answer: j.answer,
        // Prefer the resolved citations (title + url); fall back to bare ids.
        citations: j.citations ?? (j.citedIds ?? []).map((id) => ({ id })),
        abstained: Boolean(j.abstained),
        model: j.model,
      } satisfies AskEngineResult;
    },

    async search(query, opts) {
      const res = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, limit: opts?.limit }),
      });
      if (!res.ok) {
        throw new Error(`search failed: HTTP ${res.status} — ${await res.text()}`);
      }
      const j = (await res.json()) as { hits?: SearchHit[] };
      return j.hits ?? [];
    },
  };
}
