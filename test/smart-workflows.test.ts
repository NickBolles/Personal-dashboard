import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as store from "@/server/work/store";
import * as settingsRoute from "@/app/api/smart/settings/route";
import * as hydrateRoute from "@/app/api/smart/hydrate/route";
import * as surfacesRoute from "@/app/api/smart/surfaces/route";
import * as applyRoute from "@/app/api/smart/apply/route";
import * as workflowsRoute from "@/app/api/smart/workflows/route";
import * as ctxRoute from "@/app/api/smart/context-refs/route";
import { blockFits, chipIntent, intentInSpec, planWeekOf, type Intent } from "@/lib/jarvis-ui/intents";
import { specRefs, validateSpec } from "@/lib/jarvis-ui/validator";
import type { JarvisSpec } from "@/lib/jarvis-ui/catalog";
import { checkState, readiness, __resetPrCache } from "@/server/smart/data";
import { resolveContextRefs } from "@/server/smart/context";
import { smartInstructions } from "@/server/smart/prompt";

// Workflows slice 2: morning brief (ApprovalChips + metric gauges/sparklines),
// plan the week (WeekPlan + calendar.block behind its own approval) and the PR
// review card (GitHub-hydrated, never a merge intent).

const TODOS = [
  { id: "todos:gt-1", source: "todos", sourceId: "gt-1", title: "Return ladder", status: "open", dueAt: "2026-10-26T04:59:00.000Z", dueIsDate: true },
  { id: "todos:gt-2", source: "todos", sourceId: "gt-2", title: "Renew registration", status: "open", dueAt: "2026-10-29T04:59:00.000Z", dueIsDate: true },
  { id: "todos:gt-3", source: "todos", sourceId: "gt-3", title: "Far future thing", status: "open", dueAt: "2026-12-29T05:59:00.000Z", dueIsDate: true },
];
const EVENTS = [{ id: "ha:cal:1", title: "Dentist", startsAt: "2026-10-28T15:00:00.000Z", endsAt: "2026-10-28T16:30:00.000Z", source: "home_assistant" }];

vi.mock("@/server/sources", () => ({
  adapterContext: () => ({ now: new Date(), timezone: "America/Chicago", today: "2026-10-27" }),
  cachedSource: (s: string) =>
    s === "todos"
      ? { status: { source: "todos", state: "ok" }, data: { actions: TODOS } }
      : { status: { source: s, state: "ok" }, data: { actions: [], events: s === "home_assistant" ? EVENTS : [] } },
  scopeResult: (_u: unknown, r: unknown) => r,
  refreshSource: vi.fn(async () => undefined),
}));
vi.mock("@/integrations/todos/adapter", () => ({
  todosAdapter: { act: vi.fn(async () => ({ ok: true, message: "ok" })) },
  dropTodo: vi.fn(async () => undefined),
  reopenTodo: vi.fn(async () => undefined),
}));
const ha = vi.hoisted(() => ({ created: [] as Record<string, unknown>[] }));
vi.mock("@/integrations/store", async (orig) => {
  const real = await orig<typeof import("@/integrations/store")>();
  return {
    ...real,
    resolveIntegration: (k: string) => (k === "home_assistant" ? { config: { calendarEntities: "calendar.family" } } : real.resolveIntegration(k as never)),
  };
});
vi.mock("@/integrations/home-assistant/client", () => ({
  haConn: () => ({ baseUrl: "http://ha.test" }),
  HomeAssistantClient: {
    callService: vi.fn(async (_c: unknown, _d: string, _s: string, body: Record<string, unknown>) => {
      ha.created.push(body);
      return [];
    }),
    calendarEvents: vi.fn(async () => ha.created.map((b) => ({ summary: b.summary, start: { dateTime: b.start_date_time } }))),
  },
}));
const gh = vi.hoisted(() => ({ calls: [] as string[], runsDown: false }));
vi.mock("@/server/work/github", async (orig) => {
  const real = await orig<typeof import("@/server/work/github")>();
  return {
    ...real,
    resolveGithubToken: async () => ({ token: "synthetic", source: "env", connectionId: null, backoffKey: "t" }),
    githubGet: async (path: string) => {
      gh.calls.push(path);
      const ok = (body: unknown) => ({ status: 200, headers: new Headers(), body });
      if (path.endsWith("/pulls/7"))
        return ok({
          title: "Grading on V5",
          state: "open",
          draft: false,
          mergeable: true,
          head: { sha: "abc1234", ref: "feat/v5" },
          base: { ref: "main" },
          additions: 412,
          deletions: 96,
          changed_files: 14,
        });
      if (path.includes("/check-runs") && gh.runsDown) return { status: 502, headers: new Headers(), body: null };
      if (path.includes("/check-runs"))
        return ok({
          check_runs: [
            { name: "typecheck", status: "completed", conclusion: "success" },
            { name: "e2e", status: "completed", conclusion: "failure" },
            { name: "visual", status: "in_progress", conclusion: null },
          ],
        });
      if (path.endsWith("/status")) return ok({ statuses: [] });
      if (path.includes("/reviews"))
        return ok([
          { user: { login: "nick" }, state: "APPROVED" },
          { user: { login: "nick" }, state: "COMMENTED" },
        ]);
      if (path.includes("/comments"))
        return ok([
          { user: { login: "chatgpt-codex-connector[bot]" }, in_reply_to_id: null },
          { user: { login: "nick" }, in_reply_to_id: 1 },
        ]);
      return { status: 404, headers: new Headers(), body: null };
    },
  };
});

let owner: string;
const cid = "smart2-test";

function call(handler: unknown, opts: { method?: string; body?: unknown } = {}) {
  const { method = "POST", body } = opts;
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest("http://jarvis.test/api/smart", {
      method,
      headers: { cookie: `jarvis_session=${createSession(owner).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T17:00:00Z")); // Tue Oct 27, 12:00 in Chicago
  __setTestDatabase();
  ha.created = [];
  gh.calls = [];
  gh.runsDown = false;
  __resetPrCache();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
});
afterEach(() => vi.useRealTimers());

async function enable(patch: Record<string, boolean> = { enabled: true }) {
  expect((await call(settingsRoute.PUT, { method: "PUT", body: patch })).status).toBe(200);
}

function seed() {
  const me = resolveUser(new Headers(), createSession(owner).token)!;
  const area = store.createItem(me, { kind: "area", title: "Momentum bets" }, cid);
  const item = store.createItem(me, { kind: "project", title: "Team totals", parentId: area.id, targetDate: "2026-10-27", nextAction: "Pick defaults" }, cid);
  const fin = store.createItem(me, { kind: "area", title: "Finance" }, cid);
  const finItem = store.createItem(me, { kind: "project", title: "Taxes", parentId: fin.id, targetDate: "2026-10-27" }, cid);
  return { me, item, finItem };
}

async function workflow(kind: string, extra: Record<string, unknown> = {}) {
  const r = await call(workflowsRoute.POST, { body: { kind, ...extra } });
  return { status: r.status, body: await r.json() };
}

async function surfaceFor(w: { sessionId: string; spec: JarvisSpec }) {
  return (await (await call(surfacesRoute.PUT, { method: "PUT", body: { sessionId: w.sessionId, blockIndex: 0, spec: w.spec } })).json()) as { id: string };
}

const apply = async (surfaceId: string, intents: Intent[], external?: true) => {
  const r = await call(applyRoute.POST, { body: { surfaceId, intents, idempotencyKey: `k-${Math.random()}`, ...(external ? { external } : {}) } });
  return { status: r.status, body: await r.json() };
};

describe("intent binding for v1.1 components", () => {
  const spec = validateSpec({
    root: "r",
    elements: {
      r: { type: "Stack", props: {}, children: ["c", "w"] },
      c: { type: "ApprovalChips", props: { title: "Today", rows: [{ ref: "todo:a" }, { ref: "item:b" }] } },
      w: { type: "WeekPlan", props: { weekOf: "2026-10-26", blocks: [{ ref: "todo:c", day: "2026-10-28", start: "09:00", minutes: 30 }] } },
    },
  });
  if (!spec.ok) throw new Error("spec");
  const T = "2026-10-27";
  it("brief chips allow only today/tomorrow for their rows", () => {
    expect(intentInSpec(spec.spec, { kind: "todo.snooze", ref: "todo:a", date: T }, T)).toBe(true);
    expect(intentInSpec(spec.spec, { kind: "item.update", ref: "item:b", patch: { targetDate: "2026-10-28" } }, T)).toBe(true);
    expect(intentInSpec(spec.spec, { kind: "todo.snooze", ref: "todo:a", date: "2026-11-05" }, T)).toBe(false);
    expect(intentInSpec(spec.spec, { kind: "todo.complete", ref: "todo:a" }, T)).toBe(false);
    expect(intentInSpec(spec.spec, { kind: "item.update", ref: "item:b", patch: { status: "abandoned" } }, T)).toBe(false);
    expect(chipIntent("todo:a", "skip", T)).toBeUndefined();
    expect(chipIntent("todo:a", "today", T, T)).toBeUndefined();
  });
  it("week blocks move only within the plan's remaining days; calendar blocks only on the grid", () => {
    expect(intentInSpec(spec.spec, { kind: "todo.snooze", ref: "todo:c", date: "2026-10-30" }, T)).toBe(true);
    expect(intentInSpec(spec.spec, { kind: "todo.snooze", ref: "todo:c", date: "2026-10-26" }, T)).toBe(false); // past day
    expect(intentInSpec(spec.spec, { kind: "todo.snooze", ref: "todo:c", date: "2026-11-02" }, T)).toBe(false); // next week
    expect(intentInSpec(spec.spec, { kind: "calendar.block", ref: "todo:c", date: "2026-10-29", start: "10:15", minutes: 30 }, T)).toBe(true);
    expect(intentInSpec(spec.spec, { kind: "calendar.block", ref: "todo:c", date: "2026-10-29", start: "10:10", minutes: 30 }, T)).toBe(false);
    expect(intentInSpec(spec.spec, { kind: "calendar.block", ref: "todo:c", date: "2026-10-29", start: "20:45", minutes: 30 }, T)).toBe(false);
    expect(intentInSpec(spec.spec, { kind: "calendar.block", ref: "todo:a", date: "2026-10-29", start: "10:00", minutes: 30 }, T)).toBe(false);
    expect(blockFits("07:00", 15)).toBe(true);
    expect(planWeekOf("2026-10-31")).toBe("2026-11-02");
    expect(planWeekOf("2026-10-27")).toBe("2026-10-26");
  });
  it("metric, PR and calendar refs are collected for hydration; the model can't type a metric value", () => {
    expect(specRefs(spec.spec)).toContain("cal:week:2026-10-26:5");
    const bad = validateSpec({ root: "g", elements: { g: { type: "Gauge", props: { metric: "metric:ai_spend_today", value: 3, max: 5 } } } });
    expect(bad.ok).toBe(false);
    const unknownMetric = validateSpec({ root: "g", elements: { g: { type: "Sparkline", props: { metric: "metric:net_worth" } } } });
    expect(unknownMetric.ok).toBe(false);
    const pr = validateSpec({ root: "p", elements: { p: { type: "PRCard", props: { ref: "pr:NickBolles/jarvis#7", merge: true } } } });
    expect(pr.ok).toBe(false);
  });
  it("prompt lists the new components and stays within budget", () => {
    const p = smartInstructions();
    for (const n of ["ApprovalChips", "WeekPlan", "PRCard", "Sparkline", "metric:ai_spend_today"]) expect(p).toContain(n);
    expect(p.length).toBeLessThanOrEqual(2560);
  });
});

describe("PR readiness", () => {
  it("counts checks, reviews, conflicts and draft from GitHub's answers", () => {
    expect(checkState("completed", "success")).toBe("pass");
    expect(checkState("queued", null)).toBe("pending");
    const r = readiness({ checks: [{ name: "a", state: "pass" }], reviews: [{ who: "n", state: "approved" }], mergeable: true, draft: false, state: "open" });
    expect(r).toEqual({ done: 4, total: 4, blockers: [] });
    const b = readiness({
      checks: [{ name: "a", state: "fail" }],
      reviews: [{ who: "x", state: "changes_requested" }],
      mergeable: false,
      draft: true,
      state: "open",
    });
    expect(b.done).toBe(0);
    expect(b.blockers).toEqual(["1 failing check", "Changes requested by x", "Merge conflicts", "Draft"]);
  });
});

describe("workflow surfaces (Jarvis-built, flag-gated)", () => {
  it("are refused while Smart replies are off", async () => {
    seed();
    expect((await workflow("brief")).status).toBe(403);
  });

  it("morning brief: rows from Jarvis data (Finance excluded), live metrics, chips stage today/tomorrow and apply", async () => {
    const { item, finItem } = seed();
    await enable();
    const w = await workflow("brief");
    expect(w.status).toBe(200);
    const spec = w.body.spec as JarvisSpec;
    const chips = Object.values(spec.elements).find((e) => e.type === "ApprovalChips")!.props as { rows: { ref: string }[] };
    const refs = chips.rows.map((r) => r.ref);
    expect(refs).toContain(`item:${item.id}`);
    expect(refs).toContain("todo:gt-1");
    expect(refs).not.toContain(`item:${finItem.id}`);
    expect(refs).not.toContain("todo:gt-2"); // due Thursday, not today
    // Same surface on reload (applied state survives); rebuild makes a fresh one only when data changed.
    expect((await workflow("brief")).body.sessionId).toBe(w.body.sessionId);
    const h = await (await call(hydrateRoute.POST, { body: { refs: specRefs(spec) } })).json();
    expect(h.refs["metric:ai_spend_today"]).toMatchObject({ kind: "metric", value: 0, max: 5, unit: "usd" });
    expect(h.refs["metric:items_done_14d"].series).toHaveLength(14);
    const s = await surfaceFor(w.body);
    const ok = await apply(s.id, [{ kind: "todo.snooze", ref: "todo:gt-1", date: "2026-10-28" }]);
    expect(ok.status).toBe(200);
    expect(ok.body.results[0].ok).toBe(true);
    // A date the chips never offer is refused.
    expect((await apply(s.id, [{ kind: "todo.snooze", ref: "todo:gt-1", date: "2026-11-20" }])).status).toBe(400);
  });

  it("week plan: blocks around the calendar; moves stage dates; calendar blocks need their own approval and the sub-flag", async () => {
    const { item } = seed();
    await enable();
    const w = await workflow("week");
    const plan = Object.values(w.body.spec.elements as JarvisSpec["elements"]).find((e) => e.type === "WeekPlan")!.props as {
      weekOf: string;
      blocks: { ref: string; day: string | null; start?: string }[];
    };
    expect(plan.weekOf).toBe("2026-10-26");
    const refs = plan.blocks.map((b) => b.ref);
    expect(refs).toEqual(expect.arrayContaining(["todo:gt-1", "todo:gt-2", `item:${item.id}`]));
    expect(refs).not.toContain("todo:gt-3");
    // Overdue → first plannable day (today); nothing is planned into the past.
    expect(plan.blocks.find((b) => b.ref === "todo:gt-1")!.day).toBe("2026-10-27");
    // Wednesday's dentist (10:00–11:30 local) isn't double-booked.
    const h = await (await call(hydrateRoute.POST, { body: { refs: specRefs(w.body.spec) } })).json();
    expect(h.refs["cal:week:2026-10-26:5"]).toMatchObject({
      kind: "calendar",
      writable: false,
      events: [{ title: "Dentist", day: "2026-10-28", start: "10:00", end: "11:30" }],
    });
    const s = await surfaceFor(w.body);
    expect((await apply(s.id, [{ kind: "todo.snooze", ref: "todo:gt-2", date: "2026-10-30" }])).body.results[0].ok).toBe(true);
    const block: Intent = { kind: "calendar.block", ref: "todo:gt-2", date: "2026-10-30", start: "13:00", minutes: 30 };
    // Never with an ordinary Apply, never mixed, never while the sub-flag is off.
    expect((await apply(s.id, [block])).body.code).toBe("needs_approval");
    expect((await apply(s.id, [{ kind: "todo.snooze", ref: "todo:gt-2", date: "2026-10-29" }, block], true)).body.code).toBe("not_external");
    expect((await apply(s.id, [block], true)).body.code).toBe("calendar_off");
    expect(ha.created).toHaveLength(0);
    await enable({ calendarWrites: true });
    const r = await apply(s.id, [block], true);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ ok: true, message: "Added to the calendar" });
    // Title from Jarvis data, not the client; 13:00 Chicago = 18:00Z.
    expect(ha.created[0]).toMatchObject({ entity_id: "calendar.family", summary: "Renew registration", start_date_time: "2026-10-30T18:00:00.000Z" });
  });

  it("PR card: only PRs linked to your own items hydrate; checks/reviews from GitHub; no write intents", async () => {
    const { me, item, finItem } = seed();
    await enable();
    await store.addLink(me, item.id, { kind: "github_pr", url: "https://github.com/NickBolles/jarvis/pull/7" } as never, cid).catch(() => undefined);
    const w = await workflow("pr", { ref: "pr:NickBolles/jarvis#7" });
    expect(w.status).toBe(200);
    const h = await (await call(hydrateRoute.POST, { body: { refs: ["pr:NickBolles/jarvis#7", "pr:someone/else#9"] } })).json();
    const pr = h.refs["pr:NickBolles/jarvis#7"];
    expect(pr).toMatchObject({ kind: "pr", title: "Grading on V5", number: 7, codexFindings: 1, reviews: [{ who: "nick", state: "approved" }] });
    expect(pr.checks.map((c: { state: string }) => c.state)).toEqual(["pass", "fail", "pending"]);
    expect(pr.readiness.blockers).toEqual(["1 failing check"]);
    expect(h.refs["pr:someone/else#9"]).toEqual({ ref: "pr:someone/else#9", unavailable: "unknown" });
    expect(gh.calls.every((c) => !c.includes("/merge"))).toBe(true);
    // A Finance item's PR never hydrates.
    await store.addLink(me, finItem.id, { kind: "github_pr", url: "https://github.com/NickBolles/taxes/pull/3" } as never, cid).catch(() => undefined);
    const f = await (await call(hydrateRoute.POST, { body: { refs: ["pr:NickBolles/taxes#3"] } })).json();
    expect(f.refs["pr:NickBolles/taxes#3"].unavailable).toBe("finance");
  });

  it("PR card: a check source GitHub didn't return keeps readiness pending", async () => {
    const { me, item } = seed();
    await enable();
    await store.addLink(me, item.id, { kind: "github_pr", url: "https://github.com/NickBolles/jarvis/pull/7" } as never, cid).catch(() => undefined);
    gh.runsDown = true;
    const h = await (await call(hydrateRoute.POST, { body: { refs: ["pr:NickBolles/jarvis#7"] } })).json();
    const pr = h.refs["pr:NickBolles/jarvis#7"];
    expect(pr.checks).toEqual([{ name: "Checks on GitHub", state: "pending", detail: "Couldn't load every check" }]);
    expect(pr.readiness.blockers).toEqual(["1 check running"]);
  });

  it("chat context refs resolve to Jarvis refs, and the composer chip shows a count", async () => {
    seed();
    await enable();
    const me = resolveUser(new Headers(), createSession(owner).token)!;
    const r = resolveContextRefs(me, "@ctx:week_plan\n@ctx:morning_brief");
    expect(r.context).toBeUndefined();
    expect(r.blocks[0]).toContain("WeekPlan weekOf 2026-10-26");
    expect(r.blocks[0]).toContain("Dentist");
    expect(r.blocks[1]).toContain("todo:gt-1 | Return ladder");
    expect(r.blocks[1]).not.toContain("Taxes");
    const counts = await (await call(ctxRoute.GET, { method: "GET" })).json();
    expect(counts.counts["@ctx:overdue_todos"]).toBe(1);
  });
});
