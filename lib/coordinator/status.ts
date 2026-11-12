import { STALL_AFTER_MIN } from "@/lib/agent-runs";
import type { CoordinatorRunRow } from "./runs-view";
import { FAILED_ATTENTION_MS, type CoordinatorRun } from "./things";

/**
 * One honest status for the Chief of staff tray, rail strip and tab badges.
 *
 * "Stuck" (failed / stalled / waiting / interrupted) is split by whether the owner has seen it:
 * a run that got stuck after the owner last opened Activity is NEW and turns the tray red; one they
 * have already looked at stays counted ("3 need a look") but no longer shouts. Failures older than
 * FAILED_ATTENTION_MS are history: still listed under Activity → Older, never counted here.
 */
export type StuckKind = "failed" | "stalled" | "waiting" | "interrupted";
export type StuckRun = { ref: string | null; title: string; kind: StuckKind; at: number; fresh: boolean; old: boolean };

const stuckKindOf = (run: Pick<CoordinatorRunRow, "state" | "stalled">): StuckKind | null =>
  run.state === "failed"
    ? "failed"
    : run.state === "interrupted"
      ? "interrupted"
      : run.state === "waiting"
        ? "waiting"
        : run.state === "running" && run.stalled
          ? "stalled"
          : null;

/** When the run started needing attention: a stall begins STALL_AFTER_MIN after its last report. */
function attentionAt(kind: StuckKind, updatedAt: string | null): number {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(t)) return NaN;
  return kind === "stalled" ? t + STALL_AFTER_MIN * 60_000 : t;
}

export function isOldFailure(run: Pick<CoordinatorRunRow, "state" | "updatedAt">, now: number): boolean {
  const t = Date.parse(run.updatedAt);
  return run.state === "failed" && Number.isFinite(t) && now - t > FAILED_ATTENTION_MS;
}

export type StatusInput = {
  /** Everything Today counts under "Needs you": open decisions, approvals/proposals and stalled runs. */
  needs: number;
  /** The single most urgent open question, when there is one to name. */
  topQuestion?: string | null;
  topRef?: string | null;
  /** R-n runs (top-level and sub-runs; sub-runs are ignored here). */
  runs: readonly CoordinatorRunRow[];
  /** Hermes job runs and failing PR checks that have no R-n row. */
  otherRuns?: readonly CoordinatorRun[];
  /** Finished work the owner has not looked at yet. */
  finished?: number;
  /** ISO time the owner last opened Activity (null = never). */
  lastLooked: string | null | undefined;
  now: number;
};

export type StatusCounts = { needs: number; working: number; stuck: number; newStuck: number; waiting: number; finished: number };
export type CoordinatorStatus = {
  state: "failed" | "needs" | "working" | "stuck" | "finished" | "quiet";
  tone: "bad" | "warn" | "ai" | "ok" | "neutral";
  dot: "red" | "yellow" | null;
  /** The headline: the one thing to know. */
  text: string;
  /** Everything else that is non-zero, e.g. "2 working · 3 need a look". Empty when there is nothing else. */
  rest: string;
  target: { tab: "needs" | "running" | "chat"; ref?: string };
  counts: StatusCounts;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const short = (text: string, max = 64) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const VERB: Record<StuckKind, string> = { failed: "failed", stalled: "went quiet", waiting: "is waiting", interrupted: "was interrupted" };

export function stuckRuns(input: Pick<StatusInput, "runs" | "otherRuns" | "lastLooked" | "now">): StuckRun[] {
  const looked = input.lastLooked ? Date.parse(input.lastLooked) : NaN;
  // Never looked: only the last day is news (the first visit shouldn't open on a wall of red).
  const since = Number.isFinite(looked) ? looked : input.now - 86_400_000;
  const rows: StuckRun[] = [];
  for (const run of input.runs) {
    if (run.parentRunId) continue;
    const kind = stuckKindOf(run);
    if (!kind) continue;
    const at = attentionAt(kind, run.updatedAt);
    rows.push({ ref: run.ref, title: run.title, kind, at, fresh: Number.isFinite(at) && at > since, old: isOldFailure(run, input.now) });
  }
  for (const run of input.otherRuns ?? []) {
    if (run.state === "running") continue;
    const at = attentionAt(run.state, run.at);
    rows.push({ ref: null, title: run.title, kind: run.state, at, fresh: Number.isFinite(at) && at > since, old: false });
  }
  return rows.sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0));
}

export function coordinatorStatus(input: StatusInput): CoordinatorStatus {
  const attention = stuckRuns(input).filter((r) => !r.old);
  const stuckAll = attention.filter((r) => r.kind !== "waiting");
  const waiting = attention.length - stuckAll.length;
  const fresh = stuckAll.filter((r) => r.fresh);
  const working =
    input.runs.filter((r) => !r.parentRunId && r.state === "running" && !r.stalled).length +
    (input.otherRuns ?? []).filter((r) => r.state === "running").length;
  const counts: StatusCounts = { needs: input.needs, working, stuck: stuckAll.length, newStuck: fresh.length, waiting, finished: input.finished ?? 0 };
  const parts = {
    needs: counts.needs ? plural(counts.needs, "needs you", "need you") : "",
    working: counts.working ? `${counts.working} working` : "",
    stuck: counts.stuck ? plural(counts.stuck, "needs a look", "need a look") : "",
  };
  const rest = (...keys: (keyof typeof parts)[]) =>
    keys
      .map((k) => parts[k])
      .filter(Boolean)
      .join(" · ");

  if (fresh.length) {
    const first = fresh[0];
    // The same words as the cards: silence is "quiet", only a reported failure is "failed".
    const all = (kind: StuckKind) => fresh.every((r) => r.kind === kind);
    const many = all("failed") ? "runs failed" : all("stalled") ? "runs went quiet" : "runs need a look";
    const text = fresh.length === 1 ? `${short(first.title, 48)} ${VERB[first.kind]}` : `${fresh.length} ${many}`;
    return { state: "failed", tone: "bad", dot: "red", text, rest: rest("needs", "working"), target: { tab: "running", ref: first.ref ?? undefined }, counts };
  }
  if (counts.needs) {
    const text = counts.needs === 1 && input.topQuestion ? `Needs you: ${short(input.topQuestion)}` : parts.needs;
    return {
      state: "needs",
      tone: "warn",
      dot: "yellow",
      text,
      // Seen is not solved: what is still stuck stays in the sentence, quietly.
      rest: rest("working", "stuck"),
      target: { tab: "needs", ref: counts.needs === 1 ? (input.topRef ?? undefined) : undefined },
      counts,
    };
  }
  // A run can wait on the owner without raising a decision (its ask is its summary): it is not counted under
  // "needs", so without this the tray said "No agent work waiting" while Activity showed it waiting.
  if (counts.waiting) {
    const first = attention.find((r) => r.kind === "waiting");
    const text = counts.waiting === 1 && first ? `${short(first.title, 44)} ${VERB.waiting} on you` : `${counts.waiting} runs are waiting on you`;
    return {
      state: "needs",
      tone: "warn",
      dot: "yellow",
      text,
      rest: rest("working", "stuck"),
      target: { tab: "running", ref: counts.waiting === 1 ? (first?.ref ?? undefined) : undefined },
      counts,
    };
  }
  if (counts.finished)
    return {
      state: "finished",
      tone: "ok",
      dot: "yellow",
      text: `${counts.finished} finished · ready to review`,
      rest: rest("working", "stuck"),
      target: { tab: "running" },
      counts,
    };
  if (counts.working) {
    const run = input.runs.find((r) => !r.parentRunId && r.state === "running" && !r.stalled);
    const text = counts.working === 1 && run ? `Working on ${short(run.title, 48)}` : parts.working;
    return {
      state: "working",
      tone: "ai",
      dot: null,
      text,
      rest: rest("stuck"),
      target: { tab: "running", ref: counts.working === 1 ? run?.ref : undefined },
      counts,
    };
  }
  if (counts.stuck)
    return {
      state: "stuck",
      tone: "neutral",
      dot: null,
      text: `${plural(counts.stuck, "run needs", "runs need")} a look`,
      rest: "nothing new since you looked",
      target: { tab: "running" },
      counts,
    };
  // Scoped on purpose: the rest of Today can still have things for the owner.
  return { state: "quiet", tone: "neutral", dot: null, text: "No agent work waiting", rest: "ask anything", target: { tab: "chat" }, counts };
}
