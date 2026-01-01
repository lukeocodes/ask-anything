# 0012. MCP first, transport-agnostic server factory

Date: 2026-01-01

## Status

Accepted

## Context

The consumers that matter speak MCP. MCP has two spec transports: stdio for
local clients, Streamable HTTP for hosted. Writing the tools twice would drift.

## Decision

`packages/mcp` is a transport-agnostic server factory with two tools, `ask`
and `search`. It takes an engine interface.

`apps/api` mounts it at `POST /mcp` over Streamable HTTP (`GET` for the
server-to-client stream, `DELETE` to end a session, both bound to
`Mcp-Session-Id`), wired in-process to core `ask()` and the API's
`publicSearch()`. Session
transports live in a process-local map, which is one more reason for the
single instance in [0015](0015-single-process-single-instance.md). `apps/mcp` is a stdio binary wiring the
same factory to the REST API over HTTP using `ASK_API_URL` and `ASK_API_KEY`.

The hosted endpoint is unauthenticated and public-tier only.

The MCP `ask` tool returns one text block: the answer followed by a
"Sources:" list. `abstained` and `model` are not surfaced. The full
`AskResult` is only on REST.

No feedback tool. Feedback is a REST concern.

## Consequences

- One tool definition, two transports.
- Hosted MCP needs no key exchange and can never reach private knowledge.
- Through the stdio proxy, a private key unlocks private knowledge for both
  tools; `/v1/search` resolves the tier from the key (see
  [0007](0007-visibility-tier-is-a-credential.md)).
- The management MCP (`apps/mgmt-mcp`) is a separate server for operators.
  See [0002](0002-cli-is-management.md).
