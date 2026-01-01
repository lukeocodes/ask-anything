import { loadEnv, logger } from "@ask/config";
import { rerank as aiRerank } from "ai";
import { GoogleAuth } from "google-auth-library";
import { rerankingModel } from "./client.js";

const log = logger("rerank");

export interface RerankHit {
  index: number;
  score: number;
}

/** A completed rerank call — hits plus what it cost, for telemetry. */
export interface RerankResponse {
  hits: RerankHit[];
  provider: "voyage" | "vertex";
  model: string;
  /** Tokens billed by the provider, when it reports them. */
  tokens?: number;
}

/** Wall-clock budget for a rerank call before it's treated as "no reranker ran". */
const RERANK_TIMEOUT_MS = 6000;

/**
 * Cross-encoder rerank of candidate documents against the query. A cross-encoder
 * reads query+document together, so it's far more accurate than the bi-encoder
 * similarity used for ANN recall — the "retrieve wide, rerank tight" pattern.
 * Provider is `voyage` (via the AI SDK) or `vertex` (the Vertex AI Ranking API).
 * Gated by RERANK_ENABLED at the call site; hits come back most-relevant first.
 *
 * Returns `null` — "no reranker ran, relevance unknown" — when no provider is
 * configured (Voyage without a key, Vertex without a project) or the call
 * times out. Other provider errors throw so the caller can log them.
 */
export async function rerank(
  query: string,
  documents: string[],
  opts?: { topK?: number },
): Promise<RerankResponse | null> {
  if (documents.length === 0) return { hits: [], provider: loadEnv().RERANK_PROVIDER, model: loadEnv().RERANK_MODEL };
  const env = loadEnv();

  if (env.RERANK_PROVIDER === "vertex") {
    if (!env.GOOGLE_VERTEX_PROJECT) {
      log.warn("RERANK_PROVIDER=vertex but GOOGLE_VERTEX_PROJECT is unset — no reranker");
      return null;
    }
    return withTimeout(vertexRerank(query, documents, env.GOOGLE_VERTEX_PROJECT, env.RERANK_MODEL, opts?.topK));
  }

  if (!env.VOYAGE_API_KEY) return null;
  return withTimeout(voyageRerank(query, documents, env.RERANK_MODEL, opts?.topK));
}

/** Resolve to `null` (not an error) when the provider doesn't answer in time. */
async function withTimeout(call: Promise<RerankResponse>): Promise<RerankResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ timeoutMs: RERANK_TIMEOUT_MS }, "rerank timed out — no reranker ran");
      resolve(null);
    }, RERANK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // A late rejection after the timeout must not surface as unhandled.
    call.catch(() => {});
  }
}

async function voyageRerank(
  query: string,
  documents: string[],
  model: string,
  topK?: number,
): Promise<RerankResponse> {
  const res = await aiRerank({
    model: rerankingModel(),
    query,
    documents,
    ...(topK ? { topN: topK } : {}),
  });
  // The AI SDK's RerankResult carries no usage; Voyage reports it in the body.
  const body = res.response.body as { usage?: { total_tokens?: number } } | undefined;
  return {
    hits: res.ranking.map((r) => ({ index: r.originalIndex, score: r.score })),
    provider: "voyage",
    model,
    tokens: body?.usage?.total_tokens,
  };
}

let googleAuth: GoogleAuth | undefined;

async function accessToken(): Promise<string> {
  googleAuth ??= new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const token = await googleAuth.getAccessToken();
  if (!token) throw new Error("no Google access token for Vertex ranking");
  return token;
}

/**
 * Vertex AI Ranking API (Discovery Engine). Records are labeled by their input
 * index so we can map scores back. Content is truncated to keep within the
 * ranker's per-record budget.
 */
async function vertexRerank(
  query: string,
  documents: string[],
  project: string,
  model: string,
  topK?: number,
): Promise<RerankResponse> {
  const token = await accessToken();
  const url = `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/global/rankingConfigs/default_ranking_config:rank`;
  const records = documents.map((content, i) => ({ id: String(i), content: content.slice(0, 8000) }));

  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      model,
      query,
      records,
      topN: topK ?? documents.length,
      ignoreRecordDetailsInResponse: true,
    }),
  });
  if (!res.ok) throw new Error(`vertex rank ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { records?: { id: string; score?: number }[] };
  return {
    hits: (json.records ?? []).map((r) => ({ index: Number(r.id), score: r.score ?? 0 })),
    provider: "vertex",
    model,
  };
}
