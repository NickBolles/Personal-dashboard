import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/cw-runs";
import { eventChip, eventClock, eventText, runStatus, sinceChips, sinceRunCounts, timelineOf } from "./run-card";
import type { CoordinatorRunRow } from "./runs-view";

const now = Date.parse("2026-11-10T16:00:00.000Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const run = (over: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow => ({
  id: "r1",
  ref: "R-1",
  seq: 1,
  itemId: "i1",
  itemTitle: "Item",
  profile: "devchief",
  title: "Smoke tests",
  state: "running",
  stalled: false,
  summary: null,
  prUrl: null,
  parentRunId: null,
  parentRef: null,
  pipeline: [],
  lock: null,
  interruptedAt: null,
  startedAt: ago(120),
  updatedAt: ago(2),
  finishedAt: null,
  noticeCount: 0,
  ...over,
});
const event = (over: Partial<RunEvent> = {}): RunEvent => ({
  id: "e1",
  runId: "r1",
  runRef: "R-1",
  type: "progress",
  summary: "Half way",
  payload: {},
  via: null,
  at: ago(5),
  ...over,
});

describe("runStatus", () => {
  it("says what a run is doing in a chip and a duration", () => {
    expect(runStatus(run(), now)).toMatchObject({ key: "working", label: "Working", tone: "ai", live: true, attention: false });
    expect(runStatus(run({ stalled: true, updatedAt: ago(47) }), now)).toMatchObject({
      key: "stuck",
      label: "Stuck",
      detail: "no update for 47 min",
      tone: "wn",
      attention: true,
    });
    expect(runStatus(run({ state: "failed" }), now)).toMatchObject({ label: "Failed", tone: "bad", attention: true });
    expect(runStatus(run({ state: "waiting" }), now)).toMatchObject({ label: "Waiting on you", tone: "wn", attention: true });
    expect(runStatus(run({ state: "done", finishedAt: ago(1) }), now)).toMatchObject({ label: "Done", tone: "ok", attention: false, live: false });
  });
});

describe("eventChip", () => {
  it("gives each event type a plain label and a tone", () => {
    expect(eventChip(event({ type: "started" }))).toEqual({ label: "Started", tone: "neutral" });
    expect(eventChip(event({ type: "failed" }))).toEqual({ label: "Failed", tone: "bad" });
    expect(eventChip(event({ type: "release.live" }))).toEqual({ label: "Live", tone: "ok" });
  });
  it("colours a CI event only by what it says", () => {
    expect(eventChip(event({ type: "ci", summary: "Smoke suite started" })).tone).toBe("inf");
    expect(eventChip(event({ type: "ci", summary: "Checks failed on main" })).tone).toBe("bad");
    expect(eventChip(event({ type: "ci", summary: "All checks passed" })).tone).toBe("ok");
    expect(eventChip(event({ type: "ci", summary: "Checks", payload: { pipeline: [{ stage: "ci", state: "failed" }] } })).tone).toBe("bad");
  });
});

describe("timeline helpers", () => {
  it("drops an event summary that only repeats the run title", () => {
    expect(eventText(event({ summary: " Smoke  tests " }), "Smoke tests")).toBe("");
    expect(eventText(event({ summary: "11 of 12 passed" }), "Smoke tests")).toBe("11 of 12 passed");
  });
  it("merges lists newest first without duplicates", () => {
    const a = event({ id: "a", at: ago(30) });
    const b = event({ id: "b", at: ago(10) });
    expect(timelineOf([a, b], [b]).map((e) => e.id)).toEqual(["b", "a"]);
    expect(timelineOf(undefined)).toEqual([]);
  });
  it("shows a time today and a day for older events", () => {
    expect(eventClock(ago(5), now)).toMatch(/\d{1,2}:\d{2}/);
    expect(eventClock(ago(60 * 24 * 30), now)).not.toMatch(/:/);
    expect(eventClock("nope", now)).toBe("");
  });
});

describe("since you last looked", () => {
  it("breaks runs down by what they are doing now, worst first", () => {
    const since = now - 120 * 60_000;
    const counts = sinceRunCounts(
      [
        run({ id: "a", state: "failed", updatedAt: ago(10) }),
        run({ id: "b", state: "done", updatedAt: ago(20), finishedAt: ago(20) }),
        run({ id: "c", stalled: true, updatedAt: ago(50) }),
        run({ id: "d", updatedAt: ago(1) }),
        run({ id: "e", state: "done", updatedAt: ago(600) }),
      ],
      since,
    );
    expect(counts).toEqual({ runs: 4, failed: 1, stuck: 1, waiting: 0, finished: 1 });
    expect(sinceChips({ decisions: 2, ...counts }).map((c) => c.label)).toEqual(["1 failed", "2 new decisions", "1 stuck", "1 finished", "1 run updated"]);
  });
  it("without a breakdown it still counts runs", () => {
    expect(sinceChips({ decisions: 0, runs: 3 })).toEqual([{ key: "runs", label: "3 runs updated", tone: "ai", tab: "running" }]);
    expect(sinceChips({ decisions: 0, runs: 0 })).toEqual([]);
  });
});
