import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/cw-runs";
import type { ExecutionRecord } from "@/lib/chat-execution";
import type { Decision } from "@/lib/cw-decisions";
import {
  byNeed,
  eventChip,
  eventClock,
  eventText,
  mergeBackgroundWork,
  runAsk,
  runNeeds,
  runStatus,
  sinceChips,
  sinceRunCounts,
  syncLine,
  tidyOutcome,
  timelineOf,
} from "./run-card";
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
      label: "Quiet",
      detail: "no update for 47 min",
      tone: "wn",
      attention: true,
    });
    expect(runStatus(run({ state: "failed" }), now)).toMatchObject({ label: "Failed", tone: "bad", attention: true });
    expect(runStatus(run({ state: "waiting" }), now)).toMatchObject({ label: "Waiting on you", tone: "wn", attention: true });
    expect(runStatus(run({ state: "done", finishedAt: ago(1) }), now)).toMatchObject({ label: "Finished", tone: "ok", attention: false, live: false });
  });
});

describe("eventChip", () => {
  it("gives each event type a plain label and a tone", () => {
    expect(eventChip(event({ type: "started" }))).toEqual({ label: "Started", tone: "neutral" });
    expect(eventChip(event({ type: "failed" }))).toEqual({ label: "Failed", tone: "bad" });
    expect(eventChip(event({ type: "release.live" }))).toEqual({ label: "Live", tone: "ok" });
  });
  it("a folded notice is a finished step, never the run's own outcome; one that says it failed is a failed step", () => {
    expect(eventChip(event({ type: "notice", summary: "Background process finished: wrote the diff" }))).toEqual({ label: "Step done", tone: "inf" });
    expect(eventChip(event({ type: "notice", summary: "Re-run 1 of the coupon test: failed again" }))).toEqual({ label: "Step failed", tone: "bad" });
    expect(eventChip(event({ type: "progress", summary: "Vendor portal timed out" }))).toEqual({ label: "Progress", tone: "bad" });
    expect(eventChip(event({ type: "progress", summary: "11 of 12 checks passed" })).tone).toBe("ai");
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

describe("background work", () => {
  const rec = (over: Partial<ExecutionRecord>): ExecutionRecord => ({
    key: "k",
    source: "subagent",
    id: "sa",
    title: "Audit previews",
    state: "running",
    ...over,
  });
  it("the sub-agent, its registration and the tracked run are one card; the run is the authority", () => {
    const tracked = run({ id: "run-9", ref: "R-9", title: "Audit previews" });
    const work = mergeBackgroundWork(
      [
        rec({ key: "a", id: "sa_1", updatedAt: ago(180) }),
        rec({ key: "b", source: "registered_run", id: "reg_1", state: "unknown" }),
        rec({ key: "c", id: "sa_2", title: "Other work", state: "completed", summary: "Done" }),
      ],
      [tracked],
    );
    expect(work).toHaveLength(2);
    expect(work[0]).toMatchObject({ run: { ref: "R-9" }, control: { id: "sa_1" }, record: { key: "a" } });
    expect(work[1]).toMatchObject({ record: { key: "c" } });
    expect(work[1]!.run).toBeUndefined();
  });
  it("a record with no status folds into its twin; two real sub-agents with one title stay apart", () => {
    expect(
      mergeBackgroundWork([rec({ key: "a", state: "unknown" }), rec({ key: "b", state: "failed", error: "Timed out" })], []).map((w) => w.record.key),
    ).toEqual(["b"]);
    expect(mergeBackgroundWork([rec({ key: "a", id: "sa_1" }), rec({ key: "b", id: "sa_2", state: "failed" })], [])).toHaveLength(2);
  });
  it("says what a waiting run needs, a raw fallback as a sentence, and how fresh the view is", () => {
    const d = (id: string, over: Partial<Decision>) =>
      ({ id, ref: `D-${id}`, itemId: "i1", runId: "r1", question: "Which frame?", state: "open", createdAt: ago(5), ...over }) as Decision;
    expect(runAsk(run(), [d("2", { createdAt: ago(1) }), d("1", {}), d("3", { state: "answered" }), d("4", { runId: "other" })])?.ref).toBe("D-1");
    expect(runAsk(run(), [])).toBeNull();
    // what a waiting run needs: its decision, else what the agent last said; nothing for a run that is not waiting
    expect(runNeeds(run({ state: "waiting" }), [d("1", {})])).toMatchObject({ text: "Which frame?", decision: { ref: "D-1" } });
    expect(runNeeds(run({ state: "waiting", summary: "Pick a frame" }), [])).toEqual({ text: "Pick a frame", decision: null });
    expect(runNeeds(run({ state: "waiting", summary: "Smoke tests" }), [])).toBeNull();
    expect(runNeeds(run({ summary: "Pick a frame" }), [d("1", {})])).toBeNull();
    // need, not recency: a failed run, then a failed step, then silence (most recent first)
    const order = byNeed(
      [
        run({ id: "quiet", updatedAt: ago(31) }),
        run({ id: "step", updatedAt: ago(90) }),
        run({ id: "dead", state: "failed", updatedAt: ago(300) }),
        run({ id: "older", updatedAt: ago(200) }),
      ],
      [event({ id: "x", runId: "step", type: "notice", summary: "Re-run failed again", at: ago(90) })],
    );
    expect(order.map((r) => r.id)).toEqual(["dead", "step", "quiet", "older"]);
    expect(tidyOutcome("(no summary — status=failed: vendor portal timed out)")).toBe("Vendor portal timed out");
    expect(tidyOutcome("  Drafted   three variants. ")).toBe("Drafted three variants.");
    expect(tidyOutcome(null)).toBe("");
    expect(syncLine(now - 5_000, false, now)).toBe("Synced just now");
    expect(syncLine(now - 180_000, false, now)).toBe("Synced 3 minutes ago");
    // a failed refresh always says how old the view is, however fresh
    expect(syncLine(now - 180_000, true, now)).toBe("Couldn't refresh · last synced 3 minutes ago");
    expect(syncLine(now - 5_000, true, now)).toBe("Couldn't refresh · last synced just now");
    expect(syncLine(0, true, now)).toBe("Couldn't refresh");
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
    expect(sinceChips({ decisions: 2, ...counts }).map((c) => c.label)).toEqual(["1 failed", "2 new decisions", "1 went quiet", "1 finished", "1 run updated"]);
  });
  it("without a breakdown it still counts runs", () => {
    expect(sinceChips({ decisions: 0, runs: 3 })).toEqual([{ key: "runs", label: "3 runs updated", tone: "ai", tab: "running" }]);
    expect(sinceChips({ decisions: 0, runs: 0 })).toEqual([]);
  });
});
