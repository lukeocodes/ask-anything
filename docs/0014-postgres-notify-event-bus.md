# 0014. Domain events over Postgres LISTEN/NOTIFY

Date: 2026-01-01

## Status

Accepted

## Context

Something should show a private item needing review, feedback landing, a
question going unanswered, a gap closing. Calling a chat tool from the core would
break [0002](0002-cli-is-management.md). A broker is infrastructure
for a handful of events a day.

## Decision

`emitEvent` appends a typed event (`EventPayloads`) to the `events` table,
then `pg_notify` on `ask_events`. Emitters: core emits `question.unanswered`;
the API layer emits `knowledge.review_requested` (knowledge route),
`answer.feedback` (feedback route), and `question.answered` (backfill job).

`GET /v1/events` opens a `LISTEN` per SSE client and streams events.
`ask events tail` is the consumer. Nothing renders events into a chat tool.

Emit failures are caught, logged, and never fail the caller. A notify payload
over 7,000 bytes has its longest string fields truncated so the 8 KB limit is
never hit; the row keeps the full payload. `question` is capped at 4,000
characters at the API edge.

## Consequences

- No broker. The log is durable and replayable from the table.
- The core owns what happened; surfaces own how it is shown.
- Multiple listeners are harmless. Any future push consumer must be a
  singleton or dedupe on `seq`.
