import type { AgentRunState } from "@/lib/agent-runs";
import { AGEING_MS, sortByUrgency, type Decision } from "@/lib/cw-decisions";
import type { LookSurface, Pipeline, RunEvent, RunLock } from "@/lib/cw-runs";

/** Client mirror of runTree's wire row; never import its server implementation. */
export type CoordinatorRunRow = {
  id: string;
  ref: string;
  seq: number;
  itemId: string;
  itemTitle: string;
  profile: string;
  title: string;
  state: AgentRunState;
  stalled: boolean;
  summary: string | null;
  prUrl: string | null;
  parentRunId: string | null;
  parentRef: string | null;
  pipeline: Pipeline;
  lock: RunLock | null;
  interruptedAt: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastEvent?: RunEvent;
  noticeCount: number;
};
export type RunsResponse = {
  runs: CoordinatorRunRow[];
  events: RunEvent[];
  lastLooked: Record<LookSurface, string | null>;
};
const newest = (a: CoordinatorRunRow, b: CoordinatorRunRow) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.seq - a.seq;

export function groupRuns(runs: readonly CoordinatorRunRow[], lastLookedRunning?: string | null) {
  const groups: Record<"attention" | "waiting" | "running" | "done" | "interrupted", CoordinatorRunRow[]> = {
    attention: [],
    waiting: [],
    running: [],
    done: [],
    interrupted: [],
  };
  const marker = lastLookedRunning ? Date.parse(lastLookedRunning) : NaN;
  const since = Number.isFinite(marker) ? marker : Date.now() - 86_400_000;
  for (const run of [...runs].filter((r) => !r.parentRunId).sort(newest)) {
    if (run.state === "interrupted") groups.interrupted.push(run);
    else if (run.state === "waiting") groups.waiting.push(run);
    else if (run.state === "failed" || run.stalled) groups.attention.push(run);
    else if (run.state === "running") groups.running.push(run);
    else if (run.state === "done" && run.finishedAt && Date.parse(run.finishedAt) > since) groups.done.push(run);
  }
  // Failures lead the attention section even when a waiting row has a newer heartbeat.
  groups.attention.sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed") || newest(a, b));
  return groups;
}
export function childrenOf(runs: readonly CoordinatorRunRow[], id: string) {
  return runs.filter((r) => r.parentRunId === id).sort(newest);
}

export type TrayLine = {
  kind: "run" | "decision" | "none";
  ref: string | null;
  text: string;
  tone: "bad" | "warn" | "ai" | "quiet";
  target: { tab: "running" | "needs" | "chat"; ref?: string };
};
const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
export function trayLine({ decisions, runs, now }: { decisions: readonly Decision[]; runs: readonly CoordinatorRunRow[]; now: Date | number }): TrayLine {
  const at = new Date(now);
  const failing = [...runs].filter((r) => r.state === "failed" || (r.stalled && r.state === "running")).sort(newest)[0];
  if (failing)
    return {
      kind: "run",
      ref: failing.ref,
      text: short(`${failing.ref} ${failing.state === "failed" ? "failed" : "stalled"} · ${failing.title}`),
      tone: "bad",
      target: { tab: "running", ref: failing.ref },
    };
  const open = decisions.filter((d) => d.state === "open");
  const urgent = sortByUrgency(
    open.filter((d) => d.risk.length > 0 || at.getTime() - Date.parse(d.createdAt) > AGEING_MS),
    at,
  )[0];
  const decision = urgent ?? [...open].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.seq - a.seq)[0];
  if (decision)
    return {
      kind: "decision",
      ref: decision.ref,
      text: short(`${decision.ref} · ${decision.question}`),
      tone: urgent ? "warn" : "quiet",
      target: { tab: "needs", ref: decision.ref },
    };
  const running = [...runs].filter((r) => r.state === "running").sort(newest)[0];
  if (running)
    return {
      kind: "run",
      ref: running.ref,
      text: short(`${running.ref} running · ${running.title}`),
      tone: "ai",
      target: { tab: "running", ref: running.ref },
    };
  return { kind: "none", ref: null, text: "", tone: "quiet", target: { tab: "chat" } };
}

export function sinceDivider(lastLookedChat: string | null | undefined, now: Date | number, counts: { decisions: number; runs: number }) {
  if (!lastLookedChat) return null;
  const then = new Date(lastLookedChat);
  const elapsed = new Date(now).getTime() - then.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 30 * 60_000) return null;
  const time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor(elapsed / 86_400_000);
  const start = days ? `${then.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
  const hours = Math.floor(elapsed / 3_600_000);
  const span = days ? `${days} d` : hours ? `${hours} h` : `${Math.floor(elapsed / 60_000)} min`;
  return { label: `Since ${start} · ${span}`, jumps: { ...counts } };
}
export function foldNotices(events: readonly RunEvent[]) {
  const folded: Record<string, { count: number; latest: RunEvent }> = {};
  for (const event of events) {
    if (event.type !== "notice") continue;
    const prior = folded[event.runId];
    folded[event.runId] = { count: (prior?.count ?? 0) + 1, latest: !prior || Date.parse(event.at) >= Date.parse(prior.latest.at) ? event : prior.latest };
  }
  return folded;
}
export function refChips(text: string): { ref: string; kind: "decision" | "run"; index: number }[] {
  return Array.from(text.matchAll(/\b([DR]-\d+)\b/g), (m) => ({ ref: m[0], kind: m[0][0] === "D" ? "decision" : "run", index: m.index }));
}
