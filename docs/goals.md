# Goals

The north star: a self-hostable retrieval engine that refuses to guess. Point
it at sources, ask it anything, get an answer that is grounded, cited, and
fresh, or an honest "I don't have that yet".

Decisions live in the ADRs. This file is the work queue those decisions
imply, in order. The daily run ([0026](0026-daily-autonomous-run.md)) takes
from the top of the queue and never from the second list.

## Queue

A goal is done when the Known gaps line it points at is gone from the ADR.

1. Remove the adapter-side review path: `trust` and `verify` on the
   contract, the verify tick, `MONITOR_CRON`, `run-verify`,
   `ask jobs run verify`, the `verify` branch in the reverify sink, and the
   README, `.env.example`, and `packages/sources/README.md` text that
   describes them. ADR-0010 "To remove", ADR-0020 and ADR-0021 Known gaps.
2. README says sources can be "public or private". Only public git ships.
   ADR-0020.
3. `scripts/probe-retrieval.ts` is not in the layout in `AGENTS.md`. Fold it
   into `probe-ask`, list it, or delete it. ADR-0008.
4. Stale as a queue: scheduled indexing and on-demand refresh take `stale`
   records first. ADR-0009, Known gaps.
5. The gap ledger clusters paraphrases through the `questions` table instead
   of recording each as its own gap. ADR-0022, Known gaps.
6. Grow `eval/golden.jsonl` past three cases, from the two shipped adapters'
   own docs so the set needs no private data. ADR-0001.

## Needs a decision first

Not for the daily run. Each needs an ADR the maintainer has not written.

- Any planned adapter from ADR-0020 (private git, org enumeration, local
  filesystem, OpenAPI, feeds, forums, wikis, chat). Each is its own ADR.
- An admin UI over the API, CLI, and MCP.
- Publishing: npm, a Docker image on a registry, `npx ask`.
- Auth beyond static keys in env (ADR-0016). Key rotation, OAuth, per-user
  identity.
- More than one instance (ADR-0015).
- Deploy automation beyond the DEPLOY.md walkthrough.
