# 0022. Unanswered questions are a ledger; backfill closes it

Date: 2026-01-01

## Status

Accepted

## Context

Abstaining (see [0006](0006-grounded-only-answers.md)) leaves the user with
nothing and operators with no signal. The knowledge base grows daily.

## Decision

Every abstain on a real question emits `question.unanswered`. `listKnowledgeGaps`
reads the event log and returns open gaps ordered by count, excluding any
question with a later `question.answered` event.

Gaps group by the clustered `questions` table
([0017](0017-question-logging-off-critical-path.md)). Decided on
[PR #11](https://github.com/lukeocodes/ask-anything/pull/11#issuecomment-6712286063):

- `question.unanswered` carries `questionEventId`. The ledger joins
  `question_events.question_id` when it reads. Nothing on the answer path
  waits for clustering.
- An event with no cluster yet, or whose clustering failed, falls back to a
  normalised-text key (lowercased, trimmed, trailing punctuation stripped), so
  it still shows up.
- The backfill puts the gap's `questionId` in `question.answered`. That closes
  every unanswered event in the cluster older than the answer. Text match
  stays as the fallback for unclustered gaps.
- The ledger shows, and the backfill re-asks, the most recent raw phrasing in
  the cluster.
- `count` is the unanswered events in the cluster since it was last answered.

`BACKFILL_CRON` runs `runGapBackfill`: the top 30 gaps are re-asked through
`ask()` with `surface: "backfill"`, at `visibility: "public"`, no re-verify
sink. Machine surfaces never emit
`question.unanswered`, so a still-open gap keeps its count. A grounded answer emits `question.answered`, closing the gap and warming
the cache. Gaps that still abstain stay open.

## Consequences

- Gaps are observable and prioritisable.
- Gaps close as the KB grows without anyone re-asking.
- A gap only a private-tier caller could answer never closes.
- Long-tail gaps beyond the top 30 by count are never re-asked.

## Known gaps

- Paraphrases are separate gaps. The ledger does not use the clustered
  `questions` table.
