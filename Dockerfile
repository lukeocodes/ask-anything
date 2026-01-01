# The service (@ask/api): REST API + background jobs + hosted MCP (/mcp) in one process.
# Runs the TypeScript sources directly via tsx (no build step), matching dev.
FROM node:22-bookworm-slim
# git: registered sources are cloned inside the service (ADR-0024).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

# Install the full workspace with the lockfile (tsx is a dev dependency, so we
# keep dev deps — do NOT pass --prod).
COPY . .
RUN pnpm install --frozen-lockfile

# Cloud Run injects PORT (default 8080); the API binds it. Keep the process warm
# (min-instances=1, CPU always allocated) so the cron jobs fire on schedule.
ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "--filter", "@ask/api", "start"]
