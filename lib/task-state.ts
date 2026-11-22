/**
 * The one state of a task (task threads, step 3; docs/work.md "Task state"). Every list and page that says how a
 * task is doing asks this rule, so two screens can never disagree. Pure and client-safe.
 *
 * Seven states, in the order a list shows them:
 * - Needs you: an open question, an approval, or a run that paused on the owner.
 * - Failed: the newest piece of agent work on it stopped with an error.
 * - Stalled: agent work is open but silent, the run and its chat both (or it was stopped). Says what would move
 *   it, else "no word since".
 * - Working: agent work reported, or its chat was active, inside the threshold.
 * - Ready for review: the work came back (a finished run, or a run whose chat ended), or the task's own status
 *   says it waits for a look.
 * - Not started: nothing has worked on it.
 * - Done: closed.
 *
 * A finished run never makes a task Done: only the owner closing it does.
 */
import type { AgentRunState } from "@/lib/agent-runs";
import { isClosed, type WorkStatus } from "@/lib/work";
import type { WorkState } from "@/lib/work-words";

export const TASK_STATES = ["needs", "failed", "stalled", "working", "review", "idle", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_WORD: Record<TaskState, string> = {
  needs: "Needs you",
  failed: "Failed",
  stalled: "Stalled",
  working: "Working",
  review: "Ready for review",
  idle: "Not started",
  done: "Done",
};

/** Order inside a channel: Needs you, Failed, Stalled, Working, then the rest. */
export const TASK_RANK: Record<TaskState, number> = { needs: 0, failed: 1, stalled: 2, working: 3, review: 4, idle: 5, done: 6 };

/** In flight holds exactly these. */
export const IN_FLIGHT_STATES: readonly TaskState[] = ["needs", "failed", "stalled", "working"];
export const isInFlight = (state: TaskState) => IN_FLIGHT_STATES.includes(state);

/** Statuses that mean "the work is back, look at it": the review queue. */
export const REVIEW_STATUSES: readonly WorkStatus[] = ["in_review", "awaiting_validation", "ready_to_settle"];

/** The mark a row draws for a task state (the shared row knows the work states plus "idle"). */
export const TASK_MARK: Record<TaskState, WorkState | "idle"> = {
  needs: "needs",
  failed: "failed",
  stalled: "stalled",
  working: "working",
  review: "done",
  idle: "idle",
  done: "done",
};

/** One top-level piece of agent work on the task (a registered run), as the rule needs it. */
export type TaskRunFact = {
  state: AgentRunState;
  /** Running, with no report inside the threshold. */
  stalled: boolean;
  startedAt: string;
  updatedAt: string;
  /** What it last summarised: its ask while waiting, its error when failed, its result when done. */
  summary?: string | null;
  /** What it says it is waiting for (a lock it does not hold), when it said so. */
  waitsFor?: string | null;
  /** Interrupted because its chat ended: the agent is gone, so what it left is ready for a look. */
  chatEnded?: boolean;
};

export type TaskFacts = {
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  nextAction?: string | null;
  /** Open questions on the task, the one to answer first at the head. */
  questions?: readonly { question: string; askedAt: string }[];
  /** A chat run on the task is paused on an approval. */
  approvalAt?: string | null;
  /** A turn is in flight in the task's chat right now (a message you or a bot sent there), since when. */
  chatRunningAt?: string | null;
  /** Registered runs on the task, top level only. Any order. */
  runs?: readonly TaskRunFact[];
};

export type TaskStatus = {
  state: TaskState;
  /** When it got into this state (what its age counts from). */
  since: string | null;
  /** Stalled: what would move it. Not started: where it stands ("captured", "on hold"). Null otherwise. */
  cause: string | null;
  /** The one line under the title when there is no newer activity: the question, the error, the result, the next step. */
  line: string | null;
};

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
const newest = (a: TaskRunFact, b: TaskRunFact) => b.startedAt.localeCompare(a.startedAt) || b.updatedAt.localeCompare(a.updatedAt);

const IDLE_CAUSE: Partial<Record<WorkStatus, string>> = {
  captured: "captured",
  exploring: "exploring",
  ready: "ready",
  in_progress: "in progress, no agent on it",
  reopened: "reopened",
  on_hold: "on hold",
};
const REVIEW_LINE: Partial<Record<WorkStatus, string>> = {
  in_review: "In review",
  awaiting_validation: "Waiting for you to validate it",
  ready_to_settle: "Merged, ready to close",
};

export function taskState(f: TaskFacts): TaskStatus {
  if (isClosed(f.status)) return { state: "done", since: f.completedAt ?? f.updatedAt, cause: null, line: null };

  const runs = [...(f.runs ?? [])].sort(newest);
  const question = f.questions?.[0];
  if (question) return { state: "needs", since: question.askedAt, cause: null, line: flat(question.question) };
  const waiting = runs.find((r) => r.state === "waiting");
  if (waiting) return { state: "needs", since: waiting.updatedAt, cause: null, line: flat(waiting.summary) || "Waiting for your reply" };
  if (f.approvalAt) return { state: "needs", since: f.approvalAt, cause: null, line: "Waiting for your approval" };

  // The newest attempt decides a failure: an older failed run that was retried is history.
  const latest = runs[0];
  if (latest?.state === "failed") return { state: "failed", since: latest.updatedAt, cause: null, line: flat(latest.summary) || "It stopped with an error" };

  // A run whose chat ended is not coming back by itself: its task is ready for review, never Working or Stalled.
  const live = runs.filter((r) => !(r.state === "interrupted" && r.chatEnded));
  const ended = runs.find((r) => r.state === "interrupted" && r.chatEnded);
  // A turn in flight in the task's chat is activity too: a run that reports little is not stalled while it lasts.
  const silent = live.find((r) => r.state === "interrupted" || (r.state === "running" && r.stalled && !f.chatRunningAt));
  if (silent) {
    const stopped = silent.state === "interrupted" && /^stopped/i.test(flat(silent.summary));
    const cause = flat(silent.waitsFor)
      ? `needs ${flat(silent.waitsFor)}`
      : stopped
        ? "stopped by you"
        : silent.state === "interrupted"
          ? "interrupted, waiting to be resumed"
          : null;
    return { state: "stalled", since: silent.updatedAt, cause, line: flat(silent.summary) || null };
  }
  const running = live.find((r) => r.state === "running");
  if (running) return { state: "working", since: running.startedAt, cause: null, line: flat(running.summary) || null };
  // No registered run, but the agent is answering in the task's chat right now.
  if (f.chatRunningAt) return { state: "working", since: f.chatRunningAt, cause: null, line: null };

  if (ended && !f.chatRunningAt)
    return {
      state: "review",
      since: ended.updatedAt,
      cause: null,
      line: flat(ended.summary) && !/^session ended/i.test(flat(ended.summary)) ? flat(ended.summary) : "Its chat ended",
    };
  if (latest?.state === "done") return { state: "review", since: latest.updatedAt, cause: null, line: flat(latest.summary) || REVIEW_LINE[f.status] || null };
  if (REVIEW_STATUSES.includes(f.status)) return { state: "review", since: f.updatedAt, cause: null, line: REVIEW_LINE[f.status] ?? null };

  return { state: "idle", since: f.status === "captured" ? f.createdAt : f.updatedAt, cause: IDLE_CAUSE[f.status] ?? null, line: flat(f.nextAction) || null };
}

const MINUTE = 60_000;
/** "6m", "2h", "11d": how long, in the short form a row uses. */
export function shortAge(since: string | null, now: number): string {
  const ms = since ? now - Date.parse(since) : NaN;
  if (!Number.isFinite(ms)) return "";
  if (ms < MINUTE) return "now";
  if (ms < 60 * MINUTE) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < 24 * 60 * MINUTE) return `${Math.floor(ms / (60 * MINUTE))}h`;
  return `${Math.floor(ms / (24 * 60 * MINUTE))}d`;
}

/** "12:07" for today, "14 Nov" before that. */
export function shortWhen(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "";
  const then = new Date(t);
  const today = new Date(now);
  const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
  return sameDay
    ? then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : then.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * What follows the state word on a row's first line: the reason (D2), then who has it.
 * Working and Done need no reason; Stalled always has one ("needs Gmail connected", else "no word since 14 Nov").
 */
export function taskDetail(status: TaskStatus, who: string | null, now: number): string[] {
  const age = shortAge(status.since, now);
  const parts: string[] = [];
  if (status.state === "stalled") parts.push(status.cause ?? `no word since ${shortWhen(status.since, now)}`);
  else if (status.state === "idle")
    parts.push(status.cause === "captured" && age ? (age === "now" ? "captured just now" : `captured ${age} ago`) : (status.cause ?? age));
  else if (status.state === "done") parts.push(shortWhen(status.since, now));
  else if (age) parts.push(age);
  if (who && status.state !== "done" && status.state !== "idle") parts.push(who);
  return parts.filter(Boolean);
}
