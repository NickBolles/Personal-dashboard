import { describe, expect, it } from "vitest";
import type { CoordinatorRunRow } from "./runs-view";
import { coordinatorStatus, stuckRuns } from "./status";

const now = Date.parse("2026-11-10T15:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
function run(seq: number, overrides: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow {
  return {
    id: `run-${seq}`,
    ref: `R-${seq}`,
    seq,
    itemId: "item",
    itemTitle: "Item",
    profile: "devchief",
    title: `Work ${seq}`,
    state: "running",
    stalled: false,
    summary: null,
    prUrl: null,
    parentRunId: null,
    parentRef: null,
    pipeline: [],
    lock: null,
    interruptedAt: null,
    startedAt: ago(600),
    updatedAt: ago(5),
    finishedAt: null,
    noticeCount: 0,
    ...overrides,
  };
}

describe("coordinatorStatus", () => {
  it("is quiet with nothing going on", () => {
    const s = coordinatorStatus({ needs: 0, runs: [], lastLooked: null, now });
    expect(s).toMatchObject({ state: "quiet", dot: null, text: "No agent work waiting", rest: "ask anything", target: { tab: "chat" } });
  });

  it("a failure the owner has not seen leads, in red, and names the run", () => {
    const s = coordinatorStatus({
      needs: 4,
      runs: [run(7, { state: "failed", title: "Sedge ledger build", updatedAt: ago(10) }), run(8)],
      lastLooked: ago(60),
      now,
    });
    expect(s).toMatchObject({ state: "failed", tone: "bad", dot: "red", text: "Sedge ledger build failed", rest: "4 need you · 1 working" });
    expect(s.target).toEqual({ tab: "running", ref: "R-7" });
    expect(s.counts).toEqual({ needs: 4, working: 1, stuck: 1, newStuck: 1, waiting: 0, finished: 0 });
  });

  it("once the owner has looked, the same failure is counted but no longer shouts", () => {
    const runs = [run(7, { state: "failed", updatedAt: ago(120) }), run(8)];
    const withNeeds = coordinatorStatus({ needs: 4, runs, lastLooked: ago(60), now });
    expect(withNeeds).toMatchObject({ state: "needs", tone: "warn", dot: "yellow", text: "4 need you", rest: "1 working · 1 stuck", target: { tab: "needs" } });
    const alone = coordinatorStatus({ needs: 0, runs: [runs[0]], lastLooked: ago(60), now });
    expect(alone).toMatchObject({ state: "stuck", tone: "neutral", dot: null, text: "1 run is stuck", rest: "nothing new since you looked" });
  });

  it("a stall becomes news 30 minutes after the last report, not at the last report", () => {
    const stalled = run(3, { stalled: true, updatedAt: ago(40) });
    // Looked 20 min ago: the stall began 10 min ago, after the look.
    expect(coordinatorStatus({ needs: 0, runs: [stalled], lastLooked: ago(20), now }).state).toBe("failed");
    // Looked 5 min ago: already stalled then.
    expect(coordinatorStatus({ needs: 0, runs: [stalled], lastLooked: ago(5), now }).state).toBe("stuck");
  });

  it("failures older than three days are history: not counted, never red", () => {
    const old = run(2, { state: "failed", updatedAt: ago(5 * 24 * 60) });
    const s = coordinatorStatus({ needs: 0, runs: [old], lastLooked: null, now });
    expect(s.state).toBe("quiet");
    expect(s.counts.stuck).toBe(0);
    expect(stuckRuns({ runs: [old], lastLooked: null, now })[0]).toMatchObject({ old: true, fresh: false });
  });

  it("with no look marker only the last day is news", () => {
    const s = coordinatorStatus({ needs: 0, runs: [run(1, { state: "failed", updatedAt: ago(30 * 60) })], lastLooked: null, now });
    expect(s).toMatchObject({ state: "stuck", counts: { stuck: 1, newStuck: 0 } });
  });

  it("names the single open question and the single working run", () => {
    expect(coordinatorStatus({ needs: 1, topQuestion: "Rotate the storefront key?", topRef: "D-9", runs: [], lastLooked: null, now })).toMatchObject({
      text: "Needs you: Rotate the storefront key?",
      target: { tab: "needs", ref: "D-9" },
    });
    expect(coordinatorStatus({ needs: 0, runs: [run(5, { title: "Status page fix" })], lastLooked: null, now })).toMatchObject({
      state: "working",
      tone: "ai",
      text: "Working on Status page fix",
      target: { tab: "running", ref: "R-5" },
    });
  });

  it("counts job runs and failing checks without an R-n; sub-runs never count", () => {
    const s = coordinatorStatus({
      needs: 0,
      runs: [run(1), run(2, { parentRunId: "run-1", state: "failed" })],
      otherRuns: [
        { id: "ci:a", itemId: "a", title: "Storefront · CI failing", state: "failed", at: ago(5) },
        { id: "j", itemId: "b", title: "Nightly job", state: "running", at: ago(1) },
      ],
      lastLooked: ago(60),
      now,
    });
    expect(s.counts).toMatchObject({ working: 2, stuck: 1, newStuck: 1 });
    expect(s).toMatchObject({ state: "failed", text: "Storefront · CI failing failed", target: { tab: "running", ref: undefined } });
  });

  it("several new problems are counted together; older ones stay in the counts", () => {
    const s = coordinatorStatus({
      needs: 2,
      runs: [run(1, { state: "failed", updatedAt: ago(5) }), run(2, { state: "failed", updatedAt: ago(4) }), run(3, { state: "failed", updatedAt: ago(300) })],
      lastLooked: ago(60),
      now,
    });
    expect(s).toMatchObject({ text: "2 runs newly stuck", rest: "2 need you", counts: { stuck: 3, newStuck: 2 } });
  });

  it("a run waiting on the owner is counted as waiting, never as stuck or as news", () => {
    const s = coordinatorStatus({ needs: 3, runs: [run(1, { state: "waiting", updatedAt: ago(5) }), run(2)], lastLooked: ago(60), now });
    expect(s).toMatchObject({ state: "needs", text: "3 need you", rest: "1 working", counts: { stuck: 0, newStuck: 0, waiting: 1 } });
  });

  it("a waiting run with no decision of its own is never reported as nothing waiting", () => {
    const one = coordinatorStatus({
      needs: 0,
      runs: [run(1, { state: "waiting", title: "Order the filters", updatedAt: ago(5) }), run(2)],
      lastLooked: ago(1),
      now,
    });
    expect(one).toMatchObject({
      state: "needs",
      dot: "yellow",
      text: "Order the filters is waiting on you",
      rest: "1 working",
      target: { tab: "running", ref: "R-1" },
      counts: { needs: 0, waiting: 1 },
    });
    const two = coordinatorStatus({
      needs: 0,
      runs: [run(1, { state: "waiting", updatedAt: ago(5) }), run(2, { state: "waiting", updatedAt: ago(9) })],
      lastLooked: ago(1),
      now,
    });
    expect(two).toMatchObject({ state: "needs", text: "2 runs are waiting on you", target: { tab: "running" } });
    expect(two.target.ref).toBeUndefined();
  });

  it("several new problems are summarised, and finished work outranks plain progress", () => {
    const many = coordinatorStatus({
      needs: 0,
      runs: [run(1, { state: "failed", updatedAt: ago(3) }), run(2, { state: "interrupted", updatedAt: ago(2) })],
      lastLooked: ago(60),
      now,
    });
    expect(many.text).toBe("2 runs newly stuck");
    expect(coordinatorStatus({ needs: 0, runs: [run(1)], finished: 2, lastLooked: null, now })).toMatchObject({
      state: "finished",
      text: "2 finished · ready to review",
      rest: "1 working",
    });
  });
});
