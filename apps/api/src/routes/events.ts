import { logger } from "@ask/config";
import { EVENT_CHANNEL, listEventsSince } from "@ask/core";
import { pgClient } from "@ask/db";
import type { FastifyInstance } from "fastify";
import { requireScope } from "../auth.js";

const log = logger("events");

/**
 * Server-Sent Events stream of domain events. Surfaces (the CLI / management
 * MCP today, other UIs later) subscribe here and render their own interfaces — the API
 * never pushes to a specific surface. On connect we replay everything after the
 * caller's `?since=<seq>` cursor (so a reconnecting subscriber misses nothing),
 * then stream live events via Postgres LISTEN/NOTIFY.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/events", { preHandler: requireScope("read") }, async (req, reply) => {
    // Replay is opt-in via `?since=<seq>` (a reconnecting subscriber passes its
    // cursor). Omitting it means "live only" — a fresh subscriber won't re-render
    // the whole history.
    const sinceParam = (req.query as { since?: string }).since;
    const since = sinceParam !== undefined ? Number(sinceParam) || 0 : undefined;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const write = (data: string) => raw.write(`event: event\ndata: ${data}\n\n`);

    // Replay missed events first, tracking the high-water mark so the live
    // listener doesn't double-deliver anything caught in the gap.
    let lastSeq = since ?? 0;
    if (since !== undefined) {
      try {
        for (const ev of await listEventsSince(since, 500)) {
          write(JSON.stringify(ev));
          lastSeq = Math.max(lastSeq, ev.seq);
        }
      } catch (err) {
        log.warn({ err }, "event replay failed");
      }
    }

    // Live tail via LISTEN. postgres-js delivers the NOTIFY payload as a string.
    const sql = pgClient();
    const subscription = await sql.listen(EVENT_CHANNEL, (payload) => {
      try {
        const ev = JSON.parse(payload) as { seq: number };
        if (ev.seq > lastSeq) {
          write(payload);
          lastSeq = ev.seq;
        }
      } catch {
        /* ignore malformed payloads */
      }
    });

    // Heartbeat keeps intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => raw.write(": ping\n\n"), 25_000);

    const close = () => {
      clearInterval(heartbeat);
      void subscription.unlisten();
      raw.end();
    };
    req.raw.on("close", close);
  });
}
