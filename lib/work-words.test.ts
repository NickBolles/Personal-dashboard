import { expect, it } from "vitest";
import { WORK_GROUP, WORK_GROUPS, WORK_RANK, WORK_WORD, workStateOfExec, workStateOfLive, workStateOfRun, type WorkState } from "./work-words";

const STATES: WorkState[] = ["needs", "working", "stalled", "failed", "done", "stopped"];

it("there are five state words plus Stopped, and none repeats", () => {
  const words = STATES.map((s) => WORK_WORD[s]);
  expect(words).toEqual(["Needs you", "Working", "Stalled", "Failed", "Done", "Stopped"]);
  expect(new Set(words).size).toBe(words.length);
});

it("lists run Needs you, Working, Done; failed and stalled work sits under Needs you", () => {
  expect(WORK_GROUPS).toEqual(["needs", "working", "done"]);
  expect(STATES.map((s) => WORK_GROUP[s])).toEqual(["needs", "working", "needs", "needs", "done", "done"]);
  const ranked = [...STATES].sort((a, b) => WORK_RANK[a] - WORK_RANK[b]);
  expect(ranked).toEqual(["needs", "failed", "stalled", "working", "done", "stopped"]);
  // the rank never puts a later group ahead of an earlier one
  expect(ranked.map((s) => WORK_GROUPS.indexOf(WORK_GROUP[s]))).toEqual([0, 0, 0, 1, 2, 2]);
});

it("every source's states land on the shared words", () => {
  expect((["failed", "interrupted", "waiting", "done", "stuck", "working"] as const).map(workStateOfRun)).toEqual([
    "failed",
    "stalled",
    "needs",
    "done",
    "stalled",
    "working",
  ]);
  expect((["running", "waiting", "completed", "failed", "cancelled", "unknown"] as const).map((s) => workStateOfExec(s))).toEqual([
    "working",
    "needs",
    "done",
    "failed",
    "stopped",
    "working",
  ]);
  expect(workStateOfExec("running", true)).toBe("stalled");
  // only work that is still going can stall
  expect(workStateOfExec("completed", true)).toBe("done");
  expect((["running", "waiting", "failed", "finished", "idle"] as const).map((s) => workStateOfLive(s))).toEqual(["working", "needs", "failed", "done", null]);
  expect(workStateOfLive("running", true)).toBe("stalled");
});
