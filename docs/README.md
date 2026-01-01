# Architecture Decision Records

One file per decision. Numbered. Before the first release, an ADR is edited
in place when its decision changes and git history is the changelog. After
the first release, ADRs are append-only: a changed decision is a new ADR that
supersedes the old one. Numbers are stable identities, titles can change.

Format: `NNNN-short-title.md`, sections Status / Context / Decision /
Consequences, plus an optional Known gaps section. Copy `template.md`.

**Known gaps** lists where the code diverges from the decision's evident
intent. The code is the truth; the gap is a ledger entry, not a wish. Fixing a
gap cites the ADR and removes the line in the same commit.

Reference material that is not a decision lives next to the code it describes:
data model in `packages/db/README.md`, adding a source in
`packages/sources/README.md`, system diagram in the root README.

| # | Decision | Status |
|---|---|---|
| [0001](0001-pnpm-turbo-monorepo.md) | pnpm + turbo TypeScript monorepo | Accepted |
| [0002](0002-cli-is-management.md) | The CLI is the only management surface | Accepted |
| [0003](0003-postgres-pgvector-single-store.md) | Postgres + pgvector as the single store | Accepted |
| [0004](0004-hybrid-retrieval-rrf.md) | Hybrid retrieval: vector + FTS fused with RRF | Accepted |
| [0005](0005-rerank-as-the-gate.md) | Cross-encoder rerank is the answerability gate | Accepted |
| [0006](0006-grounded-only-answers.md) | Grounded-only answers; abstain by text, backstopped by rerank | Accepted |
| [0007](0007-visibility-tier-is-a-credential.md) | Visibility tier is a credential, fail closed | Accepted |
| [0008](0008-semantic-answer-cache.md) | Tier-exact semantic answer cache | Accepted |
| [0009](0009-decay-not-deletion.md) | Knowledge decays; deletion only on upstream removal | Accepted |
| [0010](0010-refresh-is-a-proposal.md) | Trust decides: refresh in place, or propose for review | Accepted |
| [0011](0011-non-destructive-crawl-refresh.md) | Non-destructive index refresh | Accepted |
| [0012](0012-mcp-first-transport-agnostic.md) | MCP first, transport-agnostic server factory | Accepted |
| [0013](0013-ai-sdk-provider-hub-two-model-tiers.md) | Vercel AI SDK provider hub with two model tiers | Accepted |
| [0014](0014-postgres-notify-event-bus.md) | Domain events over Postgres LISTEN/NOTIFY | Accepted |
| [0015](0015-single-process-single-instance.md) | One process, single instance | Accepted |
| [0016](0016-static-api-keys-in-env.md) | Static scoped API keys in env | Accepted |
| [0017](0017-question-logging-off-critical-path.md) | Question logging off the critical path | Accepted |
| [0018](0018-sse-is-the-streaming-contract.md) | SSE is the streaming contract | Accepted |
| [0019](0019-feedback-through-the-api-and-cli.md) | Feedback through the REST API and the CLI | Accepted |
| [0020](0020-sources-seed-and-refresh.md) | Sources are adapters behind one contract | Accepted |
| [0021](0021-reactive-reverify-on-answer-path.md) | Re-verify on the answer path and on demand | Accepted |
| [0022](0022-gap-ledger-and-backfill.md) | Unanswered questions are a ledger; backfill closes it | Accepted |
| [0023](0023-usage-telemetry-on-every-step.md) | Usage telemetry on billable steps | Accepted |
| [0024](0024-sources-are-registered-records.md) | Sources are registered records; repos are cloned with native git | Accepted |
| [0025](0025-chunks-are-a-tree.md) | Chunks are a tree; structure lives in columns | Accepted |

## The rule

Every change to this repo cites an ADR (`ADR-NNNN` in the commit message and
PR body). A change that contradicts one fixes the ADR in the same commit:
rewritten in place before the first release, superseded after it. See
[AGENTS.md](../AGENTS.md).
