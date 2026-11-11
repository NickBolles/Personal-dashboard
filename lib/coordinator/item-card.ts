/**
 * What an item or project card says: where it sits, the one state that matters now (a decision waiting, a run
 * that failed or went quiet, an agent working, else its own status), what is next and when it is due, progress,
 * and a plain label + tone for each change made to it. Pure and client-safe.
 */
import type { ActivityItem, ActivityType } from "@/lib/activity";
import type { ItemAgentInfo } from "@/lib/agent-runs";
import type { Decision } from "@/lib/cw-decisions";
import { KIND_LABELS, STATUS_LABELS, type WorkItem, type WorkStatus } from "@/lib/work";
import type { CardTone } from "./run-card";
import type { CoordinatorRunRow } from "./runs-view";
import { isOldFailure } from "./status";

const STATUS_CARD_TONE: Record<WorkStatus, CardTone> = {
  captured: "neutral",
  exploring: "neutral",
  ready: "ac",
  in_progress: "ac",
  in_review: "ac",
  awaiting_validation: "wn",
  ready_to_settle: "ac",
  settled: "ok",
  reopened: "bad",
  on_hold: "neutral",
  superseded: "neutral",
  abandoned: "neutral",
};
const CLOSED: readonly WorkStatus[] = ["settled", "superseded", "abandoned"];
const CONTAINERS: readonly WorkItem["kind"][] = ["area", "project"];
const DAY = 86_400_000;

export type ItemHeadline = {
  key: "needs" | "failed" | "waiting" | "stuck" | "working" | "status";
  label: string;
  tone: CardTone;
  live: boolean;
};
export type ItemCardModel = {
  id: string;
  title: string;
  /** "Project", "Thread"… */
  kind: string;
  container: boolean;
  /** Ancestor titles, outermost first. */
  path: string[];
  status: { label: string; tone: CardTone };
  headline: ItemHeadline;
  next: string;
  summary: string;
  due: { label: string; tone: CardTone } | null;
  progress: { done: number; total: number } | null;
  tags: string[];
  updatedAt: string;
  /** Open decisions on this item (or, for a project or area, anywhere under it), oldest first. */
  decisions: Decision[];
  /** Runs on it (or under it) that need a look: failed, waiting, stuck. */
  attention: CoordinatorRunRow[];
  /** Runs on it (or under it) still reporting. */
  working: CoordinatorRunRow[];
};

/** `id` and everything under it. */
export function subtreeIds(items: readonly Pick<WorkItem, "id" | "parentId">[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id]);
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length)
    for (const child of children.get(queue.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  return seen;
}

export function itemPath(items: readonly Pick<WorkItem, "id" | "parentId" | "title">[], item: Pick<WorkItem, "parentId">): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const path: string[] = [];
  const seen = new Set<string>();
  for (let at = item.parentId ? byId.get(item.parentId) : undefined; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    path.unshift(at.title);
  }
  return path;
}

/** "Overdue 3 d" (red), "Due today" (amber), "Due Fri", "Due Nov 22". Nothing once the item is closed. */
export function dueLabel(targetDate: string | null, status: WorkStatus, now: number = Date.now()): ItemCardModel["due"] {
  if (!targetDate || CLOSED.includes(status)) return null;
  const due = new Date(`${targetDate.slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(due.getTime())) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / DAY);
  if (days < 0) return { label: `Overdue ${-days} d`, tone: "bad" };
  if (days === 0) return { label: "Due today", tone: "wn" };
  if (days === 1) return { label: "Due tomorrow", tone: "wn" };
  if (days < 7) return { label: `Due ${due.toLocaleDateString([], { weekday: "short" })}`, tone: "neutral" };
  return { label: `Due ${due.toLocaleDateString([], { month: "short", day: "numeric" })}`, tone: "neutral" };
}

export function itemCardModel(input: {
  item: WorkItem;
  items: readonly WorkItem[];
  agent?: ItemAgentInfo | null;
  runs?: readonly CoordinatorRunRow[];
  decisions?: readonly Decision[];
  now?: number;
}): ItemCardModel {
  const { item, items, agent } = input;
  const now = input.now ?? Date.now();
  const container = CONTAINERS.includes(item.kind);
  const scope = container ? subtreeIds(items, item.id) : new Set([item.id]);
  const decisions = (input.decisions ?? [])
    .filter((d) => d.state === "open" && scope.has(d.itemId))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const runs = (input.runs ?? []).filter((r) => scope.has(r.itemId));
  const attention = runs.filter(
    (r) => (r.state === "failed" && !isOldFailure(r, now)) || r.state === "waiting" || r.state === "interrupted" || (r.stalled && r.state === "running"),
  );
  const working = runs.filter((r) => r.state === "running" && !r.stalled);
  const status = { label: STATUS_LABELS[item.status], tone: STATUS_CARD_TONE[item.status] };
  const failed = attention.some((r) => r.state === "failed");
  const waiting = attention.some((r) => r.state === "waiting") || (agent?.live === "waiting" && !!agent.approval);
  const headline: ItemHeadline = decisions.length
    ? { key: "needs", label: "Needs you", tone: "wn", live: false }
    : failed
      ? { key: "failed", label: "Run failed", tone: "bad", live: false }
      : waiting
        ? { key: "waiting", label: "Waiting on you", tone: "wn", live: false }
        : attention.length
          ? { key: "stuck", label: "Run quiet", tone: "wn", live: false }
          : working.length || agent?.live === "running"
            ? { key: "working", label: "Working", tone: "ai", live: true }
            : { key: "status", ...status, live: false };
  // The server counts a project's direct work; fall back to the same count from the tree.
  const kids = container
    ? items.filter((i) => i.parentId === item.id && !i.archived && !["note", "conversation"].includes(i.kind) && !CONTAINERS.includes(i.kind))
    : [];
  const progress = agent?.progress ?? (kids.length ? { done: kids.filter((k) => CLOSED.includes(k.status)).length, total: kids.length } : null);
  return {
    id: item.id,
    title: item.title,
    kind: KIND_LABELS[item.kind],
    container,
    path: itemPath(items, item),
    status,
    headline,
    next: item.nextAction.trim(),
    summary: item.summary.trim(),
    due: dueLabel(item.targetDate, item.status, now),
    progress,
    tags: item.tags ?? [],
    updatedAt: item.updatedAt,
    decisions,
    attention,
    working,
  };
}

const CHANGE_CHIP: Record<ActivityType, { label: string; tone: CardTone }> = {
  created: { label: "Created", tone: "ok" },
  edit: { label: "Edit", tone: "inf" },
  status: { label: "Status", tone: "ac" },
  structure: { label: "Moved", tone: "neutral" },
  link: { label: "Link", tone: "inf" },
  github: { label: "GitHub", tone: "ac" },
  capture: { label: "Capture", tone: "neutral" },
  chat: { label: "Chat", tone: "ai" },
  validation: { label: "Check", tone: "ok" },
  chore: { label: "Chore", tone: "neutral" },
};
const shortDate = (value: string) => {
  const date = new Date(`${value.trim().slice(0, 10)}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { month: "short", day: "numeric" }) : value.trim();
};
/**
 * "Dates: start — → —, target — → 2026-11-22" → "Target date Nov 22": only what actually changed, as a person
 * would say it, with the previous value when there was one (it is what Undo restores).
 */
function tidyDates(verb: string): string | null {
  const m = /^dates:\s*start\s+(.+?)\s*→\s*(.+?),\s*target\s+(.+?)\s*→\s*(.+)$/i.exec(verb);
  if (!m) return null;
  const part = (name: string, from: string, to: string) => {
    if (from.trim() === to.trim()) return "";
    const was = from.trim() === "—" ? "" : ` (was ${shortDate(from)})`;
    return to.trim() === "—" ? `${name} date cleared${was}` : `${name} date ${shortDate(to)}${was}`;
  };
  const said = [part("start", m[1]!, m[2]!), part("target", m[3]!, m[4]!)].filter(Boolean).join(", ");
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : "Dates unchanged";
}

/** A change in plain words; a decision or an agent run is named for what it is, whatever row type recorded it. */
export function changeLabel(row: Pick<ActivityItem, "type" | "verb">): string {
  if (row.type === "created") return "Created item";
  if (/needs your decision/i.test(row.verb)) return "Raised decision";
  if (/started.*run/i.test(row.verb)) return "Started agent run";
  if (/finished.*run|run.*(done|finished)/i.test(row.verb)) return "Finished agent run";
  return tidyDates(row.verb) ?? row.verb.charAt(0).toUpperCase() + row.verb.slice(1);
}
export function changeChip(row: Pick<ActivityItem, "type" | "verb">): { label: string; tone: CardTone } {
  if (/needs your decision/i.test(row.verb)) return { label: "Decision", tone: "wn" };
  if (/(started|finished).*run|run.*(done|finished)/i.test(row.verb)) return { label: "Run", tone: "ai" };
  if (/^dates:/i.test(row.verb)) return { label: "Dates", tone: "inf" };
  if (/^tagged\b/i.test(row.verb)) return { label: "Tags", tone: "inf" };
  return CHANGE_CHIP[row.type] ?? { label: row.type, tone: "neutral" };
}
/**
 * One change as a short sentence, verb first, the way the item pages write activity: "Edited summary",
 * "Raised decision: Ship tonight?", "Moved to Exploring: predates the new checkout", "Linked Sponsor shortlist".
 */
export function changeText(row: Pick<ActivityItem, "type" | "verb" | "detail">): string {
  const after = /^(?:needs your decision|started agent run|finished agent run):\s*(.+)$/i.exec(row.verb)?.[1]?.trim();
  const label = changeLabel(row);
  if (after) return `${label}: ${after}`;
  if (row.type === "created") return "Created";
  const detail = row.detail?.trim() ?? "";
  if (row.type === "link" && detail) return /^linked\b/i.test(detail) ? detail : `Linked ${detail}`;
  if (row.type === "status") {
    const why = detail.replace(/^[^:]{1,60}→[^:]{1,60}:\s*/, "");
    return why && why !== detail ? `${label}: ${why}` : label;
  }
  return label;
}
