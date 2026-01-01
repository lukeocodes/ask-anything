import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ask:ask@localhost:5432/ask",
  },
  // pgvector lives in a Postgres extension; ensure it exists before migrating.
  // Migration 0000 enables it (see src/schema.ts note).
  strict: true,
});
