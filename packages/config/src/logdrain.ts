import { logger } from "./logger.js";

/**
 * Logdrain: ship structured records (logs and usage/telemetry events) to an
 * external HTTP target. Fire-and-forget with a bounded in-memory buffer so a
 * slow/down drain never blocks a request. No-op when LOGDRAIN_URL is unset.
 */
export interface DrainRecord {
  type: "log" | "usage" | "event";
  at: string;
  [key: string]: unknown;
}

const MAX_BUFFER = 1000;

export class Logdrain {
  private buffer: DrainRecord[] = [];
  private readonly url?: string;
  private readonly token?: string;
  private flushing = false;

  constructor(opts?: { url?: string; token?: string }) {
    this.url = opts?.url ?? process.env.LOGDRAIN_URL;
    this.token = opts?.token ?? process.env.LOGDRAIN_TOKEN;
  }

  get enabled(): boolean {
    return Boolean(this.url);
  }

  send(record: Omit<DrainRecord, "at"> & { at?: string }): void {
    if (!this.enabled) return;
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push({
      ...record,
      at: record.at ?? new Date().toISOString(),
    } as DrainRecord);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await fetch(this.url!, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: batch.map((r) => JSON.stringify(r)).join("\n"),
      });
    } catch (err) {
      // Re-buffer the batch (bounded) and log locally; never throw.
      this.buffer.unshift(...batch.slice(0, MAX_BUFFER));
      logger("logdrain").warn({ err }, "logdrain flush failed");
    } finally {
      this.flushing = false;
    }
  }
}

let shared: Logdrain | undefined;
export function logdrain(): Logdrain {
  if (!shared) shared = new Logdrain();
  return shared;
}
