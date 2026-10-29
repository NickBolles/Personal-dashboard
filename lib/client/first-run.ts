"use client";

import type { RunView } from "@/lib/hermes";

/**
 * A new chat opens before its first message is sent: "Ask" navigates as soon as the
 * conversation exists and posts the first run in the background. The conversation
 * page picks the in-flight send up here (shows the message at once, then streams).
 */
/** `key`: the run's idempotency key, reused if the owner retries after a lost response. */
export type FirstRun = { input: string; key: string; run: Promise<RunView> };

const pending = new Map<string, FirstRun>();

export function setFirstRun(sessionId: string, first: FirstRun) {
  pending.set(sessionId, first);
  // A page that never mounts must not keep the entry forever.
  first.run.catch(() => {}).finally(() => setTimeout(() => pending.get(sessionId) === first && pending.delete(sessionId), 60_000));
}

/** Take (once) the in-flight first send for this conversation. */
export function takeFirstRun(sessionId: string): FirstRun | undefined {
  const f = pending.get(sessionId);
  pending.delete(sessionId);
  return f;
}

export const hasFirstRun = (sessionId: string) => pending.has(sessionId);
