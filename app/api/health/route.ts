import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up. No auth, no dependencies. */
export function GET() {
  return NextResponse.json({ status: "ok", service: "jarvis", version: process.env.JARVIS_VERSION ?? "dev" });
}
