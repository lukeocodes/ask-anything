# 0013. Vercel AI SDK provider hub with two model tiers

Date: 2026-01-01

## Status

Accepted

## Context

Model and provider choice changes. Anthropic direct, an Anthropic-compatible
gateway, Gemini on Vertex, Voyage or OpenAI or a local server for embeddings,
Voyage or Vertex for rerank. Not every call needs the capable model.

## Decision

`packages/ai` imports the provider SDKs and exposes `languageModel()`,
`embeddingModel()`, and `rerankingModel()` behind `LLM_PROVIDER`,
`EMBEDDINGS_PROVIDER`, and `RERANK_PROVIDER`. All providers, including the reranker, are cached per
process.

Two tiers: `ASK_ANSWER_MODEL` (default `claude-opus-4-8`) and
`ASK_CHEAP_MODEL` (default `claude-haiku-4-5`). Provider quirks, such as the
Gemini thinking budget, live in `llmGenerateOptions`.

The agent path (`packages/core/src/agent.ts`) calls the AI SDK's `streamText`
directly with `languageModel(env.ASK_ANSWER_MODEL)`. Provider selection is
still centralised; answer composition is not.

Cost is estimated from a hand-maintained rate table in `models.ts` covering
chat, embedding, and rerank models. An unknown model id logs one warning and
yields no cost.

## Consequences

- Swapping a model is config. Swapping a provider is one package.
- Local embeddings (Ollama, TEI) make a fully in-house deployment possible.
- The rate table is advisory and goes stale if not updated with model changes.
- The embedding and rerank rates are approximate list prices. Verify them
  when the provider or model changes.
