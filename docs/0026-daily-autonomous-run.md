# 0026. A scheduled agent run works the goals queue, one PR at a time

Date: 2026-10-22

## Status

Accepted

## Context

The maintainer has limited hours. The ADRs already say what the code should
be and where it falls short (Known gaps), so most of the remaining work is
legible without a conversation. An agent that runs once a day can make that
progress, but only if it cannot quietly change the design, and only if the
maintainer can see each step before it lands.

## Decision

A scheduler runs an agent against this repo once a day, one turn. Every
turn ends with housekeeping: commit, push, draft PR current, ready and
maintainer mentioned when the stages are done. The turn count is the
throttle; it is raised by editing the schedule, not the agent.

The agent follows the "Daily run" section of `AGENTS.md`. The fixed points:

- State is git and GitHub, never the agent's memory. One open draft pull
  request labelled `daily` at a time. The run starts by looking for it and
  continues it; with none, it takes the top of the queue in
  [goals.md](goals.md).
- Every pull request goes through ideation, plan, build, verify, and an
  adversarial review of its own diff before it is marked ready. The stages
  are a checklist in the pull request body. The agent marks ready and
  mentions the maintainer; it never merges.
- The agent makes no decisions. ADR Decision sections are read-only to it.
  It may remove a Known gaps line it has fixed and add one it has found. A
  choice the ADRs do not settle stops the pull request with the
  `needs-decision` label and a comment stating the choice, and the next run
  starts the next goal.
- Commits cite `ADR-NNNN`, carry the `lukeocodes` identity, and no trailer
  names an agent ([AGENTS.md](../AGENTS.md)).

The schedule, profile, and flow files are the maintainer's machine config,
outside this repo. The repo carries only the process and the queue.

## Consequences

- Progress is bounded and inspectable: one PR, staged, reviewed by the
  maintainer before merge.
- The goals queue has to be kept honest. A goal that is really a decision
  belongs under "Needs a decision first", or the agent will stall on it.
- A run that finds nothing in the queue does nothing. That is correct.
- One turn a day is slow by design. Raising it is a schedule edit.
