# 0021. Re-verify on the answer path and on demand

Date: 2026-01-01

## Status

Accepted

## Context

Scheduled indexing and the verify tick work through everything on a cadence.
A record being cited today matters more than one nobody retrieves.

## Decision

After an answer, cited records whose `lastVerifiedAt` is older than
`REVERIFY_AGE_HOURS` (default 168) are passed to an injected
`scheduleReverify` sink. The sink is fire-and-forget. In the API it calls
the record's adapter: `refresh` for upstream-trust sources, `verify` for
review-trust ones. Records with no adapter (`api`, `manual`) are skipped and
not stamped.

Both `ask()` and `askStream()` await the age query before returning; on the
streaming path the deltas have already been delivered and only `done` waits.

Citation itself does not bump `lastVerifiedAt`.

The same machinery is exposed on demand: `POST /v1/knowledge/:id/refresh`
(`ask knowledge refresh <id>`) forces one record through its adapter
regardless of age and returns `refreshed`, `unchanged`, or `removed`. A
record with no adapter returns 409; an unreachable upstream returns 502.

## Consequences

- Popular knowledge is verified on demand.
- The core does not import adapters. The sink is injected.
