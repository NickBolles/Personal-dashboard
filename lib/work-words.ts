/**
 * The one vocabulary for the state of a decision, a run or an item, on every surface (chat, Activity, Needs you,
 * item and project pages, push text). Five words, no synonyms. Pure and client-safe.
 *
 * - Needs you: paused on the owner's answer. Always names what it waits for (a D-n when there is one).
 * - Working: reported in the last 30 minutes.
 * - Stalled: no report for 30 minutes, or interrupted and waiting to be resumed.
 * - Failed: stopped with an error.
 * - Done: finished. "Stopped" (cancelled by the owner) reads as its own word but sits with Done.
 */
export type WorkState = "needs" | "working" | "stalled" | "failed" | "done" | "stopped";

export const WORK_WORD: Record<WorkState, string> = {
  needs: "Needs you",
  working: "Working",
  stalled: "Stalled",
  failed: "Failed",
  done: "Done",
  stopped: "Stopped",
};

/** The three groups every list uses, in this order. */
export type WorkGroup = "needs" | "working" | "done";
export const WORK_GROUPS: readonly WorkGroup[] = ["needs", "working", "done"];
export const WORK_GROUP_LABEL: Record<WorkGroup, string> = { needs: "Needs you", working: "Working", done: "Done" };

/** Failed and stalled work is the owner's to look at, so it sits under Needs you, after the open questions. */
export const WORK_GROUP: Record<WorkState, WorkGroup> = {
  needs: "needs",
  failed: "needs",
  stalled: "needs",
  working: "working",
  done: "done",
  stopped: "done",
};

/** Order inside a list: what the owner must answer, what broke, what went silent, what is moving, what ended. */
export const WORK_RANK: Record<WorkState, number> = { needs: 0, failed: 1, stalled: 2, working: 3, done: 4, stopped: 5 };

export const workWord = (state: WorkState) => WORK_WORD[state];
export const workGroup = (state: WorkState) => WORK_GROUP[state];

/** A tracked run's status key (lib/coordinator/run-card.ts runStatus) in the shared vocabulary. */
export function workStateOfRun(key: "failed" | "interrupted" | "waiting" | "done" | "stuck" | "working"): WorkState {
  if (key === "waiting") return "needs";
  if (key === "stuck" || key === "interrupted") return "stalled";
  return key;
}

/** A background-work record's state (lib/chat-execution.ts); `stalled` is the 30-minute silence rule applied to it. */
export function workStateOfExec(state: "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown", stalled = false): WorkState {
  if (state === "waiting") return "needs";
  if (state === "failed") return "failed";
  if (state === "completed") return "done";
  if (state === "cancelled") return "stopped";
  return stalled ? "stalled" : "working";
}

/** An item's live agent state (lib/agent-runs.ts RunLive plus the stalled flag); null when nothing has run. */
export function workStateOfLive(live: "running" | "waiting" | "failed" | "finished" | "idle", stalled = false): WorkState | null {
  if (live === "idle") return null;
  if (live === "waiting") return "needs";
  if (live === "failed") return "failed";
  if (live === "finished") return "done";
  return stalled ? "stalled" : "working";
}
