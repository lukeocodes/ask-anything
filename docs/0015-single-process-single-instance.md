# 0015. One process, single instance

Date: 2026-01-01

## Status

Accepted

## Context

The API and its cron jobs share a process. The cron scheduler must run in
exactly one place or jobs run twice, and the hosted MCP holds its sessions
in process memory.

## Decision

`@ask/api` is the one deployable: API, jobs, hosted MCP.

Production is one warm Cloud Run service, `--min-instances=1
--max-instances=1`, CPU always allocated, Cloud SQL on private IP, migrations
through an IAP bastion tunnel.

## Consequences

- One image, one service, one set of secrets.
- Horizontal scale is off until cron moves to its own scheduler.
- A cold instance misses cron. Stay warm.
