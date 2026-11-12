/**
 * What a run card says: its status in words, a tone and label per event type (the same tones the item
 * pages use for PR / checks / deploy pills), and the "since you last looked" breakdown. Pure and client-safe.
 */
import type { RunEvent, RunEventType } from "@/lib/cw-runs";
import { relativeTime } from "@/lib/time";
import { ageLabel } from "./needs";
import type { CoordinatorRunRow } from "./runs-view";

export type CardTone = "ok" | "wn" | "bad" | "ai" | "inf" | "ac" | "neutral";

export type RunStatus = {
  key: "failed" | "interrupted" | "waiting" | "done" | "stuck" | "working";
  /** One or two words: the chip. */
  label: string;
  /** How long, in words, next to the chip. */
  detail: string;
  tone: CardTone;
  /** Still reporting: the dot pulses. */
  live: boolean;
  /** Something the owner may have to act on: the card opens itself. */
  attention: boolean;
};

export function runStatus(run: CoordinatorRunRow, now: number = Date.now()): RunStatus {
  const ago = relativeTime(run.updatedAt, now);
  if (run.state === "failed") return { key: "failed", label: "Failed", detail: ago, tone: "bad", live: false, attention: true };
  if (run.state === "interrupted")
    return {
      key: "interrupted",
      label: "Interrupted",
      detail: relativeTime(run.interruptedAt ?? run.updatedAt, now),
      tone: "wn",
      live: false,
      attention: true,
    };
  if (run.state === "waiting") return { key: "waiting", label: "Waiting on you", detail: `since ${ago}`, tone: "wn", live: false, attention: true };
  if (run.state === "done")
    return { key: "done", label: "Done", detail: relativeTime(run.finishedAt ?? run.updatedAt, now), tone: "ok", live: false, attention: false };
  // A quiet run is not a failed run: say what is known (how long since it last reported), in amber, not red.
  if (run.stalled) return { key: "stuck", label: "Stuck", detail: `no update for ${ageLabel(run.updatedAt, now)}`, tone: "wn", live: false, attention: true };
  return { key: "working", label: "Working", detail: `updated ${ago}`, tone: "ai", live: true, attention: false };
}

const CHIP: Record<RunEventType, { label: string; tone: CardTone }> = {
  started: { label: "Started", tone: "neutral" },
  progress: { label: "Progress", tone: "ai" },
  notice: { label: "Notice", tone: "inf" },
  ci: { label: "CI", tone: "inf" },
  "lock.acquired": { label: "Lock", tone: "wn" },
  "lock.released": { label: "Unlocked", tone: "neutral" },
  "release.staged": { label: "Staged", tone: "ac" },
  "release.live": { label: "Live", tone: "ok" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  interrupted: { label: "Interrupted", tone: "wn" },
  resumed: { label: "Resumed", tone: "ai" },
};
const OUTCOME: Record<string, CardTone> = { ok: "ok", success: "ok", passed: "ok", failed: "bad", failure: "bad", error: "bad", running: "ai", pending: "wn" };

/** A CI event is green or red when it says so (its pipeline chip, a state field, or plain words); otherwise neutral. */
function ciTone(event: Pick<RunEvent, "summary" | "payload">): CardTone {
  const pipeline = Array.isArray(event.payload?.pipeline) ? (event.payload.pipeline as { stage?: unknown; state?: unknown }[]) : [];
  const stage = pipeline.find((p) => p?.stage === "ci");
  const stated = [stage?.state, event.payload?.state, event.payload?.status, event.payload?.conclusion].find((v): v is string => typeof v === "string");
  const known = stated ? OUTCOME[stated.toLowerCase()] : undefined;
  if (known) return known;
  if (/\b(fail(ed|ing|ure|s)?|broken|red)\b/i.test(event.summary)) return "bad";
  if (/\b(pass(ed|ing|es)?|green|succeeded)\b/i.test(event.summary)) return "ok";
  return "inf";
}
export function eventChip(event: Pick<RunEvent, "type" | "summary" | "payload">): { label: string; tone: CardTone } {
  const chip = CHIP[event.type] ?? { label: event.type, tone: "neutral" as const };
  return event.type === "ci" ? { ...chip, tone: ciTone(event) } : chip;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The event's own words, or nothing when it only repeats the run's title (a "started" event usually does). */
export function eventText(event: Pick<RunEvent, "summary">, runTitle: string): string {
  const summary = event.summary.replace(/\s+/g, " ").trim();
  return flat(summary) === flat(runTitle) ? "" : summary;
}

/** Newest first, one row per event id. */
export function timelineOf(...lists: (readonly RunEvent[] | undefined)[]): RunEvent[] {
  const seen = new Map<string, RunEvent>();
  for (const list of lists) for (const event of list ?? []) seen.set(event.id, event);
  return [...seen.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

/** "9:51 AM" today, "Mon 9:51 AM" this week, "Nov 3" before that. */
export function eventClock(at: string, now: number = Date.now()): string {
  const then = new Date(at);
  if (!Number.isFinite(then.getTime())) return "";
  const time = then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (then.toDateString() === new Date(now).toDateString()) return time;
  if (now - then.getTime() < 6 * 86_400_000) return `${then.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type SinceCounts = { decisions: number; runs: number; failed?: number; stuck?: number; waiting?: number; finished?: number };
export type SinceChip = { key: "failed" | "decisions" | "waiting" | "stuck" | "finished" | "runs"; label: string; tone: CardTone; tab: "needs" | "running" };
const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** What changed while the owner was away, worst first; each chip jumps to where it lives. */
export function sinceChips(counts: SinceCounts): SinceChip[] {
  const chips: SinceChip[] = [];
  const { failed = 0, stuck = 0, waiting = 0, finished = 0 } = counts;
  if (failed) chips.push({ key: "failed", label: `${failed} failed`, tone: "bad", tab: "running" });
  if (counts.decisions) chips.push({ key: "decisions", label: count(counts.decisions, "new decision", "new decisions"), tone: "wn", tab: "needs" });
  if (waiting) chips.push({ key: "waiting", label: `${waiting} waiting on you`, tone: "wn", tab: "running" });
  if (stuck) chips.push({ key: "stuck", label: `${stuck} stuck`, tone: "wn", tab: "running" });
  if (finished) chips.push({ key: "finished", label: `${finished} finished`, tone: "ok", tab: "running" });
  const rest = Math.max(0, counts.runs - failed - stuck - waiting - finished);
  if (rest) chips.push({ key: "runs", label: count(rest, "run updated", "runs updated"), tone: "ai", tab: "running" });
  return chips;
}

/** The run half of the breakdown: what each top-level run that moved since `sinceAt` is doing now. */
export function sinceRunCounts(runs: readonly CoordinatorRunRow[], sinceAt: number): Omit<SinceCounts, "decisions"> {
  const moved = runs.filter((r) => Date.parse(r.updatedAt) > sinceAt);
  const failed = moved.filter((r) => r.state === "failed").length;
  const waiting = moved.filter((r) => r.state === "waiting").length;
  const finished = moved.filter((r) => r.state === "done").length;
  const stuck = moved.filter((r) => r.stalled && r.state === "running").length;
  return { runs: moved.length, failed, stuck, waiting, finished };
}
