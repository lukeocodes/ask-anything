import { loadEnv } from "@ask/config";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

let sqlClient: ReturnType<typeof postgres> | undefined;
let dbInstance: Database | undefined;

/**
 * Build a postgres-js client from DATABASE_URL. Handles the Cloud SQL unix-socket
 * form (`postgresql://user:pass@/db?host=/cloudsql/INSTANCE`) — Node's URL parser
 * rejects the empty host, so we detect it and pass `host` as an option (postgres-
 * js uses a unix socket when host starts with `/`). Normal TCP URLs pass through.
 */
function makeClient(url: string): ReturnType<typeof postgres> {
  const socket = /^postgres(?:ql)?:\/\/([^:/@]+):([^@]+)@\/([^?]+)\?host=(.+)$/.exec(url);
  if (socket) {
    const [, username, password, database, host] = socket;
    return postgres({
      host: decodeURIComponent(host!),
      database: decodeURIComponent(database!),
      username: decodeURIComponent(username!),
      password: decodeURIComponent(password!),
      max: 10,
    });
  }
  return postgres(url, { max: 10 });
}

/** Lazily-constructed shared Drizzle client backed by a postgres-js pool. */
export function db(): Database {
  if (!dbInstance) {
    sqlClient = makeClient(loadEnv().DATABASE_URL);
    dbInstance = drizzle(sqlClient, { schema });
  }
  return dbInstance;
}

/**
 * The raw postgres-js client (shares the pool with db()). Needed for LISTEN /
 * NOTIFY, which Drizzle doesn't wrap — used by the event stream.
 */
export function pgClient(): ReturnType<typeof postgres> {
  db(); // ensure the pool is initialized
  return sqlClient!;
}

/** Close the pool (graceful shutdown / tests). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbInstance = undefined;
  }
}

/**
 * Assert the migrated `knowledge_chunks.embedding` column width matches the
 * configured EMBEDDING_DIM. pgvector stores the dimension in `atttypmod`, so a
 * mismatch is visible before the first insert fails. Call once at startup.
 */
export async function assertEmbeddingDim(): Promise<number> {
  const expected = loadEnv().EMBEDDING_DIM;
  const rows = await pgClient()<{ atttypmod: number }[]>`
    SELECT atttypmod
    FROM pg_attribute
    WHERE attrelid = 'knowledge_chunks'::regclass AND attname = 'embedding'
  `;
  const typmod = rows[0]?.atttypmod;
  if (typmod === undefined) {
    throw new Error(
      "knowledge_chunks.embedding column not found — run `pnpm db:migrate` before starting",
    );
  }
  if (typmod !== expected) {
    throw new Error(
      `EMBEDDING_DIM mismatch: env says ${expected} but knowledge_chunks.embedding is vector(${typmod}). ` +
        "Add a migration for the new width and re-embed, or set EMBEDDING_DIM to match the column.",
    );
  }
  return typmod;
}
