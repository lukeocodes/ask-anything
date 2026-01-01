import { describe, expect, it } from "vitest";
import { agentTools } from "./agent.js";

describe("agentTools", () => {
  it("exposes exactly one tool, search_knowledge_base", () => {
    const tools = agentTools({ search: async () => [] });
    expect(Object.keys(tools)).toEqual(["search_knowledge_base"]);
  });

  it("routes the query and limit to the injected search and reports progress", async () => {
    const calls: { query: string; limit?: number }[] = [];
    const events: string[] = [];
    const tools = agentTools({
      search: async (query, limit) => {
        calls.push({ query, limit });
        return [{ id: "a", title: "A", content: "body" }];
      },
      onSearch: (q, phase, hits) => events.push(`${phase}:${q}:${hits ?? ""}`),
    });
    const out = await tools.search_knowledge_base.execute!(
      { query: "rate limits", limit: 3 },
      { toolCallId: "t1", messages: [], context: {} },
    );
    expect(calls).toEqual([{ query: "rate limits", limit: 3 }]);
    expect(out).toEqual({ results: [{ id: "a", title: "A", content: "body" }] });
    expect(events).toEqual(["start:rate limits:", "done:rate limits:1"]);
  });
});
