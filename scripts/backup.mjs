#!/usr/bin/env node
// Online backup of Jarvis-owned data (SQLite + encryption key).
//   docker compose exec jarvis node scripts/backup.mjs            → /data/backups/<timestamp>/
//   node scripts/backup.mjs --out ./my-backups                    (local)
// Restore: stop Jarvis, copy jarvis.db (+ secret.key if you don't use JARVIS_SECRET_KEY) back into the data dir, start.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = path.resolve(process.env.JARVIS_DATA_DIR ?? "./data");
const dbPath = process.env.JARVIS_DB_PATH ?? path.join(dataDir, "jarvis.db");
const outIdx = process.argv.indexOf("--out");
const base = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(dataDir, "backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(base, stamp);

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
const db = new Database(dbPath, { readonly: true });
await db.backup(path.join(dest, "jarvis.db"));
db.close();
const key = path.join(dataDir, "secret.key");
if (fs.existsSync(key)) fs.copyFileSync(key, path.join(dest, "secret.key"));
fs.chmodSync(dest, 0o700);

// Verify the copy opens and has our tables.
const check = new Database(path.join(dest, "jarvis.db"), { readonly: true });
const tables = check
  .prepare("select name from sqlite_master where type='table'")
  .all()
  .map((r) => r.name);
check.close();
for (const t of ["users", "integrations", "notifications", "entity_links", "push_subscriptions"]) {
  if (!tables.includes(t)) {
    console.error(`Backup verification failed: missing table ${t}`);
    process.exit(2);
  }
}
console.log(`Backup written to ${dest} (${tables.length} tables). Keep it private: it contains encrypted credentials and the key.`);

// Keep the 14 most recent backups in the default location.
if (outIdx === -1) {
  const all = fs.readdirSync(base).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(base, old), { recursive: true, force: true });
}
