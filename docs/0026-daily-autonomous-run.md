# 0026. A scheduled run moves the goals queue forward each day, within a deadline

Date: 2026-10-22

## Status

Accepted

## Context

The maintainer has limited hours. The ADRs already say what the code should
be and where it falls short (Known gaps), so most of the remaining work is
legible without a conversation. An agent that runs once a day can make that
progress, but only if it cannot quietly change the design, does not spend a
week of tokens in a day, and the maintainer can see each step before it
lands.

## Decision

A scheduler runs an agent against this repo once a day, one turn, with a
deadline set at launch. It follows the `cao-dev-run` process on the
maintainer's machine, using the settings in the "Daily run" section of
`AGENTS.md`. The fixed points:

- State is git and GitHub, never the agent's memory.
- Every run starts with the inbox: the maintainer's comments on the run's
  pull requests (label `daily`), answers on `needs-decision` pull requests,
  pull requests closed without merging, and Greptile review threads on
  ready pull requests. The maintainer talks to the run by commenting, and a
  pull request can go back and forth with Greptile over several days.
- Then it moves the parked draft forward, then the next goal in
  [goals.md](goals.md), getting as far as it can before the deadline.
  Unfinished work is parked as a draft with the next step in its body.
- Every pull request goes through ideation, plan, build, verify, and an
  adversarial review of its own diff. It is marked ready only when the run
  is satisfied with it. It never merges.
- The agent makes no decisions. ADR Decision sections are read-only to it,
  except to write in an answer the maintainer gave on a `needs-decision`
  pull request. It may remove a Known gaps line it has fixed and add one it
  has found.
- Commits cite `ADR-NNNN`, carry the `lukeocodes` identity, and no trailer
  names an agent ([AGENTS.md](../AGENTS.md)).

The schedule, profile, flow files and skills are the maintainer's machine
config, outside this repo. The repo carries only the settings and the
queue.

## Consequences

- Progress is bounded by the deadline and inspectable: every pull request
  is reviewed by the maintainer before merge.
- The scheduler cannot hard-stop a turn. The deadline holds because the
  agent checks the clock.
- The goals queue has to be kept honest. A goal that is really a decision
  belongs under "Needs a decision first", or the agent will stall on it.
- A run that finds nothing in the inbox or the queue does nothing. That is
  correct.
