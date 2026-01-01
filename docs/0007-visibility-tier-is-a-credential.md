# 0007. Visibility tier is a credential, fail closed

Date: 2026-01-01

## Status

Accepted

## Context

The same engine serves a public hosted MCP endpoint and internal deployments
holding private knowledge. Leaking private content to a public caller is the
worst failure the system can have.

## Decision

Every `knowledge_item` has `visibility` of `public` or `private`. The column
defaults to `private`. Only known-public sources write `public`. A public-tier
API key forces `public` on anything it inserts.

The tier is part of the API key: `key:label:scope:visibility`, visibility
defaulting to `public` when omitted. `resolveVisibility` caps every ask to the
key's tier. A request may narrow, never escalate. The hosted `POST /mcp` is
unauthenticated and pinned to public.

Enforcement is layered:

1. Retrieval filters by tier in SQL.
2. The pipeline's `enforceVisibility` and the agent's `collect` drop private
   chunks as a post-condition, whatever produced them.
3. Citation rendering strips private-source citations for public callers.
4. Every record-level route (`GET /v1/knowledge/:id`, chunks, reviews,
   visibility, refresh) answers 404 or 403 to a public key for a private
   record.

The agent's only tool, `search_knowledge_base`, runs the same pipeline and
the same post-condition.

`/v1/search` resolves visibility from the key the same way. The hosted MCP
`search` is pinned public.

The answer cache is tier-exact (see [0008](0008-semantic-answer-cache.md)).

`PRIVATE_EGRESS_ALLOWED=false` refuses private asks before any model call,
and refuses private `ingest`, `refreshCanonical`, and `applyRevision` before
any embedding or cheap-model call.

`ingest()` emits `knowledge.review_requested` when an item lands private
without an explicit visibility decision, whoever called it.

## Consequences

- A misconfigured insert lands private and is invisible publicly.
- Granting private access means minting a private key, which is a redeploy.
- The hosted MCP `search` tool is public regardless of anything. Through the
  stdio proxy, `search` goes to `/v1/search` and honours the key.
