import "server-only";
import type { NextRequest } from "next/server";
import { config } from "@/server/config";

/** The origin a phone should use to reach this Jarvis (JARVIS_PUBLIC_ORIGIN wins over request headers). */
export function publicOrigin(req: NextRequest) {
  if (config.publicOrigin) return config.publicOrigin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

export function clientKey(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
