import "server-only";
import { getSqlite } from "@/server/db";

export type ReleaseInfo = {
  /** the deployed commit (JARVIS_VERSION), "dev" locally */
  version: string;
  /** when this server process started: the deploy time for a container swap */
  startedAt: string;
  /** applied database migrations */
  migrations: number | null;
  /** when the latest migration ran (ms epoch from drizzle), if any */
  migratedAt: string | null;
};

const STARTED = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/** What is running right now. No network calls: everything is local. */
export function releaseInfo(): ReleaseInfo {
  let migrations: number | null = null;
  let migratedAt: string | null = null;
  try {
    const row = getSqlite().prepare("select count(*) as n, max(created_at) as at from __drizzle_migrations").get() as { n: number; at: number | string | null };
    migrations = row.n;
    const ms = Number(row.at);
    migratedAt = row.at != null && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  } catch {
    // An unmigrated DB: report what we know.
  }
  return { version: process.env.JARVIS_VERSION ?? "dev", startedAt: STARTED, migrations, migratedAt };
}
