import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadEnv } from "@ask/config";
import type { EmbeddingModel } from "ai";
import { createVoyage } from "voyage-ai-provider";

/**
 * Provider hub (Vercel AI SDK). One abstraction over the LLM (Anthropic /
 * Anthropic-compatible gateway, or Gemini on Vertex), the embedding provider
 * (Vertex / Voyage / OpenAI / local), and the reranker (Voyage or Vertex).
 * Models/providers are cached per process.
 */
let anthropicProvider: ReturnType<typeof createAnthropic> | undefined;
let vertexProvider: ReturnType<typeof createVertex> | undefined;

/** Shared Vertex provider (Gemini + embeddings). Auth via ADC / runtime SA. */
export function vertex() {
  if (!vertexProvider) {
    const env = loadEnv();
    vertexProvider = createVertex({
      location: env.GOOGLE_VERTEX_LOCATION,
      ...(env.GOOGLE_VERTEX_PROJECT ? { project: env.GOOGLE_VERTEX_PROJECT } : {}),
    });
  }
  return vertexProvider;
}

/**
 * Provider-specific generate options. On Gemini 2.5, "thinking" is on by default
 * and its tokens count against maxOutputTokens. For plain answers we disable it
 * (it just truncates a grounded QA reply and empties short cheap calls). For the
 * agent we WANT reasoning to pick tools, so we give it a bounded budget — the
 * caller must set maxOutputTokens well above the budget so the answer still fits.
 * Spread into generateText/streamText.
 */
export function llmGenerateOptions(mode: "answer" | "agent" = "answer"): Record<string, unknown> {
  if (loadEnv().LLM_PROVIDER === "vertex") {
    const thinkingBudget = mode === "agent" ? 1024 : 0;
    return { providerOptions: { google: { thinkingConfig: { thinkingBudget } } } };
  }
  return {};
}

export function languageModel(modelId: string) {
  const env = loadEnv();
  if (env.LLM_PROVIDER === "vertex") return vertex()(modelId);

  if (!anthropicProvider) {
    anthropicProvider = createAnthropic({
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      // AI SDK convention: baseURL includes the version path (e.g. .../v1).
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    });
  }
  return anthropicProvider(modelId);
}

let embeddingModelCache: EmbeddingModel | undefined;

export function embeddingModel() {
  if (embeddingModelCache) return embeddingModelCache;
  const env = loadEnv();

  if (env.EMBEDDINGS_PROVIDER === "vertex") {
    embeddingModelCache = vertex().textEmbeddingModel(env.EMBEDDINGS_MODEL);
  } else if (env.EMBEDDINGS_PROVIDER === "voyage") {
    const voyage = createVoyage(
      env.VOYAGE_API_KEY ? { apiKey: env.VOYAGE_API_KEY } : {},
    );
    embeddingModelCache = voyage.embeddingModel(env.EMBEDDINGS_MODEL);
  } else {
    // openai | local — any OpenAI-compatible /embeddings endpoint.
    const base =
      env.EMBEDDINGS_BASE_URL ??
      (env.EMBEDDINGS_PROVIDER === "openai" ? "https://api.openai.com/v1" : undefined);
    if (!base) throw new Error("EMBEDDINGS_PROVIDER=local requires EMBEDDINGS_BASE_URL");
    const provider = createOpenAICompatible({
      name: "ask-embeddings",
      baseURL: base,
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
    });
    embeddingModelCache = provider.textEmbeddingModel(env.EMBEDDINGS_MODEL);
  }
  return embeddingModelCache;
}

let rerankingModelCache: ReturnType<ReturnType<typeof createVoyage>["rerankingModel"]> | undefined;

/** Voyage reranker, cached per process like the other providers. */
export function rerankingModel() {
  if (rerankingModelCache) return rerankingModelCache;
  const env = loadEnv();
  const voyage = createVoyage(
    env.VOYAGE_API_KEY ? { apiKey: env.VOYAGE_API_KEY } : {},
  );
  rerankingModelCache = voyage.rerankingModel(env.RERANK_MODEL);
  return rerankingModelCache;
}
