import { NextResponse } from "next/server";
import { getSqlite } from "@/server/db";
import { workerStatus } from "@/server/worker";

export const dynamic = "force-dynamic";

/** Readiness: database reachable and migrated. */
export function GET() {
  try {
    const row = getSqlite().prepare("select count(*) as n from __drizzle_migrations").get() as { n: number };
    return NextResponse.json({ status: "ready", migrations: row.n, worker: workerStatus() });
  } catch (err) {
    return NextResponse.json({ status: "not_ready", error: (err as Error).message }, { status: 503 });
  }
}
