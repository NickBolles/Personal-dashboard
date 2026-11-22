import type { Page } from "@playwright/test";
import type { TaskListResponse, TaskMoment, TaskRow, TaskView } from "../../lib/task-list";

/** A populated task list (In flight, All and the review queue) with every row state, at times relative to `now`. */
export function taskFixture(now: number) {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const moment = (id: string, label: string, tone: TaskMoment["tone"], text: string, min: number): TaskMoment => ({ id, label, tone, text, at: ago(min) });
  const row = (over: Partial<TaskRow> & Pick<TaskRow, "id" | "title" | "state">): TaskRow => ({
    path: "Portfolio › Storefront",
    areaId: "area_portfolio",
    parentId: "proj_store",
    project: false,
    since: ago(6),
    cause: null,
    line: null,
    who: "@devchief",
    assignee: null,
    tags: [],
    activity: [],
    question: null,
    pr: null,
    chat: null,
    can: { steer: false, stop: false, retry: false },
    ...over,
  });
  const question = {
    ref: "D-52",
    itemId: "task_desk",
    itemTitle: "Compare standing desk frames",
    question: "What is your budget ceiling?",
    choices: ["$350", "$300"],
    recommended: "$350",
    risk: [],
    pack: {},
    defaultChoice: null,
    expiresAt: null,
    createdAt: ago(120),
    blocks: null,
  };
  const smoke = row({
    id: "task_smoke",
    title: "Checkout refactor: smoke tests",
    state: "failed",
    since: ago(49),
    line: "Coupon test timed out, second run",
    activity: [moment("m1", "Failed", "bad", "Coupon test timed out, second run", 49), moment("m2", "Progress", "ai", "11 of 12 checks passed", 64)],
    can: { steer: false, stop: false, retry: true },
  });
  const inventory = row({
    id: "task_inventory",
    title: "Reconcile the storefront inventory export",
    state: "working",
    chat: "sess_inventory",
    activity: [moment("m3", "Progress", "ai", "40 mismatches so far, all in one category", 2), moment("m4", "Step done", "ok", "Matched 172 of 212 rows", 6)],
    can: { steer: true, stop: true, retry: false },
  });
  const desk = row({
    id: "task_desk",
    title: "Compare standing desk frames",
    state: "needs",
    path: "Home › Office",
    areaId: "area_home",
    parentId: "proj_office",
    since: ago(120),
    who: "@homechief",
    line: "What is your budget ceiling?",
    question,
    activity: [
      moment("m5", "Asked you", "wn", "What is your budget ceiling?", 120),
      moment("m6", "Progress", "ai", "Shortlisted 4 frames between $260 and $410", 122),
    ],
  });
  const lumber = row({
    id: "task_lumber",
    title: "Price lumber for the garage shelving",
    state: "stalled",
    path: "Home",
    areaId: "area_home",
    parentId: "area_home",
    since: ago(143),
    who: "@homechief",
    activity: [
      moment("m7", "Progress", "ai", "Asked two suppliers for quotes", 143),
      moment("m8", "Step done", "ok", "Cut list: 14 boards, 2 sheets of plywood", 145),
    ],
    can: { steer: true, stop: false, retry: true },
  });
  const sale = row({
    id: "task_sale",
    title: "Holiday sale checklist",
    state: "idle",
    since: ago(3 * 24 * 60),
    cause: "captured",
    line: "Confirm the sale dates",
    who: null,
  });
  const theme = row({
    id: "task_theme",
    title: "Quieter stalled-run notices",
    state: "review",
    since: ago(9 * 24 * 60),
    line: "Notices fold after the first line",
    pr: { label: "PR 303", url: "https://github.example/pr/303", state: "merged", checks: "success" },
  });
  const wall = row({
    id: "task_wall",
    title: "Measure the wall",
    state: "review",
    path: "Home › Garage shelving",
    areaId: "area_home",
    parentId: "proj_shelf",
    since: ago(8 * 24 * 60),
    who: "@homechief",
    line: "3.2 m clear, studs at 40 cm",
  });
  const project = row({
    id: "proj_store",
    title: "Storefront",
    state: "idle",
    path: "Portfolio",
    parentId: "area_portfolio",
    project: true,
    who: null,
    rollup: { total: 10, done: 3, needs: 0, failed: 1, stalled: 0, working: 1, review: 1 },
    children: [smoke, inventory, theme, sale],
  });
  const base = { scope: "all", needs: 1, open: 6, fetchedAt: new Date(now).toISOString() };
  const lists: Record<TaskView, TaskListResponse> = {
    flight: {
      ...base,
      view: "flight",
      groups: [
        { id: "area_home", title: "Home", needs: 1, rows: [desk, lumber] },
        { id: "area_portfolio", title: "Portfolio", needs: 0, rows: [smoke, inventory] },
      ],
      review: { count: 2, projects: 2, oldestAt: ago(9 * 24 * 60) },
      done: { count: 3, titles: ["Recipe box dedupe", "Car registration"] },
    },
    all: {
      ...base,
      view: "all",
      groups: [
        { id: "area_home", title: "Home", needs: 1, rows: [desk, lumber] },
        { id: "area_portfolio", title: "Portfolio", needs: 0, rows: [project] },
      ],
      review: { count: 2, projects: 2, oldestAt: ago(9 * 24 * 60) },
      done: null,
    },
    review: {
      ...base,
      view: "review",
      groups: [
        { id: "proj_store", title: "Storefront", needs: 0, rows: [theme] },
        { id: "proj_shelf", title: "Garage shelving", needs: 0, rows: [wall] },
      ],
      review: { count: 2, projects: 2, oldestAt: ago(9 * 24 * 60) },
      done: null,
    },
  };
  const timeline: TaskMoment[] = [
    moment("m3", "Progress", "ai", "40 mismatches so far, all in one category", 2),
    moment("m4", "Step done", "ok", "Matched 172 of 212 rows", 6),
    moment("m9", "Started", "neutral", "From your message in Chat", 8),
    moment("m10", "Captured", "neutral", "By you", 30),
  ];
  return { lists, timeline, rows: { smoke, inventory, desk, lumber, sale, theme, wall, project } };
}

/** Serve the fixture for every view of the task list and for a row's timeline. */
export async function stubTasks(page: Page, now: number) {
  const fixture = taskFixture(now);
  await page.route(/\/api\/work\/tasks(?:\?.*)?$/, (route) => {
    const view = (new URL(route.request().url()).searchParams.get("view") ?? "flight") as TaskView;
    return route.fulfill({ json: fixture.lists[view] });
  });
  await page.route(/\/api\/work\/items\/[^/]+\/timeline$/, (route) => route.fulfill({ json: { moments: fixture.timeline } }));
  return fixture;
}
