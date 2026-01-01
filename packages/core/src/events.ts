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
  };
  /** A previously-unanswered question can now be answered — the gap is closed. */
  "question.answered": {
    question: string;
    surface?: string;
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

/**
 * Top unanswered questions — a knowledge-gap ledger derived from the event log.
 * Grouping the raw abstain questions surfaces what people repeatedly ask that
 * the knowledgebase can't answer, so operators can fill real gaps (rather than the
 * bot fabricating). Surface-agnostic: any UI can render it.
 */
export async function listKnowledgeGaps(
  limit = 20,
): Promise<{ question: string; count: number; lastAskedAt: string }[]> {
  // Unanswered and answered are matched on a normalised form — lower-cased,
  // trimmed, trailing punctuation stripped — so "How do I stream?" closes
  // "how do i stream". Grouping uses the same key; the most recent raw phrasing
  // is the one shown (and re-asked by the backfill).
  const norm = (col: ReturnType<typeof sql>) =>
    sql`lower(trim(regexp_replace(${col}, '[[:punct:][:space:]]+$', '')))`;
  const rows = (await db().execute(sql`
    select (array_agg(payload->>'question' order by created_at desc))[1] as question,
           count(*)::int as count,
           max(created_at) as last_asked_at
    from events u
    where type = 'question.unanswered' and payload->>'question' is not null
      and not exists (
        select 1 from events a
        where a.type = 'question.answered'
          and ${norm(sql`a.payload->>'question'`)} = ${norm(sql`u.payload->>'question'`)}
          and a.created_at > u.created_at
      )
    group by ${norm(sql`payload->>'question'`)}
    order by count desc, last_asked_at desc
    limit ${limit}
  `)) as unknown as { question: string; count: number; last_asked_at: string | Date }[];
  return rows.map((r) => ({
    question: r.question,
    count: Number(r.count),
    lastAskedAt: new Date(r.last_asked_at).toISOString(),
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
