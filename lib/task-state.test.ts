import { describe, expect, it } from "vitest";
import { taskDetail, taskState, shortAge, type TaskFacts, type TaskRunFact } from "./task-state";

const NOW = Date.parse("2026-11-21T14:30:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const base: TaskFacts = { status: "in_progress", createdAt: ago(3 * 24 * 60), updatedAt: ago(60) };
const run = (over: Partial<TaskRunFact>): TaskRunFact => ({ state: "running", stalled: false, startedAt: ago(6), updatedAt: ago(1), ...over });

describe("one state per task", () => {
  it("an open question wins over everything still running, and its text is the reason", () => {
    const s = taskState({ ...base, questions: [{ question: "What is your budget ceiling?", askedAt: ago(120) }], runs: [run({})] });
    expect(s).toMatchObject({ state: "needs", line: "What is your budget ceiling?", since: ago(120) });
    expect(taskDetail(s, "@home", NOW)).toEqual(["2h", "@home"]);
  });

  it("a run paused on the owner needs you, with its own ask; an approval says so", () => {
    expect(taskState({ ...base, runs: [run({ state: "waiting", summary: "Which supplier?" })] })).toMatchObject({ state: "needs", line: "Which supplier?" });
    expect(taskState({ ...base, runs: [run({ state: "waiting" })] }).line).toBe("Waiting for your reply");
    expect(taskState({ ...base, approvalAt: ago(5) })).toMatchObject({ state: "needs", line: "Waiting for your approval" });
  });

  it("the newest attempt decides a failure: a retried failure is history", () => {
    const failed = run({ state: "failed", startedAt: ago(90), updatedAt: ago(60), summary: "Coupon test timed out" });
    expect(taskState({ ...base, runs: [failed] })).toMatchObject({ state: "failed", line: "Coupon test timed out", since: ago(60) });
    expect(taskState({ ...base, runs: [failed, run({ startedAt: ago(5) })] }).state).toBe("working");
    expect(taskState({ ...base, runs: [run({ state: "failed", summary: "" })] }).line).toBe("It stopped with an error");
  });

  it("stalled names what would move it, else says no word since", () => {
    const silent = run({ stalled: true, updatedAt: ago(143) });
    const unknown = taskState({ ...base, runs: [silent] });
    expect(unknown).toMatchObject({ state: "stalled", cause: null, since: ago(143) });
    expect(taskDetail(unknown, "@dev", NOW)[0]).toMatch(/^no word since \d{2}:\d{2}$/);
    const known = taskState({ ...base, runs: [{ ...silent, waitsFor: "Gmail connected" }] });
    expect(taskDetail(known, null, NOW)).toEqual(["needs Gmail connected"]);
    expect(taskState({ ...base, runs: [run({ state: "interrupted" })] }).cause).toBe("interrupted, waiting to be resumed");
    expect(taskState({ ...base, runs: [run({ state: "interrupted", summary: "Stopped by you" })] }).cause).toBe("stopped by you");
    // A silent run is worse news than a sibling that is still reporting.
    expect(taskState({ ...base, runs: [silent, run({})] }).state).toBe("stalled");
    // Days-old silence is dated, not timed.
    expect(taskDetail(taskState({ ...base, runs: [run({ stalled: true, updatedAt: ago(7 * 24 * 60) })] }), null, NOW)[0]).toBe("no word since 14 Nov");
  });

  it("working needs no reason: age and who has it", () => {
    const s = taskState({ ...base, runs: [run({})] });
    expect(s).toMatchObject({ state: "working", cause: null, since: ago(6) });
    expect(taskDetail(s, "@dev", NOW)).toEqual(["6m", "@dev"]);
  });

  it("a turn in flight in the task's chat is working too, but a silent registered run is still the worse news", () => {
    expect(taskState({ ...base, chatRunningAt: ago(2) })).toMatchObject({ state: "working", since: ago(2) });
    expect(taskState({ ...base, chatRunningAt: ago(2), runs: [run({ stalled: true })] }).state).toBe("stalled");
  });

  it("a finished run is ready for review, never done; so is work whose status waits for a look", () => {
    const finished = taskState({ ...base, runs: [run({ state: "done", updatedAt: ago(120), summary: "Lakeside is cheapest" })] });
    expect(finished).toMatchObject({ state: "review", line: "Lakeside is cheapest", since: ago(120) });
    expect(taskDetail(finished, "@dev", NOW)).toEqual(["2h", "@dev"]);
    for (const status of ["in_review", "awaiting_validation", "ready_to_settle"] as const) expect(taskState({ ...base, status }).state).toBe("review");
    expect(taskState({ ...base, status: "ready_to_settle" }).line).toBe("Merged, ready to close");
    // Still being worked on: the run's state wins over the status.
    expect(taskState({ ...base, status: "in_review", runs: [run({})] }).state).toBe("working");
  });

  it("nothing has worked on it: not started, with where it stands and the written next step", () => {
    const captured = taskState({ ...base, status: "captured", nextAction: "Confirm the sale dates" });
    expect(captured).toMatchObject({ state: "idle", cause: "captured", line: "Confirm the sale dates", since: base.createdAt });
    expect(taskDetail(captured, "@dev", NOW)).toEqual(["captured 3d ago"]);
    expect(taskDetail(taskState({ ...base, status: "captured", createdAt: ago(0.2) }), null, NOW)).toEqual(["captured just now"]);
    expect(taskDetail(taskState({ ...base, status: "on_hold" }), null, NOW)).toEqual(["on hold"]);
    expect(taskState(base).cause).toBe("in progress, no agent on it");
  });

  it("only closing a task makes it done", () => {
    for (const status of ["settled", "abandoned", "superseded"] as const) {
      const s = taskState({ ...base, status, completedAt: ago(3 * 24 * 60), questions: [{ question: "Still?", askedAt: ago(1) }], runs: [run({})] });
      expect(s).toMatchObject({ state: "done", line: null });
    }
    expect(taskDetail(taskState({ ...base, status: "settled", completedAt: ago(3 * 24 * 60) }), "@dev", NOW)).toEqual(["18 Nov"]);
  });

  it("ages are short", () => {
    expect([ago(0.5), ago(6), ago(125), ago(11 * 24 * 60)].map((at) => shortAge(at, NOW))).toEqual(["now", "6m", "2h", "11d"]);
    expect(shortAge(null, NOW)).toBe("");
  });
});
