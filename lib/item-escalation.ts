import type { DecisionEntry } from "./decisions";
import { isStalled, type ExternalRun, type ItemAgentInfo } from "./agent-runs";

export type ItemEscalation =
  | { kind: "decision"; agent: string; decision: DecisionEntry }
  | { kind: "run"; agent: string; run: ExternalRun; stalled: boolean }
  | { kind: "failed"; agent: string; sessionId: string };

/** An explicit agent question wins over run trouble. A newer run by the same profile supersedes its old failure. */
export function selectEscalation(itemId: string, decisions: readonly DecisionEntry[], info: ItemAgentInfo | undefined, now: number): ItemEscalation | null {
  const decision = decisions.filter((d) => d.itemId === itemId && d.kind === "item" && d.askedBy).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (decision) return { kind: "decision", agent: `@${decision.askedBy}`, decision };
  const runs = info?.agentRuns ?? [];
  const run = runs
    .filter((r) => (r.state === "failed" || isStalled(r, now)) && !runs.some((newer) => newer.profile === r.profile && newer.startedAt > r.startedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
  if (run) return { kind: "run", agent: `@${run.profile}`, run, stalled: isStalled(run, now) };
  if (info?.live === "failed" && info.sessionId)
    return { kind: "failed", agent: info.who && info.who.kind !== "person" ? `@${info.who.name}` : "Agent", sessionId: info.sessionId };
  return null;
}
