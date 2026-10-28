import "server-only";
import { HOUR } from "@/lib/time";

const hits = new Map<string, number[]>();

/** Sliding one-hour window per key (in memory; one server process). */
export function rateLimit(key: string, perHour: number, now = Date.now()) {
  const list = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
  if (list.length >= perHour) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}
