# 0016. Static scoped API keys in env

Date: 2026-01-01

## Status

Accepted

## Context

Callers are a small fixed set. Key issuance, storage, and rotation UI is a
project on its own.

## Decision

`API_KEYS` is a CSV of `key:label:scope:visibility`. Scopes: `read`, `write`,
`admin`. Visibility: `public` or `private`, default `public` when omitted.
Rotating a key is a redeploy.

Two independent guardrails sit alongside auth:

- Rate limiting: a global `@fastify/rate-limit` registration in `buildServer`
  keyed by API key, falling back to IP for unauthenticated traffic
  (`RATE_LIMIT_PER_MINUTE`).
- Cost cap: a `costCapGuard` preHandler on the two `/v1/ask` routes only
  (`DAILY_COST_CAP_USD`, 0 disables), with the day's spend memoised for 30 s.

## Consequences

- Zero auth infrastructure.
- `POST /mcp` is rate-limited per IP and sits outside the cost cap.
- Every `/v1/admin/*` route requires `admin`.
- `.env.example` is checked against `env.ts` by hand. Keep them in step.
