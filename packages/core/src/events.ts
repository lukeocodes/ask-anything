import { logger } from "@ask/config";
import { db, desc, events, gt, sql, type EventRow } from "@ask/db";

const log = logger("events");

/**
 * pg_notify payloads are capped at 8000 bytes. Keep a margin below it so the
 * NOTIFY never throws after the row is already written.
 */
const NOTIFY_MAX_BYTES = 7000;

/**
 * Domain events the core emits for surfaces to react to. The core owns WHAT
 * happened; each surface (CLI / management MCP today, web later) owns how it's shown. Keep
 * payloads small — they ride a Postgres NOTIFY (8KB limit) as well as the table.
 */
export interface EventPayloads {
  /** A private item was auto-created and needs a public/private decision. */
  "knowledge.review_requested": {
    itemId: string;
    title: string;
    sourceType: string;
    sourceRef?: string | null;
  };
  /** An answer received up/down feedback. */
  "answer.feedback": {
    answerId: string;
    rating: "up" | "down";
    actorRef?: string;
    surface?: string;
  };
  /** The engine abstained on a real question — a knowledge gap worth filling. */
  "question.unanswered": {
    question: string;
    surface?: string;
    /** The `question_events` row, so the ledger can find its cluster (ADR-0022). */
    questionEventId?: string;
  };
  /** A previously-unanswered question can now be answered — the gap is closed. */
  "question.answered": {
    question: string;
    surface?: string;
    /** The gap's `questions` cluster; closes every older miss in it (ADR-0022). */
    questionId?: string;
  };
}

export type EventType = keyof EventPayloads;

export interface AskEvent<T extends EventType = EventType> {
  seq: number;
  type: T;
  payload: EventPayloads[T];
  createdAt: string;
}

/** Postgres NOTIFY channel the event stream listens on. */
export const EVENT_CHANNEL = "ask_events";

/**
 * Emit a domain event: append it to the durable log, then NOTIFY so live
 * subscribers (the API's event stream) pick it up immediately. Emitting must
 * never break the request that triggered it — failures are swallowed.
 */
export async function emitEvent<T extends EventType>(
  type: T,
  payload: EventPayloads[T],
): Promise<void> {
  try {
    const [row] = await db()
      .insert(events)
      .values({ type, payload })
      .returning({ seq: events.seq, createdAt: events.createdAt });
    if (!row) return;
    const message = fitNotifyPayload({ seq: row.seq, type, payload, createdAt: row.createdAt });
    await db().execute(sql`select pg_notify(${EVENT_CHANNEL}, ${message})`);
  } catch (err) {
    // Best-effort: an event that fails to emit must not fail the caller — but
    // it must not be invisible either.
    log.error({ err, type }, "event emit failed");
  }
}

/**
 * Serialise the NOTIFY message, truncating the payload's longest string fields
 * until it fits under NOTIFY_MAX_BYTES. Subscribers (the API's event stream)
 * forward the NOTIFY payload as-is rather than refetching the row, so the
 * envelope must stay complete — only string values are shortened. The durable
 * row keeps the full payload.
 */
function fitNotifyPayload(envelope: {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): string {
  let message = JSON.stringify(envelope);
  if (Buffer.byteLength(message) <= NOTIFY_MAX_BYTES) return message;

  const payload: Record<string, unknown> = { ...envelope.payload };
  for (let i = 0; i < 20; i++) {
    const over = Buffer.byteLength(message) - NOTIFY_MAX_BYTES;
    if (over <= 0) break;
    const [longest] = Object.entries(payload)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .sort((a, b) => b[1].length - a[1].length);
    if (!longest || longest[1].length === 0) break;
    const [key, value] = longest;
    // Every char is ≥ 1 byte on the wire, so dropping `over` chars sheds at
    // least `over` bytes; the loop mops up any remainder.
    payload[key] = `${value.slice(0, Math.max(0, value.length - over - 1))}…`;
    message = JSON.stringify({ ...envelope, payload });
  }
  if (Buffer.byteLength(message) > NOTIFY_MAX_BYTES) {
    log.warn({ type: envelope.type, seq: envelope.seq }, "notify payload truncated to envelope");
    message = JSON.stringify({ ...envelope, payload: {} });
  }
  return message;
}

/** Replay events after a cursor (ascending), for subscribers reconnecting. */
export async function listEventsSince(sinceSeq: number, limit = 100): Promise<AskEvent[]> {
  const rows = await db()
    .select()
    .from(events)
    .where(gt(events.seq, sinceSeq))
    .orderBy(events.seq)
    .limit(limit);
  return rows.map(toEvent);
}

/** Most recent events (newest first) — for a UI showing recent activity. */
export async function listRecentEvents(limit = 50): Promise<AskEvent[]> {
  const rows = await db().select().from(events).orderBy(desc(events.seq)).limit(limit);
  return rows.map(toEvent);
}

export interface KnowledgeGap {
  /** Most recent raw phrasing in the group. */
  question: string;
  /** Unanswered events in the group since it was last answered. */
  count: number;
  lastAskedAt: string;
  /** The `questions` cluster, or null when the group fell back to text. */
  questionId: string | null;
}

/** The `question.answered` payload that closes a gap (ADR-0022). */
export function gapAnsweredPayload(
  gap: Pick<KnowledgeGap, "question" | "questionId">,
  surface: string,
): EventPayloads["question.answered"] {
  return gap.questionId
    ? { question: gap.question, surface, questionId: gap.questionId }
    : { question: gap.question, surface };
}

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * Top unanswered questions — a knowledge-gap ledger derived from the event log.
 * Grouping the raw abstain questions surfaces what people repeatedly ask that
 * the knowledgebase can't answer, so operators can fill real gaps (rather than the
 * bot fabricating). Surface-agnostic: any UI can render it.
 *
 * ADR-0022: an unanswered event groups by its `questions` cluster, found
 * through `questionEventId` → `question_events.question_id` at read time.
 * Events with no cluster yet (or a failed one, or written before the id was
 * in the payload) group by a normalised-text key instead. A later
 * `question.answered` closes an event when it names the event's cluster, or
 * when its normalised text matches.
 */
export async function listKnowledgeGaps(limit = 20): Promise<KnowledgeGap[]> {
  // Lower-cased, trimmed, trailing punctuation stripped, so "How do I stream?"
  // matches "how do i stream".
  const norm = (col: ReturnType<typeof sql>) =>
    sql`lower(trim(regexp_replace(${col}, '[[:punct:][:space:]]+$', '')))`;
  const rows = (await db().execute(sql`
    with misses as (
      select u.created_at,
             u.payload->>'question' as question,
             ${norm(sql`u.payload->>'question'`)} as nkey,
             qe.question_id as qid
      from events u
      left join question_events qe
        on qe.id = case when u.payload->>'questionEventId' ~ ${UUID_RE}
                        then (u.payload->>'questionEventId')::uuid end
      where u.type = 'question.unanswered' and u.payload->>'question' is not null
    ),
    open_misses as (
      select m.* from misses m
      where not exists (
        select 1 from events a
        where a.type = 'question.answered'
          and a.created_at > m.created_at
          and (
            (m.qid is not null and a.payload->>'questionId' = m.qid::text)
            or ${norm(sql`a.payload->>'question'`)} = m.nkey
          )
      )
    )
    select (array_agg(question order by created_at desc))[1] as question,
           count(*)::int as count,
           max(created_at) as last_asked_at,
           (array_agg(qid::text))[1] as question_id
    from open_misses
    group by case when qid is not null then 'q:' || qid::text else 't:' || nkey end
    order by count desc, last_asked_at desc
    limit ${limit}
  `)) as unknown as {
    question: string;
    count: number;
    last_asked_at: string | Date;
    question_id: string | null;
  }[];
  return rows.map((r) => ({
    question: r.question,
    count: Number(r.count),
    lastAskedAt: new Date(r.last_asked_at).toISOString(),
    questionId: r.question_id ?? null,
  }));
}

function toEvent(row: EventRow): AskEvent {
  return {
    seq: Number(row.seq),
    type: row.type as EventType,
    payload: row.payload as EventPayloads[EventType],
    createdAt: row.createdAt.toISOString(),
  };
}
