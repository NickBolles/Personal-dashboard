/**
 * Task threads, step 3: the task list. One row per task with one state, read once for In flight, All and the
 * review queue; the badge is the number of Needs you rows; Stop and "Mark reviewed" are the owner's confirmed taps.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { raiseDecision } from "@/server/work/decision-store";
import { finishRegisteredRun, registerAgentRun } from "@/server/work/registered-runs";
import { recordRunEvent } from "@/server/work/run-events";
import { markReviewed, stopTask, taskList, taskTimeline, tasksNeedingYou } from "@/server/work/tasks";
import { rowAnswers, rollupLine, type TaskRow } from "@/lib/task-list";

const cid = "test";
let owner: CurrentUser;

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
});

const make = (title: string, parentId: string | null, kind: "area" | "project" | "thread" = "thread") =>
  store.createItem(owner, { kind, title, parentId }, cid);
const start = (itemId: string, title = "Work", profile = "devchief") => registerAgentRun(owner, profile, { itemId, title }, cid).runId;
const report = (runId: string, summary: string, type: "progress" | "notice" = "progress") =>
  recordRunEvent(getDb(), { userId: owner.id, runId, type, summary, via: "agent:devchief" });
const silence = (runId: string, minutes: number) =>
  getDb()
    .update(schema.agentRuns)
    .set({ updatedAt: new Date(Date.now() - minutes * 60_000).toISOString() })
    .where(eq(schema.agentRuns.id, runId))
    .run();
const titles = (rows: TaskRow[]) => rows.map((r) => r.title);

function seed() {
  const portfolio = make("Portfolio", null, "area");
  const home = make("Home", null, "area");
  const store_ = make("Storefront", portfolio.id, "project");
  const smoke = make("Checkout smoke tests", store_.id);
  const inventory = make("Reconcile inventory export", store_.id);
  const theme = make("Theme switch", store_.id);
  const sale = make("Holiday sale checklist", store_.id);
  const lumber = make("Price lumber", home.id);
  const desk = make("Compare desk frames", home.id);

  const failing = start(smoke.id, "Smoke tests");
  report(failing, "11 of 12 checks passed");
  finishRegisteredRun(owner, failing, "failed", "Coupon test timed out", new Date());
  const working = start(inventory.id, "Reconcile");
  report(working, "Matched 172 of 212 rows");
  report(working, "40 mismatches so far, all in one category");
  const quiet = start(lumber.id, "Lumber quotes");
  report(quiet, "Asked two suppliers for quotes");
  silence(quiet, 180);
  const asked = raiseDecision(
    owner.id,
    desk.id,
    { question: "What is your budget ceiling?", choices: ["$350", "$300"] },
    { raisedBy: "agent:homechief", correlationId: cid },
  );
  const finished = start(theme.id, "Theme switch");
  finishRegisteredRun(owner, finished, "done", "Theme switch merged", new Date());
  return { portfolio, home, store: store_, smoke, inventory, theme, sale, lumber, desk, working, asked };
}

describe("In flight", () => {
  it("lists one row per task that needs you, failed, stalled or is working; channels with something needing you first", () => {
    const t = seed();
    const list = taskList(owner, { scope: "all", view: "flight" });
    expect(list.groups.map((g) => g.title)).toEqual(["Home", "Portfolio"]);
    const [home, portfolio] = list.groups;
    expect(home!.rows.map((r) => [r.title, r.state])).toEqual([
      ["Compare desk frames", "needs"],
      ["Price lumber", "stalled"],
    ]);
    expect(portfolio!.rows.map((r) => [r.title, r.state])).toEqual([
      ["Checkout smoke tests", "failed"],
      ["Reconcile inventory export", "working"],
    ]);
    // Runs, questions and chats are never rows: every row is a task, once.
    const ids = list.groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(t.sale.id);
    expect(ids).not.toContain(t.theme.id);
    // The badge is the number of Needs you rows.
    expect(list.needs).toBe(1);
    expect(tasksNeedingYou(owner)).toBe(list.groups.flatMap((g) => g.rows).filter((r) => r.state === "needs").length);
  });

  it("a row says its state with a reason, who has it, and the latest activity with the one before", () => {
    const t = seed();
    const rows = taskList(owner, { scope: "all", view: "flight" }).groups.flatMap((g) => g.rows);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    const working = by(t.inventory.id);
    expect(working).toMatchObject({ who: "@devchief", path: "Portfolio › Storefront", can: { steer: true, stop: true, retry: false } });
    expect(working.activity.map((m) => m.text).slice(0, 2)).toEqual(["40 mismatches so far, all in one category", "Matched 172 of 212 rows"]);
    expect(by(t.smoke.id)).toMatchObject({ state: "failed", line: "Coupon test timed out", can: { steer: false, stop: false, retry: true } });
    expect(by(t.lumber.id)).toMatchObject({ state: "stalled", cause: null, can: { steer: true, retry: true } });
    const needs = by(t.desk.id);
    expect(needs).toMatchObject({ state: "needs", line: "What is your budget ceiling?" });
    expect(needs.question).toMatchObject({ ref: t.asked.ref, choices: ["$350", "$300"] });
    expect(needs.activity[0]).toMatchObject({ label: "Asked you", text: "What is your budget ceiling?" });
    // Two short, safe choices are offered on the row; anything else is "Answer".
    expect(rowAnswers(needs.question)).toEqual(["$350", "$300"]);
    expect(rowAnswers({ ...needs.question!, choices: ["A", "B", "C"] })).toEqual([]);
    expect(rowAnswers({ ...needs.question!, risk: ["money"] })).toEqual([]);
  });

  it("finished and unreviewed work is one summary, never rows; done since you looked is a count", () => {
    const t = seed();
    store.updateItem(owner, t.sale.id, { status: "abandoned", reason: "Not this year" }, cid);
    const list = taskList(owner, { scope: "all", view: "flight" });
    expect(list.review).toMatchObject({ count: 1, projects: 1 });
    expect(list.done).toEqual({ count: 1, titles: ["Holiday sale checklist"] });
  });

  it("scoped to one channel it holds only that channel's tasks (a coordinator's Tasks tab)", () => {
    const t = seed();
    const list = taskList(owner, { scope: t.home.id, view: "flight" });
    expect(list.groups.map((g) => g.title)).toEqual(["Home"]);
    expect(list.needs).toBe(1);
    expect(() => taskList(owner, { scope: "nope", view: "flight" })).toThrow(/No area or project/);
  });
});

describe("All", () => {
  it("holds every open task by channel, then project; a project rolls up what is inside and opens two levels", () => {
    const t = seed();
    const nested = make("Checkout refactor", t.store.id, "project");
    const inner = make("Coupon field", nested.id);
    const deep = make("Coupon edge cases", inner.id);
    make("Zero value coupon", deep.id);
    const list = taskList(owner, { scope: "all", view: "all" });
    const portfolio = list.groups.find((g) => g.title === "Portfolio")!;
    expect(titles(portfolio.rows)).toEqual(["Storefront"]);
    const project = portfolio.rows[0]!;
    expect(project).toMatchObject({ project: true });
    expect(project.rollup).toMatchObject({ total: 5, done: 0, failed: 1, working: 1, review: 1 });
    expect(rollupLine(project.rollup!)).toBe("0 of 5 done · 1 failed · 1 working · 1 to review");
    // Level one: its tasks, most in need first. Level two: a nested project's own rows. Deeper: a count.
    expect(titles(project.children!).slice(0, 2)).toEqual(["Checkout smoke tests", "Reconcile inventory export"]);
    const sub = project.children!.find((r) => r.id === nested.id)!;
    expect(titles(sub.children!)).toEqual(["Coupon field"]);
    expect(sub.children![0]).toMatchObject({ project: true, more: 1 });
    expect(sub.children![0]!.children).toBeUndefined();
    // Open tasks, projects not counted: four in Storefront, two in Home, and the one at the bottom of the nest.
    expect(list.open).toBe(7);
  });

  it("a project's Tasks section is the same read, scoped to the project", () => {
    const t = seed();
    const list = taskList(owner, { scope: t.store.id, view: "all" });
    expect(list.groups).toHaveLength(1);
    expect(titles(list.groups[0]!.rows)).toEqual(["Checkout smoke tests", "Reconcile inventory export", "Theme switch", "Holiday sale checklist"]);
    store.updateItem(owner, t.sale.id, { status: "abandoned", reason: "Not this year" }, cid);
    expect(titles(taskList(owner, { scope: t.store.id, view: "all" }).groups[0]!.rows)).not.toContain("Holiday sale checklist");
  });
});

describe("review queue", () => {
  it("groups finished work by project, oldest first, with the result line", () => {
    const t = seed();
    const shelf = make("Garage shelving", t.home.id, "project");
    const wall = make("Measure the wall", shelf.id);
    finishRegisteredRun(owner, start(wall.id, "Measure"), "done", "3.2 m clear, studs at 40 cm", new Date(Date.now() - 8 * 86_400_000));
    const list = taskList(owner, { scope: "all", view: "review" });
    expect(list.groups.map((g) => [g.title, titles(g.rows)])).toEqual([
      ["Garage shelving", ["Measure the wall"]],
      ["Storefront", ["Theme switch"]],
    ]);
    expect(list.groups[0]!.rows[0]).toMatchObject({ state: "review", line: "3.2 m clear, studs at 40 cm" });
    expect(list.review).toMatchObject({ count: 2, projects: 2 });
  });

  it("marking reviewed closes each task behind the owner's tap; every close can be undone; what cannot close is named", () => {
    const t = seed();
    const blocked = make("Needs proof", t.store.id);
    store.updateItem(owner, blocked.id, { nextAction: "Ship it" }, cid);
    const out = markReviewed(owner, [t.theme.id, t.theme.id], cid);
    expect(out.reviewed).toHaveLength(1);
    expect(out.reviewed[0]!.opId).toBeTruthy();
    expect(store.getDetail(owner.id, t.theme.id).item.status).toBe("settled");
    expect(taskList(owner, { scope: "all", view: "review" }).review).toBeNull();
    store.undoOp(owner, out.reviewed[0]!.opId!, cid);
    expect(store.getDetail(owner.id, t.theme.id).item.status).not.toBe("settled");
    expect(taskList(owner, { scope: "all", view: "review" }).review).toMatchObject({ count: 1 });
    // An area is not a task.
    expect(() => markReviewed(owner, [t.home.id], cid)).toThrow(/Task not found/);
  });
});

describe("stop and timeline", () => {
  it("Stop marks the open run stopped by you at once: the task reads Stalled with Resume, and nothing was running after", async () => {
    const t = seed();
    expect(await stopTask(owner, t.inventory.id, cid)).toMatchObject({ stopped: 1, turns: 0 });
    const row = taskList(owner, { scope: t.portfolio.id, view: "flight" }).groups[0]!.rows.find((r) => r.id === t.inventory.id)!;
    expect(row).toMatchObject({ state: "stalled", cause: "stopped by you", can: { stop: false, retry: true } });
    await expect(stopTask(owner, t.inventory.id, cid)).rejects.toMatchObject({ code: "not_running" });
    await expect(stopTask(owner, t.portfolio.id, cid)).rejects.toMatchObject({ code: "bad_item" });
  });

  it("the timeline is newest first: reports, the question and its answer, and how it began", () => {
    const t = seed();
    const run = start(t.desk.id, "Desk research", "homechief");
    report(run, "Shortlisted 4 frames between $260 and $410");
    const lines = taskTimeline(owner, t.desk.id).moments;
    expect(lines.map((m) => m.label)).toEqual(expect.arrayContaining(["Asked you", "Captured"]));
    expect(lines[lines.length - 1]).toMatchObject({ label: "Captured", text: "By you" });
    expect(lines.some((m) => m.text === "Shortlisted 4 frames between $260 and $410")).toBe(true);
    expect([...lines].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((m) => m.id)).toEqual(lines.map((m) => m.id));
  });
});
