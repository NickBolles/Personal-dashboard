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

/**
 * The client address for throttling. X-Forwarded-For is a list the client can
 * prepend to, so read it from the right: each trusted proxy in front of Jarvis
 * (JARVIS_TRUSTED_PROXY_HOPS, default 1 = Traefik) appends the address it saw,
 * and the entry that many places from the end is the one we can trust.
 * IPv6 addresses are bucketed by /64, since one host usually owns a whole /64.
 */
export function clientIp(h: Headers, hops = config.trustedProxyHops) {
  if (hops <= 0) return "local";
  const list = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return "local";
  return normalizeIp(list[Math.max(0, list.length - hops)]!);
}

export function clientKey(req: NextRequest) {
  return clientIp(req.headers);
}

export function normalizeIp(raw: string) {
  let ip = raw.trim().toLowerCase();
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) ip = bracket[1]!;
  else if (/^[\d.]+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  if (!ip.includes(":")) return ip.slice(0, 64);
  const [head, tail] = ip.split("::", 2) as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip.slice(0, 64);
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
