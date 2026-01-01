import { logdrain } from "@ask/config";
import { db, gte, knowledgeItems, sql, usageEvents } from "@ask/db";
import type { Surface } from "./types.js";

export interface UsageInput {
  kind: string; // "answer" | "embed" | "cheap_op" | "ingest" | "watch" | ...
  surface?: Surface;
  actor?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Record a usage/telemetry event. Persists to the DB (source of truth) and, if
 * a logdrain is configured, ships a copy to the external target.
 */
export async function recordUsage(input: UsageInput): Promise<void> {
  await db()
    .insert(usageEvents)
    .values({
      kind: input.kind,
      surface: input.surface,
      actor: input.actor,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      metadata: input.metadata ?? {},
    });

  logdrain().send({ type: "usage", ...input });
}

/**
 * Total model cost recorded today — for the daily cost cap. "Today" is the UTC
 * calendar day, computed here rather than by `date_trunc('day', now())`, which
 * follows the session's timezone. Served by `usage_events_created_idx`.
 */
export async function costSpentTodayUsd(): Promise<number> {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db()
    .select({
      total: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, startOfUtcDay));
  return Number(row?.total ?? 0);
}

/** Rolling 24h operational stats — latency percentiles, cost, cache hit rate. */
export async function usageStats(): Promise<Record<string, unknown>> {
  const [row] = await db()
    .select({
      answers: sql<number>`count(*) filter (where ${usageEvents.kind} = 'answer')`,
      cacheHits: sql<number>`count(*) filter (where ${usageEvents.kind} = 'answer_cache_hit')`,
      avgLatencyMs: sql<number>`coalesce(avg(${usageEvents.latencyMs}) filter (where ${usageEvents.kind} in ('answer','answer_cache_hit')), 0)`,
      p95LatencyMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${usageEvents.latencyMs}) filter (where ${usageEvents.kind} in ('answer','answer_cache_hit')), 0)`,
      costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      tokensIn: sql<number>`coalesce(sum(${usageEvents.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${usageEvents.tokensOut}), 0)`,
    })
    .from(usageEvents)
    .where(sql`${usageEvents.createdAt} >= now() - interval '24 hours'`);

  const answers = Number(row?.answers ?? 0);
  const cacheHits = Number(row?.cacheHits ?? 0);
  const total = answers + cacheHits;
  return {
    window: "24h",
    answers,
    cacheHits,
    cacheHitRate: total > 0 ? cacheHits / total : 0,
    avgLatencyMs: Math.round(Number(row?.avgLatencyMs ?? 0)),
    p95LatencyMs: Math.round(Number(row?.p95LatencyMs ?? 0)),
    costUsd: Number(row?.costUsd ?? 0),
    tokensIn: Number(row?.tokensIn ?? 0),
    tokensOut: Number(row?.tokensOut ?? 0),
  };
}

/**
 * Knowledge-base health: how much we hold, how stale it is, and where. Exposes
 * the decay/staleness state (the `stale` status + `lastVerifiedAt`) so
 * operators can see the oldest / most decayed knowledge per source instead of
 * querying the DB by hand.
 */
export async function knowledgeStats(): Promise<Record<string, unknown>> {
  const rows = (await db()
    .select({
      source: knowledgeItems.sourceType,
      total: sql<number>`count(*)`,
      active: sql<number>`count(*) filter (where ${knowledgeItems.status} = 'active')`,
      stale: sql<number>`count(*) filter (where ${knowledgeItems.status} = 'stale')`,
      oldestVerifiedAt: sql<string | null>`min(${knowledgeItems.lastVerifiedAt})`,
      avgAgeDays: sql<number>`coalesce(avg(extract(epoch from (now() - ${knowledgeItems.lastVerifiedAt})) / 86400.0), 0)`,
      maxAgeDays: sql<number>`coalesce(max(extract(epoch from (now() - ${knowledgeItems.lastVerifiedAt})) / 86400.0), 0)`,
    })
    .from(knowledgeItems)
    .groupBy(knowledgeItems.sourceType)) as {
    source: string;
    total: number;
    active: number;
    stale: number;
    oldestVerifiedAt: string | Date | null;
    avgAgeDays: number;
    maxAgeDays: number;
  }[];

  const bySource = rows
    .map((r) => ({
      source: r.source,
      total: Number(r.total),
      active: Number(r.active),
      stale: Number(r.stale),
      oldestVerifiedAt: r.oldestVerifiedAt ? new Date(r.oldestVerifiedAt).toISOString() : null,
      avgAgeDays: Math.round(Number(r.avgAgeDays) * 10) / 10,
      maxAgeDays: Math.round(Number(r.maxAgeDays) * 10) / 10,
    }))
    .sort((a, b) => b.total - a.total);

  const total = bySource.reduce((n, s) => n + s.total, 0);
  const stale = bySource.reduce((n, s) => n + s.stale, 0);
  const oldest = bySource
    .map((s) => s.oldestVerifiedAt)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null;

  return { total, stale, staleRate: total > 0 ? stale / total : 0, oldestVerifiedAt: oldest, bySource };
}
