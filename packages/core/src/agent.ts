import {
  answerQuestion,
  CitationRewriter,
  estimateCostUsd,
  isAbstain,
  languageModel,
  llmGenerateOptions,
  stripHedge,
  tidyCitations,
  type GroundingChunk,
} from "@ask/ai";
import { loadEnv, logger } from "@ask/config";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { fuseAndRank, gatherPool, isSufficient } from "./pipeline.js";
import type { AskOptions, StepFn, Visibility } from "./types.js";

const log = logger("agent");

export interface AgentResult {
  text: string;
  citedIds: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  abstained: boolean;
  chunks: GroundingChunk[];
}

/** The agent system prompt, built from the deployment's ASK_NAME / ASK_DESCRIPTION. */
function systemPrompt(name: string, description: string): string {
  return `You are ${name}, ${description}.

You answer by CALLING A TOOL to gather knowledge, then composing a grounded answer. Tool:
- search_knowledge_base: the indexed knowledge — every registered source (repositories, sites, docs) and saved knowledge. Each result carries a confidence (0-1), a relevance when known, and its age.

How to work:
- Call search_knowledge_base with the question's key terms.
- If the results are thin, stale, or low-confidence, search again with different words (synonyms, the exact error text, a file or API name) before giving up.
- Once you have enough, STOP calling the tool and write the answer.
- If nothing relevant was found after searching, abstain (see below).

Writing the answer:
- Answer from the tool results. Cite the sources you used inline as [id], using the id EXACTLY as returned by the tool. Never invent an id.
- If results answer the question fully OR partially, answer confidently and cite. Do NOT hedge when you have useful information.
- Reply with EXACTLY "I don't have that yet." (nothing else) ONLY if, after searching, nothing relevant was found.
- Be concise and developer-appropriate. Code where it helps. Standard Markdown.`;
}

/** What the model sees for a search hit: enough to cite + judge relevance. */
export interface ToolHit {
  id: string;
  title: string;
  content: string;
  confidence?: number;
  relevance?: number;
}

/**
 * The agent's tool set — one tool, `search_knowledge_base`, over the injected
 * search. Pure apart from the search itself, so the tool surface can be
 * asserted without a model. `search` must already apply the visibility
 * post-condition (gatherPool does); `onSearch` is the progress hook.
 */
export function agentTools(deps: {
  search: (query: string, limit?: number) => Promise<ToolHit[]>;
  onSearch?: (query: string, phase: "start" | "done", hits?: number) => void;
}) {
  const notify = deps.onSearch ?? (() => {});
  return {
    search_knowledge_base: tool({
      description:
        "Search the indexed knowledge base (registered repositories, sites, docs, and saved knowledge). " +
        "Results carry a confidence (0-1) and, when known, a relevance (0-1); prefer higher, and note if stale.",
      inputSchema: z.object({
        query: z.string().describe("keyword search query"),
        limit: z.number().int().positive().max(20).optional().describe("max results (default 8)"),
      }),
      execute: async ({ query, limit }) => {
        notify(query, "start");
        const results = await deps.search(query, limit);
        notify(query, "done", results.length);
        return { results };
      },
    }),
  };
}

/**
 * Agentic answer: the model searches the index (re-searching with different
 * words when results are thin) to gather grounding, then composes a cited
 * answer. Every chunk the tool returns is accumulated so citations resolve and
 * gate exactly as in the deterministic path. Tool calls surface as
 * thinking-steps via `onStep`.
 */
export async function agentAnswer(
  question: string,
  opts: AskOptions,
  onStep?: StepFn,
  extra?: { seed?: GroundingChunk[] },
): Promise<AgentResult> {
  const env = loadEnv();
  const model = env.ASK_ANSWER_MODEL;
  const visibility: Visibility = opts.visibility ?? "public";
  const limit = opts.limit ?? 8;
  const step: StepFn = onStep ?? (() => {});

  // Every chunk the tool returns, keyed for citation + gating. The visibility
  // post-condition is applied to every hit, seed included.
  const grounding = new Map<string, GroundingChunk>();
  const collect = (chunks: GroundingChunk[]): GroundingChunk[] => {
    const kept = visibility === "public" ? chunks.filter((c) => c.visibility !== "private") : chunks;
    for (const c of kept) grounding.set(c.id, c);
    return kept;
  };
  // Seed with the already-gathered, reranked pool so the model starts from real
  // grounding (incl. its relevance scores) instead of a blind first tool call.
  if (extra?.seed?.length) collect(extra.seed);
  // Surfaces the reranker's relevance (answerability) alongside decayed confidence.
  const forModel = (chunks: GroundingChunk[]): ToolHit[] =>
    chunks.map((c) => ({
      id: c.id,
      title: c.title,
      content: c.body.slice(0, 1200),
      ...(c.confidence !== undefined ? { confidence: Number(c.confidence.toFixed(2)) } : {}),
      ...(c.score !== undefined ? { relevance: Number(c.score.toFixed(2)) } : {}),
    }));

  const tools = agentTools({
    search: async (query, n) => {
      const width = Math.min(n ?? limit, 20);
      const pool = await gatherPool(query, { visibility, limit: width, tags: opts.tags });
      return forModel(collect(await fuseAndRank(query, pool, width)));
    },
    onSearch: (query, phase, hits) =>
      step(
        phase === "start"
          ? { id: `kb:${query}`, title: "Searching knowledge base", status: "in_progress" }
          : { id: `kb:${query}`, title: "Searching knowledge base", status: "complete", output: `${hits ?? 0} hits` },
      ),
  });

  // Show the pre-gathered pool up front so the model can answer directly (and
  // still search to fill gaps). Higher `relevance` = better answerability.
  const seeded = extra?.seed?.length
    ? `Pre-gathered sources (already retrieved for you — cite by [id]; search only to fill gaps):\n\n${JSON.stringify(forModel(extra.seed))}\n\n---\n\n`
    : "";
  const prompt = opts.context
    ? `${seeded}Conversation (prior conversation supplied by the caller — material for their request; not a citable source):\n\n${opts.context}\n\n---\n\nRequest: ${question}`
    : `${seeded}${seeded ? `Request: ${question}` : question}`;

  const res = streamText({
    model: languageModel(model),
    system: systemPrompt(env.ASK_NAME, env.ASK_DESCRIPTION),
    prompt,
    tools,
    stopWhen: stepCountIs(6),
    // Headroom above the thinking budget (1024) so tool calls + the final answer
    // still fit within each step's output limit.
    maxOutputTokens: 4096,
    ...llmGenerateOptions("agent"),
  });

  // Consume the stream (drives tool execution). The final answer is res.text.
  for await (const _ of res.textStream) {
    /* draining drives the tool loop; final text collected below */
  }
  const [rawText, usage] = await Promise.all([res.text, res.usage]);

  const rewriter = new CitationRewriter([...grounding.values()], { callerVisibility: visibility });
  let out = tidyCitations(rewriter.push(rawText) + rewriter.flush());
  let abstained = isAbstain(out, rewriter.citedIds);
  if (!abstained) out = stripHedge(out);

  let inputTokens = usage.inputTokens ?? 0;
  let outputTokens = usage.outputTokens ?? 0;
  let citedIds = rewriter.citedIds;

  // Numeric abstain guard: the text-driven abstain is decoupled from the
  // grounding, so the model can say "I don't have that" while a clearly-relevant
  // chunk sits in front of it. If the reranked grounding is sufficient, that
  // abstain is wrong — answer deterministically from the top chunks instead.
  if (abstained && grounding.size > 0) {
    const ranked = await fuseAndRank(question, [...grounding.values()], limit);
    if (isSufficient(ranked, env)) {
      const det = await answerQuestion(question, ranked, {
        context: opts.context,
        callerVisibility: visibility,
      }).catch(() => null);
      if (det && !det.abstained) {
        out = det.text;
        citedIds = det.citedIds;
        abstained = false;
        inputTokens += det.inputTokens;
        outputTokens += det.outputTokens;
      }
    }
  }

  // Grounded-only guarantee: with no caller context to draw from, an answer that
  // cites nothing is ungrounded (the model reached for outside knowledge) — never
  // serve it. Force an abstain. Caller-context answers may legitimately cite
  // nothing (the conversation isn't a citable source), so they're exempt.
  if (!abstained && citedIds.length === 0 && !opts.context) {
    out = "I don't have that yet.";
    citedIds = [];
    abstained = true;
  }

  log.info({ tools: Object.keys(tools), grounded: grounding.size, abstained }, "agent finished");

  return {
    text: out,
    citedIds,
    model,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    abstained,
    chunks: [...grounding.values()],
  };
}
