import type { ActivityItem } from "@/lib/activity";
import type { DecisionEntry } from "@/lib/decisions";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";
import type { ExternalRun } from "@/lib/agent-runs";

/** A failed run stops counting as "needs attention" after this long, or once a later run on the item finished. */
export const FAILED_ATTENTION_MS = 3 * 24 * 3_600_000;

export function failureStillCounts(run: ExternalRun, siblings: readonly ExternalRun[], now: number) {
  const at = Date.parse(run.updatedAt);
  if (now && Number.isFinite(at) && now - at > FAILED_ATTENTION_MS) return false;
  return !siblings.some((o) => o.id !== run.id && o.state === "done" && o.updatedAt > run.updatedAt);
}

export type CoordinatorRun = { id: string; itemId: string; title: string; state: "running" | "stalled" | "failed" | "waiting"; at: string | null };

/**
 * Mutations carry `via` (raw `agent:<p>` or normalized `<p>`) and it decides; coordinator run
 * start/finish rows carry no `via`, so they count by exact agent actor identity (#201).
 */
export function isCoordinatorChange(row: Pick<ActivityItem, "actor" | "via" | "at">, now: number, profile = "chiefofstaff") {
  const attributed = row.via ? row.via === profile || row.via === `agent:${profile}` : row.actor.kind === "agent" && row.actor.name === profile;
  return attributed && Date.parse(row.at) >= now - 86_400_000;
}
export type CoordinatorThings = {
  needsYou: number;
  decisions: DecisionEntry[];
  running: CoordinatorRun[];
  failing: CoordinatorRun[];
  doneUnseen: number;
  changes: ActivityItem[];
};
export type PriorityInput = Pick<CoordinatorThings, "needsYou" | "doneUnseen"> & { running: number; failing: number };
export type PriorityLine = {
  state: "failing" | "needs" | "running" | "done" | "idle";
  tone: "bad" | "warn" | "ai" | "ok" | "neutral";
  dot: "red" | "yellow" | null;
  text: string;
  count: number;
};
const ranks: Record<PriorityLine["state"], number> = { failing: 4, needs: 3, done: 2, running: 1, idle: 0 };
export function priorityLine(input: PriorityInput): PriorityLine {
  if (input.failing > 0)
    return {
      state: "failing",
      tone: "bad",
      dot: "red",
      text: `${input.failing} ${input.failing === 1 ? "run needs" : "runs need"} attention`,
      count: input.failing,
    };
  if (input.needsYou > 0)
    return {
      state: "needs",
      tone: "warn",
      dot: "yellow",
      text: `${input.needsYou} ${input.needsYou === 1 ? "thing needs" : "things need"} you`,
      count: input.needsYou,
    };
  if (input.doneUnseen > 0) return { state: "done", tone: "ok", dot: "yellow", text: `${input.doneUnseen} done · ready to review`, count: input.doneUnseen };
  if (input.running > 0)
    return { state: "running", tone: "ai", dot: null, text: `${input.running} ${input.running === 1 ? "run" : "runs"} in progress`, count: input.running };
  return { state: "idle", tone: "neutral", dot: null, text: "Nothing running · ask anything", count: 0 };
}

/** sinceMs is when the pending downward transition was first observed. */
export function stablePriority(prev: PriorityLine, next: PriorityLine, sinceMs: number, now: number): PriorityLine {
  return ranks[next.state] < ranks[prev.state] && now - sinceMs < 4000 ? prev : next;
}

/** The server ranks cards. Failing and Needs you are never displaced. */
export function pickTrayLine(
  priority: PriorityLine,
  dynamicCards: (DynamicCard & { snoozed?: boolean })[],
  snoozed: readonly string[] = [],
): PriorityLine & { card?: DynamicCard } {
  if (priority.state === "failing" || priority.state === "needs") return priority;
  const card = dynamicCards.find((c) => !c.snoozed && !snoozed.includes(c.id));
  return card ? { ...priority, ...card.line, text: `${card.line.label} · ${card.line.text}`, card } : priority;
}
