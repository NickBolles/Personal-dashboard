/**
 * Prioritized Home: attention budget, per-person feedback and tuning, saved
 * dates, and the routes behind them (auth, CSRF, ownership, idempotency,
 * size limits, reversible preferences).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import type { SourceData } from "@/integrations/types";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import type { IntegrationKind } from "@/integrations/registry";
import { updatePreferences } from "@/server/settings";
import { adapterContext, compassFocus, refreshSource, setActionPref } from "@/server/sources";
import { loadTuning } from "@/server/home-tuning";
import { DAY, localDate } from "@/lib/time";
import type { HomePayload } from "@/lib/contracts";

import * as homeRoute from "@/app/api/home/route";
import * as actionsRoute from "@/app/api/actions/route";
import { setCapabilities } from "@/server/access";
import * as itemsRoute from "@/app/api/home/items/route";
import * as feedbackRoute from "@/app/api/home/feedback/route";
import * as feedbackIdRoute from "@/app/api/home/feedback/[id]/route";
import * as tuningRoute from "@/app/api/home/tuning/route";
import * as milestonesRoute from "@/app/api/home/milestones/route";
import * as milestoneIdRoute from "@/app/api/home/milestones/[id]/route";

let server: Server;
let base: string;
let owner: string;
let partner: string;
let kid: string;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call<T = Record<string, unknown>>(
  handler: unknown,
  url: string,
  userId: string | null,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; csrf?: boolean } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.csrf !== false) headers["x-jarvis-csrf"] = "1";
  if (userId) headers.cookie = `jarvis_session=${createSession(userId).token}`;
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, body: (await res.json()) as T & { error?: string; code?: string } };
}

const home = (userId: string) => call<HomePayload>(homeRoute.GET, "/api/home?cached=1", userId).then((r) => r.body);
const key = () => `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;

function feedback(userId: string, body: Record<string, unknown>, opts: { csrf?: boolean } = {}) {
  return call(feedbackRoute.POST, "/api/home/feedback", userId, {
    method: "POST",
    csrf: opts.csrf,
    body: { idempotencyKey: key(), provenance: { version: 1, fingerprint: "fp", why: [], sources: [] }, ...body },
  });
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago", onboarding: { completedAt: new Date().toISOString() } });
  for (const [k, p] of Object.entries(demoPresets()!)) saveIntegration(k as IntegrationKind, { enabled: true, config: p!.config, secrets: p!.secrets });
  partner = createPerson({ name: "Sam", username: "sam", role: "adult", passcode: "samsecret1" }, owner).id;
  kid = createPerson({ name: "Ava", username: "ava", role: "kid", passcode: "avasecret1" }, owner).id;
  await fetch(`${base}/__mock/google/tasks`, {
    method: "POST",
    body: JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => ({ title: `Overdue chore ${i}`, dueDays: -(3 + i) })) }),
  });
  for (const s of ["skylight", "home_assistant", "todos", "hermes", "daily_compass", "paperclip"] as const) await refreshSource(s);
});

afterAll(() => server?.close());

beforeEach(async () => {
  await call(tuningRoute.DELETE, "/api/home/tuning", owner, { method: "DELETE", body: { scope: "all" } });
  await call(tuningRoute.DELETE, "/api/home/tuning", partner, { method: "DELETE", body: { scope: "all" } });
});

describe("attention budget on /api/home", () => {
  it("keeps Now ≤ 3, Today ≤ 5, Upcoming preview ≤ 3, with totals that add up", async () => {
    const h = await home(owner);
    const a = h.attention!;
    expect(h.now.length).toBeLessThanOrEqual(a.budget.now + a.overBudget);
    expect(h.later.laterToday.length).toBeLessThanOrEqual(a.budget.today);
    expect(h.later.upcoming.length).toBeLessThanOrEqual(a.budget.upcoming);
    expect(a.totals.now + a.totals.today + a.totals.upcoming + a.totals.backlog).toBe(a.totals.open);
    expect(a.totals.overdue).toBeGreaterThanOrEqual(10);
    // Not every overdue task lands in Now.
    expect(h.now.filter((x) => x.rank?.tier === "overdue_stale")).toHaveLength(0);
    for (const x of [...h.now, ...h.later.laterToday]) expect(x.why?.length).toBeGreaterThan(0);
  });

  it("pages the full ranked list with an honest total", async () => {
    const h = await home(owner);
    const first = await call<{ items: { id: string }[]; total: number; nextOffset?: number }>(itemsRoute.GET, "/api/home/items?bucket=backlog&limit=2", owner);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(h.attention!.totals.backlog);
    expect(first.body.items).toHaveLength(2);
    const second = await call<{ items: { id: string }[] }>(itemsRoute.GET, `/api/home/items?bucket=backlog&limit=2&offset=${first.body.nextOffset}`, owner);
    expect(second.body.items[0]!.id).not.toBe(first.body.items[0]!.id);
    expect((await call(itemsRoute.GET, "/api/home/items?bucket=nope", owner)).status).toBe(400);
    expect((await call(itemsRoute.GET, "/api/home/items?bucket=backlog&limit=500", owner)).status).toBe(400);
  });

  it("offers overdue triage from the real count, and only to people who can see the todos", async () => {
    const triage = (await home(owner)).assists?.find((c) => c.kind === "overdue_triage");
    expect(triage?.body).toMatch(/overdue/);
    expect(triage?.triage?.actionIds.length).toBeGreaterThan(2);
    expect((await home(kid)).assists?.some((c) => c.kind === "overdue_triage")).toBe(false);
  });

  it("a view-only child can see overdue counts but cannot reschedule by calling the action API", async () => {
    setCapabilities(kid, { "todos.view": true, "todos.edit": false }, "kid");
    try {
      const triage = (await home(kid)).assists?.find((c) => c.kind === "overdue_triage");
      expect(triage).toBeDefined();
      expect(triage?.triage).toBeUndefined();
      expect(triage?.chat).toBeUndefined();
      const before = await home(owner);
      const denied = await call(actionsRoute.POST, "/api/actions", kid, {
        method: "POST",
        body: { actionId: "todos:gt-1", kind: "snooze", until: "2026-12-01" },
      });
      expect(denied.status).toBe(403);
      expect((await home(owner)).attention!.totals).toEqual(before.attention!.totals);
    } finally {
      setCapabilities(kid, { "todos.view": false, "todos.edit": false }, "kid");
    }
  });

  it("finance corrections and categories never enter the Hermes tuning brief", async () => {
    await feedback(owner, {
      target: { kind: "action", id: "finance:private", category: "source:finance" },
      verdict: "wrong_assumption",
      correction: "PRIVATE_FINANCIAL_NOTE",
    });
    await call(tuningRoute.PUT, "/api/home/tuning", owner, { method: "PUT", body: { category: "source:finance", weight: -1 } });
    const view = await call<{ hermesBrief: string; feedback: unknown[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    expect(view.body.feedback).toHaveLength(1);
    expect(view.body.hermesBrief).not.toContain("PRIVATE_FINANCIAL_NOTE");
    expect(view.body.hermesBrief).not.toContain("Finance");
  });

  it("Daily Compass focus is reported honestly and only to its owner", async () => {
    expect((await home(owner)).attention!.compass?.state).toBe("no_focus");
    expect((await home(partner)).attention!.compass).toBeUndefined();
  });

  it("Compass focus: stale is labelled, missing is unavailable, another day is outdated, unset is absent", () => {
    const ctx = adapterContext(new Date("2026-10-10T17:00:00Z"));
    const status = (state: string) => ({ source: "daily_compass", label: "Daily Compass", state, fetchedAt: "2026-10-10T16:00:00Z" });
    const compass = (date: string, priorities?: string[]) => ({
      date,
      completed: false,
      inWindow: false,
      windowStart: "19:00",
      windowEnd: "22:00",
      priorities,
    });
    type R = Parameters<typeof compassFocus>[0];
    const r = (state: string, c?: ReturnType<typeof compass>) => ({ status: status(state), data: c ? { actions: [], compass: c } : undefined }) as R;
    expect(compassFocus(r("ok", compass(ctx.today, ["Taxes"])), ctx)).toMatchObject({ state: "focus", focus: ["Taxes"] });
    expect(compassFocus(r("error", compass(ctx.today, ["Taxes"])), ctx)).toMatchObject({ state: "focus", stale: true });
    expect(compassFocus(r("error"), ctx)).toMatchObject({ state: "unavailable", focus: [] });
    expect(compassFocus(r("ok", compass("2026-10-09", ["Old"])), ctx)).toMatchObject({ state: "outdated", focus: [] });
    expect(compassFocus(r("unconfigured"), ctx)).toBeUndefined();
    expect(compassFocus(undefined, ctx)).toBeUndefined();
  });

  it("a failing source never blocks Home and keeps its last-known items counted", async () => {
    const before = (await home(owner)).attention!.totals.open;
    await fetch(`${base}/__mock/fail`, { method: "POST", body: JSON.stringify({ services: ["todos"] }) });
    try {
      await refreshSource("todos");
      const h = await home(owner);
      expect(h.sources.find((s) => s.source === "todos")?.state).toBe("error");
      expect(h.attention!.totals.open).toBe(before);
    } finally {
      await fetch(`${base}/__mock/fail`, { method: "POST", body: JSON.stringify({ restore: ["todos"] }) });
      await refreshSource("todos");
    }
  });
});

describe("saved waiting pins", () => {
  it("round-trips pin and unpin through the action API and refreshed Home payload", async () => {
    const db = getDb();
    const where = eq(schema.sourceSnapshots.source, "todos");
    const original = db.select().from(schema.sourceSnapshots).where(where).get()!.payload!;
    const data = JSON.parse(original) as SourceData;
    data.actions = data.actions.slice(0, 2).map((a) => ({ ...a, status: "waiting", priorityReason: "upcoming" }));
    db.update(schema.sourceSnapshots)
      .set({ payload: JSON.stringify(data) })
      .where(where)
      .run();
    const waiting = (await home(owner)).later.waitingOn;
    expect(waiting).toHaveLength(2);
    const id = waiting.at(-1)!.id;
    try {
      for (const kind of ["pin", "unpin"] as const) {
        expect((await call(actionsRoute.POST, "/api/actions", owner, { method: "POST", body: { actionId: id, kind } })).status).toBe(200);
        const refreshed = (await home(owner)).later.waitingOn;
        expect(Boolean(refreshed.find((a) => a.id === id)?.pinned)).toBe(kind === "pin");
        expect(refreshed.map((a) => a.id)).toEqual((kind === "pin" ? [...waiting].reverse() : waiting).map((a) => a.id));
        expect(loadTuning(owner).pinned.has(id)).toBe(kind === "pin");
        expect(Boolean((await home(partner)).later.waitingOn.find((a) => a.id === id)?.pinned)).toBe(false);
      }
    } finally {
      setActionPref(owner, id, { pinned: false });
      db.update(schema.sourceSnapshots).set({ payload: original }).where(where).run();
    }
  });
});

describe("critical acknowledgement", () => {
  it("persists explicit acknowledgement across refresh without letting feedback suppress safety alerts", async () => {
    const alert = (await home(owner)).now.find((a) => a.source === "home_assistant" && a.priorityReason === "critical");
    expect(alert).toBeDefined();
    const id = alert!.id;
    const target = { kind: "action", id, category: "source:home_assistant" };
    for (const verdict of ["not_now", "less_like_this", "less_like_this", "wrong_assumption"]) {
      expect((await feedback(owner, { target, verdict })).status).toBe(200);
      expect((await home(owner)).now.some((a) => a.id === id)).toBe(true);
    }
    const ack = await call(actionsRoute.POST, "/api/actions", owner, { method: "POST", body: { actionId: id, kind: "acknowledge" } });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ ok: true, message: "Acknowledged" });
    expect((await home(owner)).now.some((a) => a.id === id)).toBe(false);
    expect((await home(partner)).now.some((a) => a.id === id)).toBe(true);
    const acknowledgedUntil = loadTuning(owner).acknowledged.get(id)!;
    expect(new Date(acknowledgedUntil).getTime() - Date.now()).toBeGreaterThan(6 * DAY);
    expect(loadTuning(partner).acknowledged.has(id)).toBe(false);
    const view = await call<{ snoozed: { id: string; until: string }[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    expect(view.body.snoozed.find((s) => s.id === id)?.until).toBe(acknowledgedUntil);
    // Subsequent feedback must not shorten or overwrite explicit acknowledgement.
    await feedback(owner, { target, verdict: "not_now" });
    expect(loadTuning(owner).acknowledged.get(id)).toBe(acknowledgedUntil);
    await refreshSource("home_assistant");
    expect((await home(owner)).now.some((a) => a.id === id)).toBe(false);
    // At expiry the still-critical alert returns even with an active feedback snooze.
    setActionPref(owner, id, { acknowledgedUntil: new Date(Date.now() - 1).toISOString() });
    expect((await home(owner)).now.some((a) => a.id === id)).toBe(true);
    await call(actionsRoute.POST, "/api/actions", owner, { method: "POST", body: { actionId: id, kind: "acknowledge" } });
    await call(tuningRoute.DELETE, "/api/home/tuning", owner, { method: "DELETE", body: { scope: "snooze", target: id } });
    expect((await home(owner)).now.some((a) => a.id === id)).toBe(true);
  });
});

describe("feedback route", () => {
  it("requires a session and the CSRF header", async () => {
    expect((await call(feedbackRoute.POST, "/api/home/feedback", null, { method: "POST", body: {} })).status).toBe(401);
    const r = await feedback(owner, { target: { kind: "action", id: "todos:gt-1", category: "source:todos" }, verdict: "helpful" }, { csrf: false });
    expect(r.status).toBe(403);
  });

  it("rejects oversized corrections and provenance", async () => {
    const target = { kind: "assist", id: "assist:overdue_triage", category: "assist:overdue_triage" };
    expect((await feedback(owner, { target, verdict: "wrong_assumption", correction: "x".repeat(501) })).status).toBe(400);
    const tooMany = { version: 1, fingerprint: "fp", why: Array.from({ length: 7 }, () => "r"), sources: [] };
    expect((await feedback(owner, { target, verdict: "helpful", provenance: tooMany })).status).toBe(400);
    expect((await feedback(owner, { target: { ...target, category: "bad category!" }, verdict: "helpful" })).status).toBe(400);
  });

  it("only accepts feedback about things the person can see", async () => {
    const r = await feedback(kid, { target: { kind: "action", id: "todos:gt-1", category: "source:todos" }, verdict: "less_like_this" });
    expect(r.status).toBe(403);
    const mismatch = await feedback(owner, { target: { kind: "action", id: "todos:gt-1", category: "source:skylight" }, verdict: "less_like_this" });
    expect(mismatch.status).toBe(400);
  });

  it("'less like this' lowers the category weight once per idempotency key, and changes the ranking", async () => {
    const body = { idempotencyKey: key(), target: { kind: "action", id: "todos:gt-2", category: "source:todos" }, verdict: "less_like_this" };
    const send = () =>
      call(feedbackRoute.POST, "/api/home/feedback", owner, {
        method: "POST",
        body: { ...body, provenance: { version: 1, fingerprint: "fp", why: ["Due today"], sources: ["todos"] } },
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const t = await call<{ categories: { category: string; weight: number }[]; feedback: unknown[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    expect(t.body.categories.find((c) => c.category === "source:todos")?.weight).toBe(-1);
    expect(t.body.feedback).toHaveLength(1);

    await feedback(owner, { target: { kind: "action", id: "todos:gt-2", category: "source:todos" }, verdict: "less_like_this" });
    const h = await home(owner);
    const visible = [...h.now, ...h.later.laterToday].filter((x) => x.source === "todos" && x.rank?.tier !== "critical");
    expect(visible).toHaveLength(0);

    // Reversible: reset the category and todos come back.
    const reset = await call(tuningRoute.DELETE, "/api/home/tuning", owner, { method: "DELETE", body: { scope: "category", category: "source:todos" } });
    expect(reset.status).toBe(200);
    const after = await home(owner);
    expect([...after.now, ...after.later.laterToday].some((x) => x.source === "todos")).toBe(true);
  });

  it("weights are per person", async () => {
    await call(tuningRoute.PUT, "/api/home/tuning", owner, { method: "PUT", body: { category: "source:skylight", weight: -2 } });
    const mine = await call<{ categories: { category: string }[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    const theirs = await call<{ categories: { category: string }[] }>(tuningRoute.GET, "/api/home/tuning", partner);
    expect(mine.body.categories.some((c) => c.category === "source:skylight")).toBe(true);
    expect(theirs.body.categories.some((c) => c.category === "source:skylight")).toBe(false);
    expect((await call(tuningRoute.PUT, "/api/home/tuning", owner, { method: "PUT", body: { category: "source:skylight", weight: 3 } })).status).toBe(400);
  });

  it("'not now' snoozes a suggestion until the chosen time; reset brings it back", async () => {
    const until = new Date(Date.now() + DAY).toISOString();
    const r = await feedback(owner, {
      target: { kind: "assist", id: "assist:overdue_triage", category: "assist:overdue_triage" },
      verdict: "not_now",
      snoozeUntil: until,
    });
    expect(r.status).toBe(200);
    expect((await home(owner)).assists?.some((c) => c.id === "assist:overdue_triage")).toBe(false);
    const t = await call<{ snoozed: { id: string }[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    expect(t.body.snoozed.map((s) => s.id)).toContain("assist:overdue_triage");
    await call(tuningRoute.DELETE, "/api/home/tuning", owner, { method: "DELETE", body: { scope: "snoozes" } });
    expect((await home(owner)).assists?.some((c) => c.id === "assist:overdue_triage")).toBe(true);
    // Snoozes are bounded.
    const far = await feedback(owner, {
      target: { kind: "assist", id: "assist:overdue_triage", category: "assist:overdue_triage" },
      verdict: "not_now",
      snoozeUntil: new Date(Date.now() + 200 * DAY).toISOString(),
    });
    expect(far.status).toBe(400);
  });

  it("only the owner can delete a feedback row", async () => {
    await feedback(owner, { target: { kind: "assist", id: "assist:overdue_triage", category: "assist:overdue_triage" }, verdict: "helpful" });
    const t = await call<{ feedback: { id: string }[] }>(tuningRoute.GET, "/api/home/tuning", owner);
    const id = t.body.feedback[0]!.id;
    expect((await call(feedbackIdRoute.DELETE, `/api/home/feedback/${id}`, partner, { method: "DELETE", params: { id } })).status).toBe(404);
    expect((await call(feedbackIdRoute.DELETE, `/api/home/feedback/${id}`, owner, { method: "DELETE", params: { id } })).status).toBe(200);
  });
});

describe("saved dates (milestones)", () => {
  it("drive a private planning card for their owner only", async () => {
    const date = localDate(Date.now() + 30 * DAY, "America/Chicago");
    const created = await call<{ id: string }>(milestonesRoute.POST, "/api/home/milestones", owner, {
      method: "POST",
      body: { title: "Cassidy’s birthday", date, yearly: true, leadDays: 60 },
    });
    expect(created.status).toBe(200);
    const plan = (await home(owner)).assists?.find((c) => c.kind === "plan_ahead");
    expect(plan?.title).toMatch(/Cassidy’s birthday/);
    expect((await home(partner)).assists?.some((c) => c.kind === "plan_ahead")).toBe(false);

    const id = created.body.id;
    expect((await call(milestoneIdRoute.DELETE, `/api/home/milestones/${id}`, partner, { method: "DELETE", params: { id } })).status).toBe(404);
    expect((await call(milestoneIdRoute.DELETE, `/api/home/milestones/${id}`, owner, { method: "DELETE", params: { id } })).status).toBe(200);
    expect((await home(owner)).assists?.some((c) => c.kind === "plan_ahead")).toBe(false);
  });

  it("validates input", async () => {
    const bad = await call(milestonesRoute.POST, "/api/home/milestones", owner, {
      method: "POST",
      body: { title: "", date: "2026-13-01", yearly: true, leadDays: 60 },
    });
    expect(bad.status).toBe(400);
    const noCsrf = await call(milestonesRoute.POST, "/api/home/milestones", owner, {
      method: "POST",
      csrf: false,
      body: { title: "x", date: "2026-12-01", yearly: true, leadDays: 60 },
    });
    expect(noCsrf.status).toBe(403);
  });
});
