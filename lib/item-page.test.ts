import { describe, expect, it } from "vitest";
import type { ExternalRun, ItemAgentInfo } from "@/lib/agent-runs";
import type { JobView, ReportView } from "@/lib/ai";
import type { Decision } from "@/lib/cw-decisions";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import type { WorkItem } from "@/lib/work";
import { WORK_WORD } from "@/lib/work-words";
import { containerRollup, groupWork, itemNow, itemWorkRows, logLine, runWorkState } from "./item-page";

const now = new Date(2026, 10, 10, 12).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id,
    parentId: null,
    kind: "thread",
    title: `Item ${id}`,
    summary: "",
    nextAction: "",
    status: "captured",
    sortOrder: 0,
    startDate: null,
    targetDate: null,
    completedAt: null,
    settledKind: null,
    settledReason: null,
    archived: false,
    builtIn: false,
    validationDefault: null,
    sessionId: null,
    settings: null,
    tags: [],
    assignee: null,
    decision: null,
    createdAt: iso(now - 86_400_000),
    updatedAt: iso(now - 3_600_000),
    ...over,
  }) as WorkItem;
const ext = (id: string, over: Partial<ExternalRun> = {}): ExternalRun => ({
  id,
  title: `Run ${id}`,
  profile: "devchief",
  state: "running",
  summary: null,
  prUrl: null,
  startedAt: iso(now - 120 * MIN),
  updatedAt: iso(now - MIN),
  ...over,
});
const tracked = (id: string, itemId: string, over: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow => ({
  id,
  ref: `R-${id}`,
  seq: 1,
  itemId,
  itemTitle: "",
  profile: "devchief",
  title: `Run ${id}`,
  state: "running",
  stalled: false,
  summary: null,
  prUrl: null,
  parentRunId: null,
  parentRef: null,
  pipeline: [],
  lock: null,
  interruptedAt: null,
  startedAt: iso(now - 120 * MIN),
  updatedAt: iso(now - MIN),
  finishedAt: null,
  noticeCount: 0,
  ...over,
});
const decision = (id: string, itemId: string, over: Partial<Decision> = {}): Decision =>
  ({ id, ref: `D-${id}`, seq: 1, itemId, runId: null, question: "Ship it?", choices: ["Yes", "No"], state: "open", risk: [], createdAt: iso(now - 60 * MIN), updatedAt: iso(now), ...over }) as Decision;
const info = (over: Partial<ItemAgentInfo> = {}): ItemAgentInfo => ({
  itemId: "a",
  areaId: null,
  title: "Item a",
  who: null,
  live: "idle",
  liveAt: null,
  sessionId: null,
  runs: 0,
  prs: [],
  report: null,
  progress: null,
  ...over,
});
const job = (id: string, over: Partial<JobView> = {}): JobView =>
  ({ id, kind: "research", subjectType: "work_item", subjectId: "a", state: "running", createdAt: iso(now - 5 * MIN), startedAt: iso(now - 4 * MIN), finishedAt: null, errorMessage: null, conversationId: null, ...over }) as JobView;
const report = (id: string, over: Partial<ReportView> = {}): ReportView =>
  ({ id, jobId: `j${id}`, kind: "research", title: `Report ${id}`, summary: "", confidence: "medium", createdAt: iso(now - 30 * MIN), sourceCount: 3, supersededBy: null, archivedAt: null, readAt: null, ...over }) as ReportView;

describe("runWorkState", () => {
  it("uses the five shared words, never a synonym", () => {
    expect(runWorkState(ext("1", { state: "waiting" }), now)).toBe("needs");
    expect(runWorkState(ext("1", { state: "failed" }), now)).toBe("failed");
    expect(runWorkState(ext("1", { state: "done" }), now)).toBe("done");
    expect(runWorkState(ext("1"), now)).toBe("working");
    // 30 minutes of silence, or interrupted and waiting to be resumed: Stalled.
    expect(runWorkState(ext("1", { updatedAt: iso(now - 31 * MIN) }), now)).toBe("stalled");
    expect(runWorkState(ext("1", { state: "interrupted" }), now)).toBe("stalled");
    expect(runWorkState(ext("1"), now, true)).toBe("stalled");
  });
});

describe("itemWorkRows", () => {
  it("draws every run, job and report once, in the order Needs you, Working, Done", () => {
    const rows = itemWorkRows({
      info: info({
        live: "waiting",
        agentRuns: [ext("done", { state: "done", summary: "Renamed the flags" }), ext("work"), ext("wait", { state: "waiting", summary: "Waiting on your budget ceiling." })],
      }),
      runs: [tracked("wait", "a", { state: "waiting" }), tracked("work", "a", { lastEvent: { summary: "4 of 6 checks" } as CoordinatorRunRow["lastEvent"] })],
      jobs: [job("j1"), job("j2", { state: "succeeded", finishedAt: iso(now - MIN) })],
      reports: [report("r1")],
      now,
    });
    expect(rows.map((r) => `${r.kind}:${r.state}`)).toEqual(["run:needs", "run:working", "job:working", "run:done", "report:done"]);
    const groups = groupWork(rows);
    expect([groups.needs.length, groups.working.length, groups.done.length]).toEqual([1, 2, 2]);
    const [wait, work] = rows;
    expect(wait).toMatchObject({ refId: "R-wait", note: "Waiting on your budget ceiling." });
    expect(work).toMatchObject({ refId: "R-work", note: "4 of 6 checks" });
    // A finished job is its report, not a second row.
    expect(rows.filter((r) => r.kind === "job")).toHaveLength(1);
  });

  it("names the decision a waiting run raised", () => {
    const rows = itemWorkRows({
      info: info({ live: "waiting", agentRuns: [ext("1", { state: "waiting", summary: "Waiting on you" })] }),
      decisions: [decision("52", "a", { runId: "1", question: "What is the budget ceiling?" })],
      now,
    });
    expect(rows[0]).toMatchObject({ state: "needs", note: "answer D-52", decision: { ref: "D-52" } });
  });

  it("says how long a stalled run has been silent and ranks a failure above it", () => {
    const rows = itemWorkRows({
      info: info({ live: "failed", agentRuns: [ext("quiet", { updatedAt: iso(now - 34 * MIN) }), ext("bad", { state: "failed", summary: "(no summary — status=failed: vendor portal timed out)" })] }),
      now,
    });
    expect(rows.map((r) => r.state)).toEqual(["failed", "stalled"]);
    expect(rows[0]!.note).toBe("Vendor portal timed out");
    expect(rows[1]!.note).toBe("no report for 34 min");
  });

  it("keeps a job that needs the owner or just failed, and drops an old failure", () => {
    const rows = itemWorkRows({
      jobs: [
        job("approve", { state: "waiting_approval" }),
        job("budget", { state: "budget_blocked" }),
        job("fresh", { state: "failed", finishedAt: iso(now - 10 * MIN), errorMessage: "timeout" }),
        job("old", { state: "failed", finishedAt: iso(now - 120 * MIN) }),
        job("cancelled", { state: "cancelled", finishedAt: iso(now - MIN) }),
      ],
      now,
    });
    expect(rows.map((r) => [r.key, r.state, r.note])).toEqual([
      ["job:approve", "needs", "Hermes needs approval"],
      ["job:budget", "needs", "waiting for budget"],
      ["job:fresh", "failed", "timeout"],
    ]);
  });

  it("adds the linked conversation only when no run, job or report explains the item's state", () => {
    const chat = itemWorkRows({ info: info({ live: "waiting", approval: true, sessionId: "sess_1", who: { kind: "agent", name: "devchief" }, liveAt: iso(now - MIN) }), now });
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ kind: "chat", state: "needs", title: "Conversation", note: "approval · @devchief", sessionId: "sess_1" });
    // The registered run already says "Working": no second row for the same work.
    expect(itemWorkRows({ info: info({ live: "running", sessionId: "sess_1", agentRuns: [ext("1")] }), now })).toHaveLength(1);
    // Nothing has run: nothing is drawn.
    expect(itemWorkRows({ info: info(), now })).toEqual([]);
  });

  it("marks a superseded report and hides an archived one", () => {
    const rows = itemWorkRows({ reports: [report("old", { supersededBy: "new", createdAt: iso(now - MIN) }), report("new"), report("gone", { archivedAt: iso(now) })], now });
    expect(rows.map((r) => r.key)).toEqual(["report:new", "report:old"]);
    expect(rows[1]!.note).toContain("earlier version");
  });

  it("never produces a state word outside the shared vocabulary", () => {
    const rows = itemWorkRows({
      info: info({ live: "finished", agentRuns: [ext("1", { state: "interrupted" }), ext("2", { state: "done" })] }),
      jobs: [job("j")],
      reports: [report("r")],
      now,
    });
    for (const row of rows) expect(Object.keys(WORK_WORD)).toContain(row.state);
  });
});

describe("itemNow", () => {
  const rows = itemWorkRows({ info: info({ live: "waiting", agentRuns: [ext("1", { state: "waiting" }), ext("2")] }), now });
  it("gives the slot to the escalation banner when it has something", () => {
    expect(itemNow({ itemId: "a", escalation: true, action: "settle", rows })).toEqual({ kind: "escalation" });
  });
  it("points at what waits on the owner instead of offering a primary action", () => {
    const result = itemNow({ itemId: "a", escalation: false, action: "packet", rows, decisions: [decision("5", "a"), decision("9", "other"), decision("7", "a", { state: "answered" })] });
    expect(result.kind).toBe("pointer");
    if (result.kind !== "pointer") return;
    expect(result.decisions.map((d) => d.ref)).toEqual(["D-5"]);
    expect(result.rows.map((r) => r.key)).toEqual(["run:1"]);
  });
  it("shows the one primary action only when nothing needs the owner", () => {
    const calm = itemWorkRows({ info: info({ live: "running", agentRuns: [ext("2")] }), now });
    expect(itemNow({ itemId: "a", escalation: false, action: "settle", rows: calm })).toEqual({ kind: "action", action: "settle" });
  });
});

describe("logLine", () => {
  it("counts the changes and says when the last one was", () => {
    expect(logLine([], now)).toBeNull();
    expect(logLine([{ at: iso(now - 2 * 86_400_000) }], now)).toBe("1 change · last one 2 d ago");
    expect(logLine([{ at: iso(now - 3 * 86_400_000) }, { at: iso(now - 5 * MIN) }, { at: iso(now - 86_400_000) }], now)).toBe("3 changes · last one 5 min ago");
    expect(logLine([{ at: iso(now - 5_000) }], now)).toBe("1 change · last one just now");
  });
});

describe("containerRollup", () => {
  const tree = [
    item("area", { kind: "area", title: "Home" }),
    item("proj", { kind: "project", parentId: "area", title: "Household admin" }),
    item("desk", { parentId: "proj", title: "Standing desk", targetDate: "2026-11-13" }),
    item("lumber", { parentId: "proj", title: "Order lumber" }),
    item("car", { parentId: "proj", title: "Renew car registration", nextAction: "Upload the insurance card", status: "ready" }),
    item("old", { parentId: "proj", title: "Paint the fence", status: "settled" }),
    item("gone", { parentId: "proj", title: "Archived thing", archived: true }),
    item("sub", { kind: "project", parentId: "proj", title: "Garage" }),
    item("shelf", { parentId: "sub", title: "Shelving", status: "settled" }),
    item("bench", { parentId: "sub", title: "Workbench" }),
  ];
  const runs = [
    tracked("37", "lumber", { title: "Price lumber", stalled: true, updatedAt: iso(now - 34 * MIN) }),
    tracked("43", "car", { title: "Add lumber order to House list", lastEvent: { summary: "checking for duplicates" } as CoordinatorRunRow["lastEvent"] }),
    tracked("44", "car", { title: "Sub-agent", parentRunId: "43" }),
    tracked("50", "bench", { title: "Old failure", state: "failed", updatedAt: iso(now - 30 * 86_400_000) }),
    tracked("51", "bench", { title: "Fresh failure", state: "failed", summary: "Could not reach the vendor" }),
    tracked("60", "elsewhere", { title: "Another project's run" }),
  ];
  const decisions = [decision("52", "desk", { question: "What is the budget ceiling?", createdAt: iso(now - 2 * 86_400_000) }), decision("99", "elsewhere")];
  const result = containerRollup({ item: tree[1]!, items: tree, runs, decisions, now });

  it("has one meta line", () => {
    expect(result.meta).toBe("6 items · 2 done");
    expect(containerRollup({ item: tree[0]!, items: tree, now }).meta).toBe("2 projects · 6 items · 2 done");
  });

  it("lists open decisions first under Needs you, then failed and stalled work, from anywhere below", () => {
    expect(result.needs.map((row) => `${row.refId}:${row.kind === "run" ? row.state : "decision"}`)).toEqual(["D-52:decision", "R-51:failed", "R-37:stalled"]);
    expect(result.needs[0]).toMatchObject({ title: "What is the budget ceiling?", itemTitle: "Standing desk", age: "2 d" });
    expect(result.needs[2]).toMatchObject({ note: "no report for 34 min", itemTitle: "Order lumber" });
  });

  it("lists runs still reporting under Working, with sub-agents folded in", () => {
    expect(result.working.map((row) => row.refId)).toEqual(["R-43"]);
    expect(result.working[0]!.note).toBe("checking for duplicates");
  });

  it("gives each open item its one headline and folds the closed ones into Done", () => {
    expect(result.items.map((row) => [row.item.id, row.state, row.refs.join(",")])).toEqual([
      ["desk", "needs", "D-52"],
      ["lumber", "stalled", "R-37"],
      ["car", "working", "R-43"],
      ["sub", "failed", "R-51"],
    ]);
    expect(result.items[0]!.due).toBe("Due Fri");
    expect(result.items[2]).toMatchObject({ next: "Upload the insurance card", status: "Ready" });
    expect(result.items[3]!.progress).toBe("1 of 2 done");
    expect(result.done.map((row) => row.item.id)).toEqual(["old"]);
  });

  it("draws an item nothing is happening to as idle, with its next action", () => {
    const calm = containerRollup({ item: tree[1]!, items: tree, now });
    expect(calm.needs).toEqual([]);
    expect(calm.working).toEqual([]);
    expect(calm.items.find((row) => row.item.id === "car")).toMatchObject({ state: "idle", refs: [], next: "Upload the insurance card" });
  });
});
