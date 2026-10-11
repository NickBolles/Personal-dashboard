import type { SessionSummary } from "./hermes";

/** Additive wire contract: old native clients still read sessions/unavailable. */
export type SessionPage = {
  sessions: SessionSummary[];
  unavailable?: string[];
  nextOffset?: number | null;
};

/** Hermes back-fills pins on every window; live recency order can overlap too. */
export function mergeSessionPages(pages: SessionPage[]): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const page of pages) for (const session of page.sessions) byId.set(session.id, session);
  return [...byId.values()];
}
