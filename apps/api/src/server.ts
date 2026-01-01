import { loadEnv, logger } from "@ask/config";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { adminRoutes } from "./routes/admin.js";
import { askRoutes } from "./routes/ask.js";
import { chunkRoutes } from "./routes/chunks.js";
import { eventRoutes } from "./routes/events.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { healthRoutes } from "./routes/health.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { searchRoutes } from "./routes/search.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { mcpRoutes } from "./mcp.js";

/** Build the Fastify app with all routes registered. */
export async function buildServer() {
  const app = Fastify({ loggerInstance: logger("api") });

  // Per-key (falls back to per-IP) request rate limiting.
  await app.register(rateLimit, {
    max: loadEnv().RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const auth = req.headers.authorization ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-api-key"] as string | undefined);
      return key ?? req.ip;
    },
  });

  await app.register(healthRoutes);
  await app.register(askRoutes);
  await app.register(searchRoutes);
  await app.register(knowledgeRoutes);
  await app.register(chunkRoutes);
  await app.register(feedbackRoutes);
  await app.register(eventRoutes);
  await app.register(adminRoutes);
  await app.register(registerSourceRoutes);
  // MCP (Streamable HTTP) — unauthenticated by design; registered last.
  await app.register(mcpRoutes);

  return app;
}
