import { loadEnv, type ApiKeyEntry } from "@ask/config";
import { costSpentTodayUsd } from "@ask/core";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKeyEntry;
  }
}

const SCOPE_RANK: Record<ApiKeyEntry["scope"], number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Resolve the visibility a request may use, capped to the key's tier.
 * A public key is always forced to `public` (it holds no private secret).
 * A private key defaults to `private` (it unlocked internal knowledge) but may
 * explicitly downgrade to `public`.
 */
export function resolveVisibility(
  key: ApiKeyEntry,
  requested?: "public" | "private",
): "public" | "private" {
  if (key.visibility === "public") return "public";
  return requested ?? "private";
}

/**
 * A public-tier key never learns a private item exists: it reads as
 * not-found, the same answer a bad id gets.
 */
export function visibleTo(req: FastifyRequest, item: { visibility: "public" | "private" }): boolean {
  return req.apiKey?.visibility === "private" || item.visibility === "public";
}

/**
 * preHandler for routes that only make sense with the private secret (the
 * visibility-review queue). Runs after requireScope, which sets req.apiKey.
 */
export async function requirePrivateTier(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.apiKey?.visibility !== "private") {
    await reply.code(403).send({ error: "private_tier_required" });
  }
}

/** How long one spend aggregate is reused before it's recomputed. */
const COST_CACHE_TTL_MS = 30_000;
let costCache: { total: number; at: number } | undefined;

/**
 * Today's spend, memoised in-process for 30s so the guard isn't a sum over
 * `usage_events` on every request. Single-instance deployment (ADR-0015), so a
 * process-local cache is the whole picture; the cap may be overshot by at most
 * 30s of traffic.
 */
async function spentTodayCached(): Promise<number> {
  const now = Date.now();
  if (costCache && now - costCache.at < COST_CACHE_TTL_MS) return costCache.total;
  const total = await costSpentTodayUsd();
  costCache = { total, at: now };
  return total;
}

/**
 * Daily model-cost cap. When DAILY_COST_CAP_USD > 0 and today's spend is at or
 * over it, reject answer requests with 429 so a runaway can't rack up cost.
 */
export async function costCapGuard(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cap = loadEnv().DAILY_COST_CAP_USD;
  if (cap <= 0) return;
  if ((await spentTodayCached()) >= cap) {
    await reply.code(429).send({ error: "daily_cost_cap_reached", cap });
  }
}

/**
 * Static API-key auth. Keys are a hardcoded CSV baked into the deployment env
 * (API_KEYS = "key:label:scope:visibility,..." — visibility is `public` or
 * `private`, and is the credential that unlocks private knowledge; see
 * resolveVisibility). Rotating keys = redeploy with new env.
 * Returns a preHandler that requires at least `min` scope.
 */
export function requireScope(min: ApiKeyEntry["scope"]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice(7)
      : (req.headers["x-api-key"] as string | undefined) ?? "";

    const entry = loadEnv().apiKeys.find((k) => k.key === presented);
    if (!entry) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (SCOPE_RANK[entry.scope] < SCOPE_RANK[min]) {
      await reply.code(403).send({ error: "forbidden", need: min });
      return;
    }
    req.apiKey = entry;
  };
}
