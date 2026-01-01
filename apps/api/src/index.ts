import { logger } from "@ask/config";
import { closeDb } from "@ask/db";
import { startApi } from "./start.js";

const log = logger("api");

async function main(): Promise<void> {
  const { close } = await startApi();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    await close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
