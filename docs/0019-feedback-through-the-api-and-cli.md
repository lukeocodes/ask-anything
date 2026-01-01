# 0019. Feedback through the REST API and the CLI

Date: 2026-01-01

## Status

Accepted

## Context

Feedback moves rank (see [0009](0009-decay-not-deletion.md)) and evicts
cache entries (see [0008](0008-semantic-answer-cache.md)). It has to be
cheap to give and it has to land in one place.

## Decision

Two endpoints own feedback: `POST /v1/answers/:id/feedback` (rating `up` or
`down`, optional actor and surface) and
`POST /v1/answers/:id/feedback/comment` (free text). The API applies the
effects: `up` runs `reinforce(id, {verify: false})` on cited items; `down` lowers
`baseConfidence` and invalidates cached answers by answer id and by cited
item. Both emit `answer.feedback`.

The operator surface is `ask feedback <answerId> up|down [--comment text]`,
which calls those endpoints. The management MCP exposes the same command as
a tool. The public MCP has no feedback tool.

## Consequences

- Any future surface that shows answers to people implements feedback by
  calling the same two endpoints. There is no other path.
- There is no end-user feedback surface until a surface exists that shows
  answers to end users.
- Feedback effects are applied server-side, so a surface cannot get them
  wrong.
