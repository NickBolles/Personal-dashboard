import { describe, expect, it } from "vitest";
import type { Decision } from "@/lib/cw-decisions";
import type { WorkItem } from "@/lib/work";
import { changeChip, changeLabel, changeObject, dueLabel, itemCardModel, itemPath, subtreeIds } from "./item-card";
import type { CoordinatorRunRow } from "./runs-view";

const now = new Date(2026, 10, 10, 12).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
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
const run = (id: string, itemId: string, over: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow => ({
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
  startedAt: iso(now - 7_200_000),
  updatedAt: iso(now - 60_000),
  finishedAt: null,
  noticeCount: 0,
  ...over,
});
const decision = (id: string, itemId: string, over: Partial<Decision> = {}): Decision =>
  ({
    id,
    ref: `D-${id}`,
    seq: 1,
    itemId,
    question: "Ship it?",
    choices: ["Yes", "No"],
    state: "open",
    risk: [],
    createdAt: iso(now - 3_600_000),
    updatedAt: iso(now),
    ...over,
  }) as Decision;

const tree = [
  item("area", { kind: "area", title: "Portfolio" }),
  item("proj", { kind: "project", parentId: "area", title: "Storefront" }),
  item("a", { parentId: "proj", status: "settled" }),
  item("b", { parentId: "proj", nextAction: " Confirm the dates ", targetDate: "2026-11-22" }),
  item("note", { parentId: "proj", kind: "note" }),
];

describe("tree helpers", () => {
  it("finds a subtree and an item's path", () => {
    expect([...subtreeIds(tree, "proj")].sort()).toEqual(["a", "b", "note", "proj"]);
    expect(itemPath(tree, tree[3]!)).toEqual(["Portfolio", "Storefront"]);
    expect(itemPath(tree, tree[0]!)).toEqual([]);
  });
});

describe("dueLabel", () => {
  it("says how soon, and stops once the item is closed", () => {
    expect(dueLabel("2026-11-07", "in_progress", now)).toEqual({ label: "Overdue 3 d", tone: "bad" });
    expect(dueLabel("2026-11-10", "in_progress", now)).toEqual({ label: "Due today", tone: "wn" });
    expect(dueLabel("2026-11-11", "in_progress", now)).toEqual({ label: "Due tomorrow", tone: "wn" });
    expect(dueLabel("2026-11-22", "in_progress", now)?.label).toMatch(/^Due \w+ 22$/);
    expect(dueLabel("2026-11-07", "settled", now)).toBeNull();
    expect(dueLabel(null, "captured", now)).toBeNull();
  });
});

describe("itemCardModel", () => {
  it("an item with nothing going on shows its own status, next step and due date", () => {
    const m = itemCardModel({ item: tree[3]!, items: tree, now });
    expect(m).toMatchObject({
      kind: "Thread",
      container: false,
      path: ["Portfolio", "Storefront"],
      next: "Confirm the dates",
      headline: { key: "status", label: "Captured", live: false },
    });
    expect(m.due?.label).toMatch(/^Due/);
    expect(m.progress).toBeNull();
  });
  it("what needs the owner outranks everything; then a failed run, a quiet run, then work in flight", () => {
    const runs = [run("1", "b"), run("2", "b", { stalled: true }), run("3", "b", { state: "failed" })];
    const base = { item: tree[3]!, items: tree, now };
    expect(itemCardModel({ ...base, runs, decisions: [decision("1", "b")] }).headline).toMatchObject({ key: "needs", label: "Needs you", tone: "wn" });
    expect(itemCardModel({ ...base, runs }).headline).toMatchObject({ key: "failed", tone: "bad" });
    expect(itemCardModel({ ...base, runs: runs.slice(0, 2) }).headline).toMatchObject({ key: "stuck", label: "Run quiet", tone: "wn" });
    expect(itemCardModel({ ...base, runs: [run("5", "b", { state: "interrupted" })] }).headline).toMatchObject({ key: "stuck", label: "Run interrupted" });
    expect(itemCardModel({ ...base, runs: runs.slice(0, 1) }).headline).toMatchObject({ key: "working", live: true });
    // an answered decision and a failure from last week are history
    const old = run("4", "b", { state: "failed", updatedAt: iso(now - 6 * 86_400_000) });
    expect(itemCardModel({ ...base, runs: [old], decisions: [decision("2", "b", { state: "answered" })] }).headline.key).toBe("status");
  });
  it("a project gathers what is under it and counts its direct work", () => {
    const m = itemCardModel({
      item: tree[1]!,
      items: tree,
      runs: [run("1", "b"), run("9", "elsewhere")],
      decisions: [decision("1", "a"), decision("2", "elsewhere")],
      now,
    });
    expect(m.container).toBe(true);
    expect(m.decisions.map((d) => d.ref)).toEqual(["D-1"]);
    expect(m.working.map((r) => r.ref)).toEqual(["R-1"]);
    expect(m.progress).toEqual({ done: 1, total: 2 });
    expect(m.headline.key).toBe("needs");
  });
});

describe("changes", () => {
  const row = (type: string, verb: string, detail: string | null = null) => ({ type, verb, detail }) as never;
  const said = (r: never) => [changeChip(r).label, changeObject(r)].filter(Boolean).join(" ");
  it("a coloured chip that is the verb, then what it was done to", () => {
    expect(changeChip(row("created", "created"))).toEqual({ label: "Created", tone: "ok" });
    expect(said(row("created", "created"))).toBe("Created");
    expect(said(row("edit", "edited summary"))).toBe("Edited summary");
    expect(said(row("edit", "edited next action"))).toBe("Edited next action");
    expect(changeChip(row("edit", "tagged #q4, #sale"))).toEqual({ label: "Tagged", tone: "inf" });
    expect(said(row("edit", "tagged #q4, #sale"))).toBe("Tagged #q4, #sale");
    expect(said(row("link", "linked", "Linked Sponsor shortlist (draft)"))).toBe("Linked Sponsor shortlist (draft)");
    expect(changeChip(row("edit", "needs your decision: Ship tonight?"))).toEqual({ label: "Raised decision", tone: "wn" });
    expect(changeObject(row("edit", "needs your decision: Ship tonight?"))).toBe("Ship tonight?");
    expect(changeChip(row("edit", "started agent run: Smoke tests"))).toEqual({ label: "Run started", tone: "ai" });
    expect(changeObject(row("edit", "started agent run: Smoke tests"))).toBe("Smoke tests");
    expect(changeChip(row("status", "moved to Exploring")).tone).toBe("ac");
    expect(said(row("status", "moved to Exploring", "Captured → Exploring: Predates the new checkout"))).toBe("Moved to Exploring: Predates the new checkout");
    expect(said(row("status", "moved to Ready"))).toBe("Moved to Ready");
    // the full sentence (for Undo's accessible name) is unchanged
    expect(changeLabel(row("created", "created"))).toBe("Created item");
    expect(changeLabel(row("edit", "edited summary"))).toBe("Edited summary");
  });
  it("turns the raw date edit into what changed, with what it was before", () => {
    expect(changeLabel(row("edit", "Dates: start — → —, target — → 2026-11-22"))).toMatch(/^Target date \w+ 22$/);
    expect(changeChip(row("edit", "Dates: start — → —, target — → 2026-11-22")).label).toBe("Dates");
    expect(changeObject(row("edit", "Dates: start — → —, target — → 2026-11-22"))).toMatch(/^target \w+ 22$/);
    expect(changeObject(row("edit", "Dates: start — → 2026-11-12, target 2026-11-22 → —"))).toMatch(/^start \w+ 12, target cleared \(was \w+ 22\)$/);
    expect(changeObject(row("edit", "Dates: start — → —, target 2026-11-15 → 2026-11-22"))).toMatch(/^target \w+ 22 \(was \w+ 15\)$/);
  });
});
