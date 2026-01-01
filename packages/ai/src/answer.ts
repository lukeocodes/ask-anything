import { loadEnv } from "@ask/config";
import { generateText, streamText } from "ai";
import { CitationRewriter, isAbstain, stripHedge, tidyCitations, type Visibility } from "./citations.js";
import { languageModel, llmGenerateOptions } from "./client.js";
import { answerModel, estimateCostUsd } from "./models.js";

export interface GroundingChunk {
  /** Stable id used for citation (the knowledge item id). */
  id: string;
  title: string;
  body: string;
  /** Where the chunk came from — the index ("db") or an adapter kind. */
  source: string;
  /** Canonical link for this source, when it has one (used for citations). */
  url?: string;
  /**
   * The source's own visibility tier, matching the knowledge/keys schema. A
   * private source is only cited to private-tier callers; public is citable to
   * anyone. Defaults to public when unset.
   */
  visibility?: "public" | "private";
  /** Effective confidence 0-1 (from decay), if known. */
  confidence?: number;
  /** The matched chunk row, when the hit came from the chunk tree (ADR-0025). */
  chunkId?: string;
  /** Ancestor headings root → self, e.g. ["README", "Installation", "Docker"]. */
  headingPath?: string[];
  /** Materialised tree position of the chunk within its item, e.g. "0.2.1". */
  path?: string;
  /**
   * Cross-source relevance from the reranker, 0-1. Set only when a real
   * reranker actually ran; undefined under the identity fallback or when
   * reranking is disabled (so callers know relevance is unknown).
   */
  score?: number;
}

export interface AnswerResult {
  text: string;
  citedIds: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** True when the model could not answer from the provided grounding. */
  abstained: boolean;
}

/** The answer system prompt, built from the deployment's ASK_NAME / ASK_DESCRIPTION. */
function systemPrompt(): string {
  const env = loadEnv();
  return `You are ${env.ASK_NAME}, ${env.ASK_DESCRIPTION}.

Rules:
- Answer from the provided Knowledge and, when present, the Conversation. Do not use outside knowledge.
- The Conversation is prior conversation supplied by the caller. Treat it as trusted context you may use, summarize, and quote to carry out their request — it counts as provided material. The Request is their instruction; apply it to the Conversation and Knowledge.
- Prefer higher-confidence sources. If sources conflict, say so.
- Cite the KNOWLEDGE sources you used inline as [id], using the id EXACTLY as given. Never invent an id. The Conversation is not a citable source — don't cite it.
- If the Knowledge or the Conversation answers the request — fully OR partially, or tells the user where to get it (an endpoint to call, a page to read) — answer confidently and cite any knowledge used. Do NOT hedge or preface with disclaimers like "I don't have that yet" when you can give useful information.
- ONLY when neither the Knowledge nor the Conversation is relevant to the request, reply with EXACTLY "I don't have that yet." and nothing else (no citations, no extra text). Never write that sentence and then contradict it with an answer.
- Be concise and developer-appropriate. Code where it helps.
- Format the answer in standard Markdown. Clients convert it for their surface.`;
}

function buildPrompt(question: string, chunks: GroundingChunk[], context?: string): string {
  const knowledge = chunks
    .map((c) => {
      const conf =
        c.confidence !== undefined ? ` confidence=${c.confidence.toFixed(2)}` : "";
      return `[${c.id}] (source=${c.source}${conf})\n${c.title}\n${c.body}`;
    })
    .join("\n\n---\n\n");
  const convo = context
    ? `Conversation (prior conversation supplied by the caller — the material for their request; not a citable source):\n\n${context}\n\n---\n\n`
    : "";
  return `${convo}Knowledge:\n\n${knowledge || "(none)"}\n\n---\n\nRequest: ${question}`;
}

/** Finalize the rewriter's accumulated output into an AnswerResult. */
function finishResult(
  model: string,
  rewriter: CitationRewriter,
  rendered: string,
  usage: { inputTokens?: number; outputTokens?: number },
): AnswerResult {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  let out = tidyCitations(rendered);
  const abstained = isAbstain(out, rewriter.citedIds);
  if (!abstained) out = stripHedge(out);

  return {
    text: out,
    citedIds: rewriter.citedIds,
    model,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    abstained,
  };
}

/** Options shared by the answer generators. */
export interface AnswerOptions {
  /** Prior conversation supplied by the caller (not a citable source). */
  context?: string;
  /** The caller's tier — gates which sources/links are cited (see citations). */
  callerVisibility?: Visibility;
}

/** Rewrite citations across a whole (non-streamed) answer in one pass. */
function toResult(
  model: string,
  text: string,
  chunks: GroundingChunk[],
  usage: { inputTokens?: number; outputTokens?: number },
  callerVisibility: Visibility,
): AnswerResult {
  const rewriter = new CitationRewriter(chunks, { callerVisibility });
  const rendered = rewriter.push(text) + rewriter.flush();
  return finishResult(model, rewriter, rendered, usage);
}

/**
 * Compose a grounded answer from retrieved chunks. Retrieval happens upstream
 * in @ask/core; this is the generation step only.
 */
export async function answerQuestion(
  question: string,
  chunks: GroundingChunk[],
  opts: AnswerOptions = {},
): Promise<AnswerResult> {
  const model = answerModel();
  const res = await generateText({
    model: languageModel(model),
    system: systemPrompt(),
    prompt: buildPrompt(question, chunks, opts.context),
    maxOutputTokens: 2048,
    ...llmGenerateOptions(),
  });
  return toResult(model, res.text, chunks, res.usage, opts.callerVisibility ?? "public");
}

/**
 * Streaming variant: invokes `onDelta` with text as it's generated, and returns
 * the same AnswerResult once complete. Used by the API's SSE endpoint.
 */
export async function answerQuestionStream(
  question: string,
  chunks: GroundingChunk[],
  onDelta: (text: string) => void,
  opts: AnswerOptions = {},
): Promise<AnswerResult> {
  const model = answerModel();
  const res = streamText({
    model: languageModel(model),
    system: systemPrompt(),
    prompt: buildPrompt(question, chunks, opts.context),
    maxOutputTokens: 2048,
    ...llmGenerateOptions(),
  });

  // Rewrite citations as the tokens stream, so what the user watches type out is
  // already the clean numbered links — and it's identical to the stored answer.
  const rewriter = new CitationRewriter(chunks, { callerVisibility: opts.callerVisibility ?? "public" });
  let rendered = "";
  for await (const delta of res.textStream) {
    const clean = rewriter.push(delta);
    if (clean) {
      rendered += clean;
      onDelta(clean);
    }
  }
  const tail = rewriter.flush();
  if (tail) {
    rendered += tail;
    onDelta(tail);
  }

  const usage = await res.usage;
  return finishResult(model, rewriter, rendered, usage);
}
