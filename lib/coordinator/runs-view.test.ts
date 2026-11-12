import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import { childrenOf, foldNotices, groupRuns, refChips, sinceDivider, trayLine, type CoordinatorRunRow } from "./runs-view";

const now = new Date("2026-11-08T20:10:00Z");
function run(seq: number, overrides: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow {
  return {
    id: `run-${seq}`,
    ref: `R-${seq}`,
    seq,
    itemId: "item",
    itemTitle: "Item",
    title: "Hotfix chat send",
    profile: "devchief",
    state: "running",
    stalled: false,
    summary: null,
    prUrl: null,
    parentRunId: null,
    parentRef: null,
    pipeline: [],
    lock: null,
    interruptedAt: null,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    noticeCount: 0,
    ...overrides,
  };
}
function decision(seq: number, overrides: Partial<Decision> = {}): Decision {
  return {
    id: `decision-${seq}`,
    ref: `D-${seq}`,
    seq,
    itemId: "item",
    runId: null,
    question: "Rotate the Cloudflare key?",
    choices: ["Yes", "No"],
    recommended: "Yes",
    risk: [],
    pack: {},
    defaultChoice: null,
    expiresAt: null,
    state: "open",
    answeredChoice: null,
    answeredAt: null,
    answeredVia: null,
    deferredUntil: null,
    supersededBy: null,
    raisedBy: "devchief",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}
afterEach(() => vi.useRealTimers());
describe("groupRuns", () => {
  it("folds sub-runs, separates interruptions and waiting-on-you, puts failures before stalled", () => {
    const child = run(5, { parentRunId: "run-1", parentRef: "R-1", state: "failed" });
    const runs = [
      run(1),
      run(2, { state: "waiting" }),
      run(3, { state: "failed", updatedAt: "2026-11-08T18:00:00Z" }),
      run(4, { stalled: true }),
      child,
      run(6, { state: "interrupted", stalled: true }),
    ];
    const groups = groupRuns(runs);
    expect(groups.attention.map((r) => r.ref)).toEqual(["R-3", "R-4"]);
    // A run waiting on the owner is not stuck: it gets its own section.
    expect(groups.waiting.map((r) => r.ref)).toEqual(["R-2"]);
    expect(groups.running.map((r) => r.ref)).toEqual(["R-1"]);
    expect(groups.interrupted.map((r) => r.ref)).toEqual(["R-6"]);
    expect(childrenOf(runs, "run-1")).toEqual([child]);
    expect(runs[0].ref).toBe("R-1");
  });
  it("shows only done runs finished after the marker, falling back to 24 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const runs = [
      run(1, { state: "done", finishedAt: "2026-11-08T19:10:00Z" }),
      run(2, { state: "done", finishedAt: "2026-11-07T19:10:00Z" }),
      run(3, { state: "done", finishedAt: null }),
    ];
    expect(groupRuns(runs).done.map((r) => r.ref)).toEqual(["R-1"]);
    expect(groupRuns(runs, "2026-11-08T19:10:00Z").done).toEqual([]);
    expect(groupRuns(runs, "2026-11-07T18:00:00Z").done).toHaveLength(2);
  });
});
describe("trayLine", () => {
  it("newest failing or stalled run outranks even risky decisions", () => {
    const runs = [run(69, { state: "failed", updatedAt: "2026-11-08T18:00:00Z" }), run(70, { stalled: true })];
    expect(trayLine({ runs, decisions: [decision(48, { risk: ["credential"] })], now })).toEqual({
      kind: "run",
      ref: "R-70",
      text: "R-70 stalled · Hotfix chat send",
      tone: "bad",
      target: { tab: "running", ref: "R-70" },
    });
    expect(trayLine({ runs: [runs[0]], decisions: [], now }).text).toBe("R-69 failed · Hotfix chat send");
  });
  it("uses urgency for ageing/risky decisions, then newest decisions, then running", () => {
    const old = decision(1, { createdAt: "2026-11-06T19:00:00Z" });
    const risky = decision(2, { risk: ["money"] });
    expect(trayLine({ runs: [run(1)], decisions: [risky, old], now }).ref).toBe("D-1");
    expect(trayLine({ runs: [], decisions: [decision(1), risky], now }).ref).toBe("D-2");
    expect(trayLine({ runs: [], decisions: [decision(1), decision(3)], now }).ref).toBe("D-3");
    expect(trayLine({ runs: [run(9)], decisions: [decision(5, { state: "deferred" })], now }).ref).toBe("R-9");
    expect(trayLine({ runs: [], decisions: [], now }).kind).toBe("none");
  });
  it("clamps the whole line to 80 characters and flattens whitespace", () => {
    const line = trayLine({ runs: [], decisions: [decision(48, { question: `Long\n${"question ".repeat(30)}` })], now });
    expect(line.text).toHaveLength(80);
    expect(line.text).not.toContain("\n");
  });
});
describe("sinceDivider", () => {
  const counts = { decisions: 2, runs: 3 };
  it("is absent before 30 minutes or for missing/invalid/future markers", () => {
    for (const value of [null, undefined, "invalid", "2026-11-08T19:41:00Z", "2026-11-09T00:00:00Z"]) expect(sinceDivider(value, now, counts)).toBeNull();
  });
  it("uses locale time, floors hours and retains jump counts", () => {
    const then = new Date("2026-11-08T17:20:00Z");
    expect(sinceDivider(then.toISOString(), now, counts)).toEqual({
      label: `Since ${then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · 2 h`,
      jumps: counts,
    });
    expect(sinceDivider("2026-11-08T19:40:00Z", now, counts)?.label).toMatch(/ · 30 min$/);
  });
  it("adds the local weekday and whole days at 24 hours", () => {
    const then = new Date("2026-11-07T20:10:00Z");
    expect(sinceDivider(then.toISOString(), now, counts)?.label).toBe(
      `Since ${then.toLocaleDateString([], { weekday: "short" })} ${then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · 1 d`,
    );
  });
});
it("folds only notices per run and finds the latest regardless of input order", () => {
  const event = (id: string, at: string, type: RunEvent["type"] = "notice", runId = "run-1"): RunEvent => ({
    id,
    at,
    type,
    runId,
    runRef: "R-1",
    summary: id,
    payload: {},
    via: null,
  });
  const latest = event("new", now.toISOString());
  const other = event("other", now.toISOString(), "notice", "run-2");
  expect(foldNotices([latest, event("progress", now.toISOString(), "progress"), event("old", "2026-11-08T10:00:00Z"), other])).toEqual({
    "run-1": { count: 2, latest },
    "run-2": { count: 1, latest: other },
  });
});
it("extracts word-bounded D/R references with their exact index and preserves repeats", () => {
  expect(refChips("D-48, R-65. xD-1 R-2suffix D-48")).toEqual([
    { ref: "D-48", kind: "decision", index: 0 },
    { ref: "R-65", kind: "run", index: 6 },
    { ref: "D-48", kind: "decision", index: 27 },
  ]);
  expect(refChips("no refs r-1 D-no")).toEqual([]);
});
