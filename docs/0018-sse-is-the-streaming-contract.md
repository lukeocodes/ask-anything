# 0018. SSE is the streaming contract

Date: 2026-01-01

## Status

Accepted

## Context

A grounded answer takes seconds. A consumer staring at nothing for that long
assumes the system is broken. Buffering the whole answer means every
consumer re-implements streaming. The API owns the stream; consumers render.

## Decision

`POST /v1/ask/stream` emits Server-Sent Events: `step` (pipeline progress),
`delta` (answer text), `done` (the full `AskResult`), `error`. Deltas carry
citation-rewritten Markdown: `CitationRewriter` turns `[id]` references into
numbered links and withholds text mid-citation before emitting.

The deterministic path streams tokens. The agent path and cache hits emit the whole answer as one delta, then `done`.

`ask stream <question>` in the CLI is the reference consumer. It prints
deltas as they arrive.

## Consequences

- Any surface that wants live typing consumes these four events. The API
  knows nothing about the surface's throttling or rendering.
- Time to first token is what a consumer sees on the deterministic path.
- The MCP `ask` tool is non-streaming and returns a reduced shape (see
  [0012](0012-mcp-first-transport-agnostic.md)).
