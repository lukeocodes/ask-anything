import pino, { type Logger } from "pino";

export type { Logger };

let root: Logger | undefined;

/**
 * Process-wide root logger. Pretty in dev, JSON in prod. When LOGDRAIN_URL is
 * set the drain transport (see logdrain.ts) is attached alongside stdout.
 */
export function logger(name?: string): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: "ask" },
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    });
  }
  return name ? root.child({ component: name }) : root;
}
