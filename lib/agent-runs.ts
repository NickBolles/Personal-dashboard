/**
 * Agent runs on items (Work from Jarvis batch 2): who is on an item, the live
 * state of its linked Hermes runs and AI jobs, its PRs (CI + merge + deploy)
 * and the last report. Pure helpers (unit-tested in test/agent-runs.test.ts);
 * the server aggregates read-only from runs, ai_jobs, ai_reports and work_links.
 */
import { parseAssignee } from "@/lib/item-tags";
import { bucketOf } from "@/lib/map-rollup";
import type { WorkItem } from "@/lib/work";

export const RUN_LIVE = ["running", "waiting", "failed", "finished", "idle"] as const;
export type RunLive = (typeof RUN_LIVE)[number];

export const RUN_LIVE_LABEL: Record<RunLive, string> = {
  running: "Running",
  waiting: "Waiting for approval",
  failed: "Failed",
  finished: "Finished",
  idle: "No runs yet",
};

/** Jarvis `runs.status` (lib/hermes.ts RunPhase) → live state. */
export function liveOfRun(status: string): RunLive {
  switch (status) {
    case "waiting_for_approval":
      return "waiting";
    case "starting":
    case "queued":
    case "running":
    case "stopping":
    case "reconnecting":
    case "disconnected":
      return "running";
    case "failed":
    case "interrupted":
      return "failed";
    case "completed":
    case "cancelled":
      return "finished";
    default:
      return "idle";
  }
}

/** ai_jobs.state (lib/ai.ts JOB_STATES) → live state. */
export function liveOfJob(state: string): RunLive {
  switch (state) {
    case "waiting_approval":
    case "budget_blocked":
      return "waiting";
    case "queued":
    case "running":
    case "cancelling":
      return "running";
    case "failed":
      return "failed";
    case "succeeded":
    case "cancelled":
    case "skipped":
      return "finished";
    default:
      return "idle";
  }
}

export type RunSample = { live: RunLive; at: string; sessionId?: string | null; source: "chat" | "job" };

/**
 * One state per item: anything waiting on the owner wins, then anything still
 * running, else the latest finished/failed run decides. No samples = idle.
 */
export function aggregateRunState(samples: readonly RunSample[]): { live: RunLive; at: string | null; sessionId: string | null } {
  const pick = (live: RunLive) => samples.filter((s) => s.live === live).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  for (const l of ["waiting", "running"] as const) {
    const s = pick(l);
    if (s) return { live: l, at: s.at, sessionId: s.sessionId ?? null };
  }
  const done = samples.filter((s) => s.live === "failed" || s.live === "finished").sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  return done ? { live: done.live, at: done.at, sessionId: done.sessionId ?? null } : { live: "idle", at: null, sessionId: null };
}

export type Who = { kind: "agent" | "coordinator" | "person"; name: string };

/** Who is on the item: its assignee, else the area coordinator (area agent mode). */
export function whoIsOn(item: Pick<WorkItem, "assignee">, coordinator: string | null, personName?: (id: string) => string | undefined): Who | null {
  const a = parseAssignee(item.assignee);
  if (a?.kind === "agent") return { kind: "agent", name: a.id };
  if (a?.kind === "person") return { kind: "person", name: personName?.(a.id) ?? "Someone" };
  const c = coordinator?.trim().toLowerCase();
  return c && c !== "default" ? { kind: "coordinator", name: c } : null;
}

export type PrState = {
  ref: string;
  url: string | null;
  title: string;
  /** open | merged | closed | null (not read back yet) */
  state: string | null;
  /** success | failure | pending | null */
  checks: string | null;
  /** merged PRs: "live" once the item is live/settled, else "waiting" (not deployed yet); null for unmerged PRs and abandoned/superseded items */
  deploy: "live" | "waiting" | null;
};

export function deployOf(prState: string | null, item: Pick<WorkItem, "status" | "decision">): PrState["deploy"] {
  if (prState !== "merged") return null;
  // Only statuses that mean the work actually shipped count as live; an
  // abandoned/superseded item's merged PR was never confirmed live (#170).
  if (item.status === "abandoned" || item.status === "superseded") return null;
  const b = bucketOf(item);
  return b === "live" || item.status === "settled" ? "live" : "waiting";
}

export const CHECKS_LABEL: Record<string, string> = { success: "CI passing", failure: "CI failing", pending: "CI running" };
export const DEPLOY_LABEL: Record<"live" | "waiting", string> = { live: "Live", waiting: "Merged · not live yet" };

export type ItemAgentInfo = {
  itemId: string;
  areaId: string | null;
  title: string;
  who: Who | null;
  live: RunLive;
  /** when the deciding run started/finished */
  liveAt: string | null;
  /** the Hermes conversation of the deciding run (opens it) */
  sessionId: string | null;
  runs: number;
  prs: PrState[];
  report: { title: string; summary: string; at: string; href: string | null } | null;
  /** direct non-container children done / total (null when it has none) */
  progress: { done: number; total: number } | null;
};

export type AgentRunsResponse = {
  items: Record<string, ItemAgentInfo>;
  /** items with a run in flight (running or waiting), newest first */
  active: ItemAgentInfo[];
};

export const isActive = (i: Pick<ItemAgentInfo, "live">) => i.live === "running" || i.live === "waiting";

/** Active agents within one area (map area card strip). */
export function activeInArea(r: AgentRunsResponse | undefined, areaId: string): ItemAgentInfo[] {
  return (r?.active ?? []).filter((i) => i.areaId === areaId);
}

export const progressPct = (p: ItemAgentInfo["progress"]) => (p && p.total ? Math.round((p.done / p.total) * 100) : null);

export function whoLabel(w: Who | null): string {
  if (!w) return "Nobody assigned";
  if (w.kind === "coordinator") return `@${w.name} (coordinator)`;
  return w.kind === "agent" ? `@${w.name}` : w.name;
}
