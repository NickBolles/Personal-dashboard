import type { SessionSummary } from "@/lib/hermes";

/**
 * Hermes delegate_task children: a session with a Hermes parent whose source is `subagent`, or
 * (webui-run delegations) a derived title starting "Subagent:". Jarvis forks also carry a parent
 * but get it from session_meta, never from Hermes' `parent_session_id`, so they never match.
 */
export function isSubagentSession(s: Pick<SessionSummary, "parentSessionId" | "source" | "title">) {
  if (!s.parentSessionId) return false;
  return s.source === "subagent" || /^subagent:/i.test(s.title.trim());
}

/**
 * Fold sub-agent child sessions under their parent: they leave the list, and a parent in the
 * same window gets `subagentCount`. Children whose parent isn't in the window are dropped too
 * (they're noise without it; the parent's page still reaches them through Hermes).
 */
export function foldSubagents<T extends Pick<SessionSummary, "id" | "parentSessionId" | "source" | "title" | "subagentCount">>(list: T[]): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (const s of list) {
    if (isSubagentSession(s)) counts.set(s.parentSessionId!, (counts.get(s.parentSessionId!) ?? 0) + 1);
    else kept.push(s);
  }
  return kept.map((s) => (counts.has(s.id) ? { ...s, subagentCount: (s.subagentCount ?? 0) + counts.get(s.id)! } : s));
}
