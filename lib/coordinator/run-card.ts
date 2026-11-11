/**
 * What a run card says: its status in words, a tone and label per event type (the same tones the item
 * pages use for PR / checks / deploy pills), and the "since you last looked" breakdown. Pure and client-safe.
 */
import type { ExecutionRecord } from "@/lib/chat-execution";
import type { Decision } from "@/lib/cw-decisions";
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
  const ago = now - Date.parse(run.updatedAt) < 60_000 ? "just now" : relativeTime(run.updatedAt, now);
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
  if (run.state === "waiting")
    return { key: "waiting", label: "Waiting on you", detail: `for ${ageLabel(run.updatedAt, now)}`, tone: "wn", live: false, attention: true };
  if (run.state === "done")
    return { key: "done", label: "Finished", detail: relativeTime(run.finishedAt ?? run.updatedAt, now), tone: "ok", live: false, attention: false };
  // A quiet run is not a failed run: say what is known (how long since it last reported), in amber, not red.
  if (run.stalled) return { key: "stuck", label: "Quiet", detail: `no update for ${ageLabel(run.updatedAt, now)}`, tone: "wn", live: false, attention: true };
  return { key: "working", label: "Working", detail: `updated ${ago}`, tone: "ai", live: true, attention: false };
}

const CHIP: Record<RunEventType, { label: string; tone: CardTone }> = {
  started: { label: "Started", tone: "neutral" },
  progress: { label: "Progress", tone: "ai" },
  notice: { label: "Step done", tone: "inf" },
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
const SAYS_FAILED = /\b(fail(ed|ing|ure|s)?|errors?|timed out|crashed|broken)\b/i;
export function eventChip(event: Pick<RunEvent, "type" | "summary" | "payload">): { label: string; tone: CardTone } {
  const chip = CHIP[event.type] ?? { label: event.type, tone: "neutral" as const };
  if (event.type === "ci") return { ...chip, tone: ciTone(event) };
  // A step or progress report that says it failed is not a calm blue line.
  if ((event.type === "notice" || event.type === "progress") && SAYS_FAILED.test(event.summary))
    return { label: event.type === "notice" ? "Step failed" : chip.label, tone: "bad" };
  return chip;
}

/** What a waiting run needs from the owner: the open decision it raised, when there is one. */
export function runAsk(run: Pick<CoordinatorRunRow, "id">, decisions: readonly Decision[]): Decision | null {
  return decisions.filter((d) => d.state === "open" && d.runId === run.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

/**
 * Agent text as a sentence: "(no summary — status=failed: vendor portal timed out)" is a fallback some sources
 * write when they have nothing else; say what it says.
 */
export function tidyOutcome(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const raw = /^\(?no summary\s*[—–-]\s*status=\w+:?\s*(.*?)\)?$/i.exec(flat);
  const said = raw ? raw[1]!.trim() : flat;
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : "";
}

/** "Synced just now" / "Synced 3 minutes ago"; when a refresh fails, when the data on screen was last good. */
export function syncLine(updatedAt: number, failed: boolean, now: number = Date.now()): string {
  const fresh = now - updatedAt < 60_000;
  const age = !updatedAt ? "" : fresh ? "just now" : relativeTime(updatedAt, now);
  if (!failed) return age ? `Synced ${age}` : "";
  if (!updatedAt) return "Couldn't refresh";
  // Short enough to keep Retry on the same line on a phone; the exact time is in the line's tooltip.
  return `Couldn't refresh · last synced ${age}`;
}

/**
 * What a waiting run needs from the owner, in the best words available: the open decision it raised, else what
 * the agent last summarised (a waiting run's summary is normally its ask).
 */
export function runNeeds(
  run: Pick<CoordinatorRunRow, "id" | "state" | "summary" | "title">,
  decisions: readonly Decision[],
): { text: string; decision: Decision | null } | null {
  if (run.state !== "waiting") return null;
  const decision = runAsk(run, decisions);
  const text = decision ? decision.question : tidyOutcome(run.summary);
  return text && text.toLowerCase() !== run.title.trim().toLowerCase() ? { text, decision } : null;
}

/**
 * Runs that need a look, most in need first: one that failed, then one whose last report says a step failed,
 * then the rest by how recently they went quiet. Silence alone never outranks a reported failure.
 */
export function byNeed(runs: readonly CoordinatorRunRow[], events: readonly RunEvent[]): CoordinatorRunRow[] {
  const latest = new Map<string, RunEvent>();
  for (const event of events) {
    const prior = latest.get(event.runId);
    if (!prior || Date.parse(event.at) >= Date.parse(prior.at)) latest.set(event.runId, event);
  }
  const rank = (run: CoordinatorRunRow) => {
    if (run.state === "failed") return 0;
    const last = latest.get(run.id) ?? run.lastEvent;
    return last && eventChip(last).tone === "bad" ? 1 : 2;
  };
  return [...runs].sort((x, y) => rank(x) - rank(y) || Date.parse(y.updatedAt) - Date.parse(x.updatedAt) || y.seq - x.seq);
}

export type BackgroundWork = {
  record: ExecutionRecord;
  /** The tracked run (R-n) this work is, when it is one: its state and timeline are the authority. */
  run?: CoordinatorRunRow;
  /** The sub-agent record that can take Steer / Stop for this work. */
  control?: ExecutionRecord;
};
const workTitle = (title: string) =>
  title
    .replace(/^Subagent:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const informative = (r: ExecutionRecord) => (r.state === "unknown" ? 0 : 2) + (r.error || r.summary || r.step ? 1 : 0);
/**
 * One card per piece of work. A conversation's background work arrives from several sources (the sub-agent
 * itself, its run registration, the R-n run), and they describe the same thing with different freshness:
 * records that are the same tracked run, or share a title while one of them has no status, are one card.
 * Two sub-agents that merely share a title and each report a real state stay separate.
 */
export function mergeBackgroundWork(records: readonly ExecutionRecord[], runs: readonly CoordinatorRunRow[]): BackgroundWork[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const byTitle = new Map<string, CoordinatorRunRow>();
  for (const run of [...runs].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))) byTitle.set(workTitle(run.title), run);
  const out: (BackgroundWork & { title: string })[] = [];
  for (const record of records) {
    const title = workTitle(record.title);
    const run = (record.source === "subagent" ? undefined : byId.get(record.id)) ?? byTitle.get(title);
    const control = record.source === "subagent" ? record : undefined;
    const same = out.find(
      (w) => (run && w.run?.id === run.id) || (!run && !w.run && w.title === title && (w.record.state === "unknown" || record.state === "unknown")),
    );
    if (!same) {
      out.push({ record, run, control, title });
      continue;
    }
    if (informative(record) > informative(same.record)) same.record = record;
    same.control ??= control;
  }
  return out.map(({ title: _title, ...work }) => work);
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
  if (counts.decisions) chips.push({ key: "decisions", label: count(counts.decisions, "new decision", "new decisions"), tone: "ac", tab: "needs" });
  if (waiting) chips.push({ key: "waiting", label: `${waiting} waiting on you`, tone: "wn", tab: "running" });
  if (stuck) chips.push({ key: "stuck", label: `${stuck} went quiet`, tone: "wn", tab: "running" });
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

export type PulseTick = { id: string; at: number; tone: CardTone };
/**
 * A run's reports laid out in time, from its start to now (or to when it finished): each tick is one event at
 * its place (0..1) in that span. The spacing is the story: a steady run has even ticks to the right edge, a run
 * that went quiet has a gap after its last one.
 */
export function runPulse(run: Pick<CoordinatorRunRow, "startedAt" | "finishedAt">, events: readonly RunEvent[], now: number = Date.now()): PulseTick[] {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return [...events]
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-24)
    .map((e) => ({ id: e.id, at: Math.min(1, Math.max(0, (Date.parse(e.at) - start) / (end - start))), tone: eventChip(e).tone }));
}
