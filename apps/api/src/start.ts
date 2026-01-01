import { loadEnv, logger } from "@ask/config";
import { assertEmbeddingDim } from "@ask/db";
import { registerBuiltinAdapters } from "@ask/sources";
import { startScheduler } from "./jobs/scheduler.js";
import { buildServer } from "./server.js";

const log = logger("api");

/**
 * Start the API server + background jobs. Returns a `close()` so a host (the
 * standalone entry, or the all-in-one runtime) owns shutdown. Does not install
 * signal handlers itself — the entrypoint does.
 */
export async function startApi(): Promise<{ close: () => Promise<void> }> {
  const env = loadEnv();
  // Source adapters (ADR-0020) must be registered before any route or job
  // creates, indexes or refreshes a source.
  registerBuiltinAdapters();
  // Fail fast: the pgvector column width must match EMBEDDING_DIM (ADR-0003).
  const dim = await assertEmbeddingDim();
  log.info({ dim }, "embedding dimension verified");
  const app = await buildServer();
  startScheduler();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  log.info({ port: env.PORT }, "ask-api listening");
  return { close: () => app.close() };
}

export { buildServer } from "./server.js";
