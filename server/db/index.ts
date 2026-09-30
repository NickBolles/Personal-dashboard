import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { config } from "@/server/config";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

type Holder = { db: DB; sqlite: Database.Database; path: string };
const g = globalThis as unknown as { __jarvisDb?: Holder };

function migrationsFolder() {
  const candidates = [process.env.JARVIS_MIGRATIONS_DIR, path.join(process.cwd(), "drizzle")].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(/*turbopackIgnore: true*/ c, "meta", "_journal.json"))) return c;
  throw new Error(`Drizzle migrations folder not found (looked in ${candidates.join(", ")})`);
}

export function openDatabase(file: string): Holder {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(/*turbopackIgnore: true*/ file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, sqlite, path: file };
}

export function getDb(): DB {
  const file = config.databasePath;
  if (!g.__jarvisDb || g.__jarvisDb.path !== file) {
    g.__jarvisDb = openDatabase(file);
  }
  return g.__jarvisDb.db;
}

export function getSqlite() {
  getDb();
  return g.__jarvisDb!.sqlite;
}

/** Test helper: swap in an isolated database. */
export function __setTestDatabase(file = ":memory:") {
  g.__jarvisDb = openDatabase(file);
  return g.__jarvisDb.db;
}

export { schema };
