import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/cw-runs";
import type { ExecutionRecord } from "@/lib/chat-execution";
import type { Decision } from "@/lib/cw-decisions";
import {
  byNeed,
  eventChip,
  eventAgo,
  eventText,
  mergeBackgroundWork,
  runAsk,
  runNeeds,
  runPulse,
  runStatus,
  sinceChips,
  sinceRunCounts,
  syncLine,
  tidyOutcome,
  timelineOf,
  workKey,
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
  it("says how long ago an event was, against now", () => {
    expect(eventAgo(ago(0.2), now)).toBe("just now");
    expect(eventAgo(ago(12), now)).toBe("12 min ago");
    expect(eventAgo(ago(60 * 3), now)).toBe("3 h ago");
    expect(eventAgo(ago(60 * 24 * 2), now)).toBe("2 d ago");
    expect(eventAgo("nope", now)).toBe("");
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
  it("a card never shows one sub-agent and controls another, whatever order the records arrive in", () => {
    const tracked = run({ id: "run-9", ref: "R-9", title: "Audit previews" });
    const a = rec({ key: "a", id: "sa_1" });
    const b = rec({ key: "b", id: "sa_2", step: "Reading the logs" });
    // two live sub-agents with one title and one tracked run of that title: which of them is the run cannot be
    // told, so neither is. Each has its own card and its own controls, in either order.
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const two = mergeBackgroundWork(order, [tracked]);
      expect(two).toHaveLength(2);
      for (const work of two) {
        expect(work.run).toBeUndefined();
        expect(work.control).toBe(work.record);
      }
    }
    // the run is still shown, by its own record, with no sub-agent controls attached
    const withRun = mergeBackgroundWork([a, b, rec({ key: "r", source: "registered_run", id: "reg_1", state: "unknown" })], [tracked]);
    expect(withRun.map((w) => [w.record.key, w.run?.ref, w.control?.id])).toEqual([
      ["a", undefined, "sa_1"],
      ["b", undefined, "sa_2"],
      ["r", "R-9", undefined],
    ]);
    // a second view of one of them does not become a third card
    const again = rec({ key: "b2", id: "child_2", subagentId: "sa_2" });
    expect(mergeBackgroundWork([a, { ...b, subagentId: "sa_2" }, again], [tracked]).map((w) => w.control?.id)).toEqual(["sa_1", "sa_2"]);
    // a failed attempt and its retry share a title: the run is the one still going, in either order
    const failed = rec({ key: "f", id: "sa_0", state: "failed", error: "Timed out" });
    for (const order of [
      [failed, a],
      [a, failed],
    ]) {
      const retry = mergeBackgroundWork(order, [tracked]);
      expect(retry.map((w) => [w.record.key, w.run?.ref]).sort()).toEqual([
        ["a", "R-9"],
        ["f", undefined],
      ]);
    }
    // two that have both ended: neither
    expect(mergeBackgroundWork([failed, rec({ key: "d", id: "sa_5", state: "completed" })], [tracked]).map((w) => w.run)).toEqual([undefined, undefined]);
    // a card is identified by the sub-agent it controls, however that sub-agent is seen
    expect(workKey({ record: a, control: rec({ key: "x", id: "child_1", subagentId: "sa_1" }) })).toBe(
      workKey({ record: a, control: rec({ key: "y", id: "sa_1", subagentId: "sa_1" }) }),
    );
    expect(workKey({ record: a, control: a })).not.toBe(workKey({ record: b, control: b }));
    expect(workKey({ record: a, run: tracked })).toBe("run:run-9");
    // the key is the address the controls use, and one record's key can never pass for another's handle
    const odd = rec({ key: "sa_B", id: "sa_A" });
    const other = rec({ key: "child_B", id: "child_B", subagentId: "sa_B" });
    expect(workKey({ record: odd, control: odd })).toBe("agent:sa_A");
    expect(workKey({ record: other, control: other })).toBe("agent:sa_B");
    expect(workKey({ record: odd })).toBe("record:sa_B");
    // a record with no status folds into its twin, and the controls go to the one that is shown
    const folded = mergeBackgroundWork([rec({ key: "a", id: "sa_1", state: "unknown" }), rec({ key: "b", id: "sa_2" })], []);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ record: { key: "b" }, control: { id: "sa_2" } });
    // the same sub-agent seen through two sources is still one card on its run
    const twice = mergeBackgroundWork(
      [rec({ key: "a", id: "child_1", subagentId: "sa_1" }), rec({ key: "b", id: "sa_1", subagentId: "sa_1", summary: "Halfway" })],
      [tracked],
    );
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ run: { ref: "R-9" }, record: { key: "b" }, control: { key: "b" } });
  });
  it("which card shows a run never depends on the order of the records", () => {
    const tracked = run({ id: "run-9", ref: "R-9", title: "Audit previews" });
    const orders = <T>(items: T[]): T[][] =>
      items.length < 2 ? [items] : items.flatMap((item, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    const shape = (work: ReturnType<typeof mergeBackgroundWork>) => work.map((w) => `${w.control?.id ?? "-"}:${w.record.key}:${w.run?.ref ?? "-"}`).sort();
    // a failed attempt seen twice (once with no status yet) and its live retry: the run is the retry's
    const stale = rec({ key: "u", id: "child_old", subagentId: "sa_old", state: "unknown" });
    const failed = rec({ key: "f", id: "sa_old", subagentId: "sa_old", state: "failed", error: "Timed out" });
    const retry = rec({ key: "a", id: "sa_new", subagentId: "sa_new" });
    for (const order of orders([stale, failed, retry])) {
      expect(shape(mergeBackgroundWork(order, [tracked]))).toEqual(["sa_new:a:R-9", "sa_old:f:-"]);
    }
    // one live sub-agent seen three ways, linked only pairwise (x~xy by id, xy~zy by handle): one card, with its run
    const x = rec({ key: "x", id: "x" });
    const xy = rec({ key: "xy", id: "x", subagentId: "y" });
    const zy = rec({ key: "zy", id: "z", subagentId: "y" });
    for (const order of orders([x, xy, zy])) {
      const work = mergeBackgroundWork(order, [tracked]);
      expect(work).toHaveLength(1);
      expect(work[0]!.run?.ref).toBe("R-9");
    }
    // a sub-agent that outlived its run, seen once with a start time and once without: its run either way
    const done = run({ id: "run-7", ref: "R-7", title: "Audit previews", state: "done", startedAt: ago(30), updatedAt: ago(20), finishedAt: ago(20) });
    const bare = rec({ key: "child", id: "child_1", subagentId: "sa_1", updatedAt: ago(10) });
    const full = rec({ key: "handle", id: "sa_1", subagentId: "sa_1", startedAt: ago(30), updatedAt: ago(10), summary: "Finishing cleanup" });
    for (const order of orders([bare, full])) {
      expect(shape(mergeBackgroundWork(order, [done]))).toEqual(["sa_1:handle:R-7"]);
    }
    // two views of one sub-agent under different titles, only one of which is the run's title
    const session = rec({ key: "session", id: "child_1", subagentId: "sa_1", title: "Audit", startedAt: ago(30) });
    for (const order of orders([session, full])) {
      expect(shape(mergeBackgroundWork(order, [done]))).toEqual(["sa_1:handle:R-7"]);
    }
    // a run two live sub-agents could both be is nobody's, including a third nothing is known about
    const other = rec({ key: "b", id: "sa_two", subagentId: "sa_two" });
    const blank = rec({ key: "n", id: "sa_q", state: "unknown" });
    for (const order of orders([retry, other, blank])) {
      expect(mergeBackgroundWork(order, [tracked]).every((w) => !w.run)).toBe(true);
    }
    // a sub-agent nothing is known about yet folds into the run's card and never takes its controls
    const nothing = rec({ key: "n", id: "sa_q", state: "unknown" });
    for (const order of orders([nothing, retry])) {
      expect(shape(mergeBackgroundWork(order, [tracked]))).toEqual(["sa_new:a:R-9"]);
    }
  });
  it("the same cards, shown records and controls come out of every order of the records", () => {
    const orders = <T>(items: T[]): T[][] =>
      items.length < 2 ? [items] : items.flatMap((item, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    const shape = (work: ReturnType<typeof mergeBackgroundWork>) => work.map((w) => `${w.control?.key ?? "-"}|${w.record.key}|${w.run?.ref ?? "-"}`).sort();
    const same = (records: ExecutionRecord[], runs: CoordinatorRunRow[]) => {
      const results = orders(records).map((order) => JSON.stringify(shape(mergeBackgroundWork(order, runs))));
      expect([...new Set(results)]).toHaveLength(1);
      return JSON.parse(results[0]!) as string[];
    };
    const done = run({ id: "run-1", ref: "R-1", title: "Audit previews", state: "done", startedAt: ago(30), updatedAt: ago(20), finishedAt: ago(20) });
    const at = { startedAt: ago(30), updatedAt: ago(20) };
    // two failed attempts contest the run; one of them is also seen with no status under a shorter title, next
    // to an unrelated sub-agent nothing is known about with that title
    expect(
      same(
        [
          rec({ key: "u", id: "u", subagentId: "u", title: "Audit", state: "unknown", ...at }),
          rec({ key: "au", id: "child_a", subagentId: "a", title: "Audit", state: "unknown", ...at }),
          rec({ key: "a", id: "a", subagentId: "a", state: "failed", ...at }),
          rec({ key: "b", id: "b", subagentId: "b", state: "failed", ...at }),
        ],
        [done],
      ),
    ).toEqual(["a|a|-", "b|b|-"]);
    // two sub-agents nothing is known about, on one run: one card, and always the same one of them
    expect(same([rec({ key: "a", id: "sa_a", state: "unknown", ...at }), rec({ key: "b", id: "sa_b", state: "unknown", ...at })], [done])).toEqual(["a|a|R-1"]);
    // views with no status that share titles pairwise: the same grouping however they arrive
    const bridge = [
      rec({ key: "a1", id: "agent-a", title: "X", state: "unknown" }),
      rec({ key: "a2", id: "agent-a", title: "Y", state: "unknown" }),
      rec({ key: "b", id: "agent-b", title: "Y", state: "unknown" }),
    ];
    expect(same(bridge, [])).toEqual(["a1|a1|-"]);
    // two runs with one title and one timestamp: the same one whichever is listed first
    const twin = { ...done, id: "run-2", ref: "R-2" };
    const registration = [rec({ key: "reg", source: "registered_run", id: "registration", state: "completed", ...at })];
    expect(shape(mergeBackgroundWork(registration, [done, twin]))).toEqual(shape(mergeBackgroundWork(registration, [twin, done])));
    // a live sub-agent, its registration and a stray with no status, with and without the run
    const mix = [
      rec({ key: "live", id: "sa_1", subagentId: "sa_1", startedAt: ago(30) }),
      rec({ key: "reg", source: "registered_run", id: "reg_1", state: "unknown" }),
      rec({ key: "stray", id: "sa_9", state: "unknown" }),
      rec({ key: "job", source: "jarvis_run", id: "job_1", state: "completed", summary: "Done" }),
    ];
    // (the finished job's record says most, so it is what the card shows; the controls are the live sub-agent's)
    expect(same(mix, [done])).toEqual(["live|job|R-1"]);
    // with no run to tie them, the job is its own card; the stray folds into one of the two, always the same one
    expect(same(mix, [])).toEqual(["live|live|-", "stray|job|-"]);
  });
  it("a shared title does not tie work to a run from another time", () => {
    const lastWeek = run({
      id: "run-1",
      ref: "R-1",
      title: "Audit previews",
      state: "done",
      startedAt: ago(60 * 24 * 7),
      updatedAt: ago(60 * 24 * 7 - 30),
      finishedAt: ago(60 * 24 * 7 - 30),
    });
    const today = rec({ key: "a", id: "sa_1", startedAt: ago(20) });
    expect(mergeBackgroundWork([today], [lastWeek])[0]!.run).toBeUndefined();
    const justBefore = run({ id: "run-3", ref: "R-3", title: "Audit previews", state: "done", startedAt: ago(90), updatedAt: ago(25), finishedAt: ago(25) });
    expect(mergeBackgroundWork([today], [justBefore])[0]!.run).toBeUndefined();
    // a record that only says when it last reported is placed by that
    expect(mergeBackgroundWork([rec({ key: "u", id: "sa_3", updatedAt: ago(3) })], [lastWeek])[0]!.run).toBeUndefined();
    // and of two runs with that title, the one from the same time is the one
    const thisWeek = run({ id: "run-2", ref: "R-2", title: "Audit previews", startedAt: ago(21), updatedAt: ago(1) });
    expect(mergeBackgroundWork([today], [lastWeek, thisWeek])[0]!.run?.ref).toBe("R-2");
    const old = rec({ key: "o", id: "sa_0", state: "completed", startedAt: ago(60 * 24 * 7), endedAt: ago(60 * 24 * 7 - 25) });
    expect(mergeBackgroundWork([old], [thisWeek, lastWeek])[0]!.run?.ref).toBe("R-1");
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

describe("runPulse", () => {
  it("places each report in the run's lifetime, oldest first, with its tone", () => {
    const r = run({ startedAt: ago(100), finishedAt: null });
    const ticks = runPulse(
      r,
      [event({ id: "b", at: ago(25) }), event({ id: "a", at: ago(75), type: "notice", summary: "Step failed again" }), event({ id: "c", at: "nope" })],
      now,
    );
    expect(ticks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(ticks[0]).toMatchObject({ at: 0.25, tone: "bad" });
    expect(ticks[1]!.at).toBeCloseTo(0.75);
    // a finished run is measured to when it finished; nonsense spans give nothing
    expect(runPulse(run({ startedAt: ago(100), finishedAt: ago(50) }), [event({ at: ago(75) })], now)[0]!.at).toBeCloseTo(0.5);
    expect(runPulse(run({ startedAt: "nope" }), [event()], now)).toEqual([]);
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
