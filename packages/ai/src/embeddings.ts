import { loadEnv } from "@ask/config";
import { embedMany } from "ai";
import { embeddingModel } from "./client.js";

/**
 * Vector embeddings for retrieval, via the Vercel AI SDK. Provider + model are
 * resolved in client.ts (Voyage / OpenAI / local). For Voyage the output
 * dimension is pinned so it matches the pgvector column. The AI SDK retries
 * transient failures (429/5xx) internally.
 */
export interface EmbedResult {
  vectors: number[][];
  model: string;
  tokens?: number;
}

export async function embed(
  texts: string[],
  opts?: { inputType?: "query" | "document" },
): Promise<EmbedResult> {
  const env = loadEnv();
  if (texts.length === 0) return { vectors: [], model: env.EMBEDDINGS_MODEL };

  let providerOptions: Record<string, Record<string, string | number>> | undefined;
  if (env.EMBEDDINGS_PROVIDER === "vertex") {
    providerOptions = { vertex: { outputDimensionality: env.EMBEDDING_DIM } };
  } else if (env.EMBEDDINGS_PROVIDER === "voyage") {
    providerOptions = {
      voyage: {
        outputDimension: env.EMBEDDING_DIM,
        ...(opts?.inputType ? { inputType: opts.inputType } : {}),
      },
    };
  }

  const { embeddings, usage } = await embedMany({
    model: embeddingModel(),
    values: texts,
    ...(providerOptions ? { providerOptions } : {}),
  });

  return { vectors: embeddings, model: env.EMBEDDINGS_MODEL, tokens: usage?.tokens };
}

/** Convenience: embed a single string. */
export async function embedOne(
  text: string,
  opts?: { inputType?: "query" | "document" },
): Promise<number[]> {
  const { vectors } = await embed([text], opts);
  const v = vectors[0];
  if (!v) throw new Error("embed returned no vector");
  return v;
}
