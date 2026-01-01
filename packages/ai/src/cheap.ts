import { generateText } from "ai";
import { languageModel, llmGenerateOptions } from "./client.js";
import { cheapModel, estimateCostUsd } from "./models.js";

/**
 * Cheap/fast operations handled by the cheap model (Haiku by default):
 * summaries, titles, normalisation, and turning many phrasings of one question
 * into a single canonical form. Each returns usage so callers can record
 * telemetry.
 */
export interface CheapUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

interface CheapResult<T> {
  value: T;
  usage: CheapUsage;
}

async function complete(prompt: string, maxTokens = 512): Promise<CheapResult<string>> {
  const model = cheapModel();
  const res = await generateText({
    model: languageModel(model),
    prompt,
    maxOutputTokens: maxTokens,
    ...llmGenerateOptions(),
  });
  const inputTokens = res.usage.inputTokens ?? 0;
  const outputTokens = res.usage.outputTokens ?? 0;
  return {
    value: res.text.trim(),
    usage: { model, inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) },
  };
}

/** A one-line title for a knowledge snippet. */
export async function makeTitle(body: string): Promise<CheapResult<string>> {
  return complete(
    `Write a short, specific title (max 8 words, no trailing punctuation) for this knowledge snippet. Reply with ONLY the title.\n\n---\n${body}`,
    40,
  );
}

/** A 1-3 sentence summary of a knowledge snippet. */
export async function makeSummary(body: string): Promise<CheapResult<string>> {
  return complete(
    `Summarise this knowledge snippet in 1-3 sentences for a developer audience. Reply with ONLY the summary.\n\n---\n${body}`,
    200,
  );
}


/**
 * Normalise a raw question into a canonical, deduplicated phrasing so that
 * "how do I rotate a key" and "key rotation?" collapse to the same question.
 */
export async function normalizeQuestion(raw: string): Promise<CheapResult<string>> {
  return complete(
    `Rewrite this user question into a single canonical form: a concise, neutral, self-contained question in plain English. Strip greetings, names, and conversational filler. Reply with ONLY the canonical question.\n\n---\n${raw}`,
    80,
  );
}
