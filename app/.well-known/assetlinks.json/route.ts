import { NextResponse } from "next/server";
import { assetLinks } from "@/server/android/assetlinks";

export const dynamic = "force-dynamic";

/** Public: Chrome checks this before opening the Android app full screen (no auth, no cookies). */
export function GET() {
  return NextResponse.json(assetLinks(), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
