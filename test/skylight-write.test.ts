import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { startMockServer, MOCK_CREDENTIALS } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, userById } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { assertSkylightWritable, runSkylightWrite } from "@/integrations/skylight/write";
import { skylightRequest } from "@/integrations/skylight/adapter";
import { describeSkylightWrite, inverseOf, skylightWriteOp, type SkylightEventFields, type SkylightWriteOp } from "@/lib/skylight-write";
import { recordWrite, undoWrite } from "@/server/skylight-writes";
import { listActivity, __setActivitySourceCap } from "@/server/work/activity";
import { withVia } from "@/server/work/actor";
import { updatePreferences } from "@/server/settings";
import { saveSmartSettings } from "@/server/smart/store";
import { addCalendarBlock, requireCalendarWrites } from "@/server/smart/calendar";
import { POST as postWrite } from "@/app/api/skylight/write/route";
import { POST as postUndo } from "@/app/api/skylight/write/[id]/undo/route";

let server: Server;
let base: string;
let userId: string;
let serial = 0;
const opts = { correlationId: "skylight-write-test" };
const f = "/frames/4418006";
const event: SkylightEventFields = { summary: "Family walk", allDay: false, startsAt: "2026-11-09T08:00:00-06:00", endsAt: "2026-11-09T08:30:00-06:00" };
const previous = { ...event, summary: "Old family walk" };
const chore = { choreId: "55900629", title: "Schedule vet appointment" };
const list = { listId: "7001", listLabel: "Groceries", itemId: "7101", label: "Oat milk" };
const bodyEvent = {
  summary: event.summary,
  description: null,
  all_day: false,
  starts_at: event.startsAt,
  ends_at: event.endsAt,
  timezone: "America/Chicago",
  location: null,
};
const target = { calendar_id: "family-mock@group.calendar.google.com", calendar_account_id: 1344358, source_calendar_id: 4005307 };

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __setTestDatabase();
  userId = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "synthetic-pass" });
  updatePreferences({ timezone: "America/Chicago" });
  saveIntegration("skylight", {
    enabled: true,
    config: { mode: "direct", baseUrl: `${base}/skylight`, frameId: "4418006", members: "13600771" },
    secrets: { refreshToken: MOCK_CREDENTIALS.skylightRefresh },
  });
});
afterAll(() => server?.close());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 9 + serial++, 18)));
  await fetch(`${base}/__mock/reset`, { method: "POST" });
  getDb().delete(schema.skylightWrites).run();
  getDb().delete(schema.sourceCompletions).run();
  saveIntegration("skylight", {
    enabled: true,
    config: { mode: "direct", writes: "true", members: "13600771", eventCalendarId: "", eventCalendarAccountId: "", eventSourceCalendarId: "" },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setActivitySourceCap(2000);
});

async function writes() {
  return (await (await fetch(`${base}/__mock/skylight/writes`)).json()).writes as { method: string; path: string; body: unknown }[];
}
const run = (op: SkylightWriteOp) => runSkylightWrite(op, { id: userId }, opts);
const tick = (ms = 300) => vi.setSystemTime(Date.now() + ms);
const raw = (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => skylightRequest(method, `${f}${path}`, { body });

const cases: [SkylightWriteOp, string, string, unknown][] = [
  [{ op: "chore.complete", ...chore }, "PUT", "/chores/55900629/completions", { status: "complete" }],
  // The assignee (categoryId) is display/undo context only: Skylight 422s "category_id must be blank" when a
  // completion names the member of an assigned chore (prod 2026-11-05).
  [{ op: "chore.reopen", ...chore, categoryId: "13600771" }, "PUT", "/chores/55900629/completions", { status: "pending" }],
  [{ op: "chore.claim", ...chore, fromCategoryId: null }, "PUT", "/chores/55900629", { category_id: 13600771 }],
  [{ op: "chore.assign", ...chore, toCategoryId: null }, "PUT", "/chores/55900629", { category_id: null }],
  [{ op: "list.add", listId: list.listId, listLabel: list.listLabel, label: list.label }, "POST", "/lists/7001/list_items", { label: "Oat milk" }],
  [{ op: "list.remove", ...list }, "DELETE", "/lists/7001/list_items/7101", {}],
  [{ op: "list.check", ...list }, "PUT", "/lists/7001/list_items/7101", { status: "completed" }],
  [{ op: "list.uncheck", ...list }, "PUT", "/lists/7001/list_items/7101", { status: "pending" }],
  [{ op: "event.create", event }, "POST", "/calendar_events", { ...bodyEvent, ...target, invited_emails: [], rrule: null }],
  [{ op: "event.update", eventId: "ev1-1", event, previous }, "PUT", "/calendar_events/ev1-1", bodyEvent],
  [{ op: "event.delete", eventId: "ev1-1", previous }, "DELETE", "/calendar_events/ev1-1", {}],
  [{ op: "chore.skip", ...chore, categoryId: "13600771" }, "PUT", "/chores/55900629/completions", { status: "skipped" }],
  [{ op: "chore.reschedule", ...chore, start: "2026-11-12", previousStart: "2026-11-09" }, "PUT", "/chores/55900629", { start: "2026-11-12" }],
];

describe("exact raw Skylight write contracts", () => {
  it("delete Undo recreates a non-default calendar event on its original calendar, not configured Family", async () => {
    const work = { ...event, calendarId: "work-mock@group.calendar.google.com", calendarAccountId: "1344359", sourceCalendarId: "4005309" };
    saveIntegration("skylight", { config: { eventCalendarId: target.calendar_id, eventCalendarAccountId: "1344358", eventSourceCalendarId: "4005307" } });
    const made = await run(skylightWriteOp.parse({ op: "event.create", event: work }));
    tick();
    const deletion = skylightWriteOp.parse({ op: "event.delete", eventId: made.created.eventId!, previous: work });
    await run(deletion);
    const row = recordWrite(deletion, { id: userId });
    expect(inverseOf(deletion)).toEqual({ op: "event.create", event: work });
    const read = () => skylightRequest<{ data: { id: string; attributes: Record<string, unknown> }[] }>("GET", `${f}/calendar_events`);
    expect((await read()).data.some((e) => e.id === made.created.eventId)).toBe(false);
    tick();
    await undoWrite(row.id, { id: userId }, opts);
    const restored = (await read()).data.find((e) => e.id === "ev-2");
    expect(restored?.attributes).toMatchObject({ ...bodyEvent, calendar_id: work.calendarId, calendar_account_id: 1344359, source_calendar_id: 4005309 });
    expect((await writes())[2].body).toMatchObject({ calendar_id: work.calendarId, calendar_account_id: 1344359, source_calendar_id: 4005309 });
  });
  it.each(cases)("$op", async (op, method, path, body) => {
    const result = await run(op);
    expect(await writes()).toEqual([{ method, path: `/api${f}${path}`, body }]);
    if (op.op === "list.add") expect(result.created.itemId).toBe("8000");
    if (op.op === "event.create") expect(result.created.eventId).toBe("ev-1");
    if (op.op === "chore.claim") expect(result.created.toCategoryId).toBe("13600771");
    // Read back the exact target, including successful deletes.
    if ("listId" in op) {
      const doc = await skylightRequest<{ included: { id: string; attributes: { status: string; label: string } }[] }>("GET", `${f}/lists/${op.listId}`);
      const id = result.created.itemId ?? ("itemId" in op ? op.itemId : "");
      const found = doc.included.find((i) => i.id === id);
      if (op.op === "list.remove") expect(found).toBeUndefined();
      else expect(found?.attributes).toMatchObject({ label: op.label, status: op.op === "list.check" ? "completed" : "pending" });
    } else if ("choreId" in op) {
      const doc = await skylightRequest<{
        data: { id: string; attributes: { status: string }; relationships: { category: { data: { id: string } | null } } }[];
      }>("GET", `${f}/chores`, { query: { after: "2000-01-01", before: "2099-01-01" } });
      const found = doc.data.find((c) => c.id === op.choreId)!;
      if (op.op === "chore.complete" || op.op === "chore.reopen" || op.op === "chore.skip")
        expect(found.attributes.status).toBe({ "chore.complete": "complete", "chore.reopen": "pending", "chore.skip": "skipped" }[op.op]);
      else if (op.op === "chore.reschedule") expect((found.attributes as { start?: string }).start).toBe(op.start);
      else expect(found.relationships.category.data?.id ?? null).toBe(op.op === "chore.claim" ? "13600771" : null);
    } else {
      const doc = await skylightRequest<{ data: { id: string; attributes: { summary: string } }[] }>("GET", `${f}/calendar_events`);
      const found = doc.data.find((e) => e.id === (result.created.eventId ?? ("eventId" in op ? op.eventId : "")));
      if (op.op === "event.delete") expect(found).toBeUndefined();
      else expect(found?.attributes.summary).toBe(op.event.summary);
    }
  });

  it("sends recurring instance fields and an explicit claim/assignment member", async () => {
    const doc = await skylightRequest<{ data: { id: string; attributes: { start: string } }[] }>("GET", `${f}/chores`, {
      query: { after: "2000-01-01", before: "2099-01-01" },
    });
    const recurring = doc.data.find((c) => c.id.includes("-"))!;
    await run({
      op: "chore.complete",
      choreId: recurring.id,
      title: "Recycling",
      instanceDate: recurring.attributes.start,
      instanceTime: "18:00",
      categoryId: "13600771",
    });
    tick();
    await run({ op: "chore.claim", ...chore, fromCategoryId: null, toCategoryId: "13600772" });
    tick();
    await run({ op: "chore.assign", ...chore, toCategoryId: "14463836" });
    // Completions take the BASE id in the path (the mock answers 422 to a composite id).
    expect((await writes())[0].path).toBe(`/api${f}/chores/${recurring.id.split("-")[0]}/completions`);
    tick();
    // An op without explicit instance fields (e.g. an Undo of an older write) parses them from the composite id.
    await run({ op: "chore.reopen", choreId: recurring.id, title: "Recycling" });
    expect((await writes())[3]).toEqual({
      method: "PUT",
      path: `/api${f}/chores/${recurring.id.split("-")[0]}/completions`,
      body: { status: "pending", instance_date: recurring.id.slice(9, 19), instance_time: "18:00" },
    });
    expect((await writes()).slice(0, 3).map((w) => w.body)).toEqual([
      { status: "complete", instance_date: recurring.attributes.start, instance_time: "18:00" },
      { category_id: 13600772 },
      { category_id: 14463836 },
    ]);
  });

  it("completes an overdue recurring occurrence of an assigned chore (prod 2026-11-05 regression)", async () => {
    // Same shape as the prod failure: "<series>-YYYY-MM-DD-0600", three days late, assigned to a member.
    const day = "2026-11-06";
    const id = `88344853-${day}-0600`;
    await fetch(`${base}/__mock/skylight/chores`, {
      method: "POST",
      body: JSON.stringify({ id, summary: "Overdue routine", start: day, start_time: "06:00", category: "13600771" }),
    });
    await run({ op: "chore.complete", choreId: id, title: "Overdue routine", instanceDate: day, instanceTime: "06:00", categoryId: "13600771" });
    expect(await writes()).toEqual([
      { method: "PUT", path: `/api${f}/chores/88344853/completions`, body: { status: "complete", instance_date: day, instance_time: "06:00" } },
    ]);
    tick();
    // The old body (assignee as category_id) is what real Skylight rejects; the strict mock does too, and the
    // reason reaches the caller instead of only the generic message.
    await expect(
      raw("PUT", `/chores/88344853/completions`, { status: "pending", instance_date: day, instance_time: "06:00", category_id: "13600771" }),
    ).rejects.toMatchObject({ status: 422 });
    const failing = { op: "chore.complete" as const, choreId: "55900777", title: "Practice piano", instanceDate: "2026-11-09" };
    await expect(run(failing)).rejects.toMatchObject({ status: 502, code: "skylight_failed", detail: { status: 422, reason: "instance_date must be blank" } });
  });

  it("names the owner only when completing an up-for-grabs chore", async () => {
    await fetch(`${base}/__mock/skylight/chores`, {
      method: "POST",
      body: JSON.stringify({ id: "55901000", summary: "Shared chore", start: "2026-11-09", up_for_grabs: true }),
    });
    await run({ op: "chore.complete", choreId: "55901000", title: "Shared chore", categoryId: null, upForGrabs: true });
    tick();
    await run({ op: "chore.reopen", choreId: "55901000", title: "Shared chore", categoryId: null, upForGrabs: true });
    expect((await writes()).map((w) => w.body)).toEqual([{ status: "complete", category_id: 13600771 }, { status: "pending" }]);
  });

  it("native recurring Skip/Undo uses PUT base completions and restores only the exact dated/timed occurrence", async () => {
    const day = "2026-11-01"; // DST fall-back wall time must not be converted to UTC in the request.
    for (const time of ["01:30", "06:00"]) {
      await fetch(`${base}/__mock/skylight/chores`, {
        method: "POST",
        body: JSON.stringify({ id: `88345000-${day}-${time.replace(":", "")}`, summary: "DST routine", start: day, start_time: time, up_for_grabs: true }),
      });
    }
    const op = skylightWriteOp.parse({
      op: "chore.skip",
      choreId: `88345000-${day}-0130`,
      title: "DST routine",
      instanceDate: day,
      instanceTime: "01:30",
      upForGrabs: true,
      categoryId: "13600771",
    });
    const result = await run(op);
    const row = recordWrite(op, { id: userId }, result.created);
    tick();
    await undoWrite(row.id, { id: userId }, opts);
    expect(await writes()).toEqual([
      { method: "PUT", path: `/api${f}/chores/88345000/completions`, body: { status: "skipped", instance_date: day, instance_time: "01:30" } },
      { method: "PUT", path: `/api${f}/chores/88345000/completions`, body: { status: "pending", instance_date: day, instance_time: "01:30" } },
    ]);
    const read = await skylightRequest<{ data: { id: string; attributes: { status: string; completed_on: string | null } }[] }>("GET", `${f}/chores`, {
      query: { after: day, before: day },
    });
    expect(read.data.find((c) => c.id.endsWith("-0130"))?.attributes).toMatchObject({ status: "pending", completed_on: null });
    expect(read.data.find((c) => c.id.endsWith("-0600"))?.attributes.status).toBe("pending");
  });

  it.each([
    ["POST", "/chores/55900629/completions", { status: "skipped" }],
    ["PUT", "/chores/55900629/skip", { status: "skipped" }],
    ["PUT", "/chores/55900629/completions", { data: { attributes: { status: "skipped" } } }],
    ["PUT", "/chores/55900629/completions", { status: "skipped", category_id: 13600771 }],
    ["PUT", "/chores/55900629/completions", { status: "skipped", instance_time: "06:00" }],
  ] as const)("strict native Skip mock rejects %s %s %j", async (method, path, body) => {
    await expect(raw(method, path, body)).rejects.toBeDefined();
    expect(await writes()).toEqual([]);
  });

  it("refuses to move a recurring occurrence", async () => {
    await expect(
      run({ op: "chore.reschedule", choreId: "55780859-2026-11-09-1800", title: "Recycling", start: "2026-11-12", previousStart: "2026-11-09" }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(await writes()).toHaveLength(0);
  });

  it("uses explicit calendar config, preserves event text, and sends exclusive all-day dates", async () => {
    saveIntegration("skylight", { config: { eventCalendarId: target.calendar_id, eventCalendarAccountId: "1344358", eventSourceCalendarId: "4005307" } });
    await run({
      op: "event.create",
      event: { ...event, allDay: true, startsAt: "2026-11-09", endsAt: "2026-11-10", description: "Family day", location: "Home" },
    });
    expect((await writes())[0].body).toEqual({
      ...bodyEvent,
      ...target,
      all_day: true,
      starts_at: "2026-11-09",
      ends_at: "2026-11-10",
      description: "Family day",
      location: "Home",
      invited_emails: [],
      rrule: null,
    });
  });

  it("discovers a writable Family calendar once, preferring it over another writable calendar", async () => {
    saveIntegration("skylight", { config: { frameId: "discovery-frame" } });
    const real = globalThis.fetch;
    let discoveries = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/source_calendars")) {
        discoveries++;
        return Response.json({
          data: [
            { id: "8", attributes: { name: "Work", writable: true, calendar_id: "work", calendar_account_id: 1 } },
            {
              id: "9",
              attributes: { name: "Family", writable: true, external_id: target.calendar_id },
              relationships: { calendar_account: { data: { id: "1344358" } } },
            },
          ],
        });
      }
      return real(url, init);
    });
    try {
      await run({ op: "event.create", event });
      tick();
      await run({ op: "event.create", event });
      expect(discoveries).toBe(1);
      expect((await writes())[0].body).toMatchObject({ ...target, source_calendar_id: 9 });
    } finally {
      saveIntegration("skylight", { config: { frameId: "4418006" } });
    }
  });

  it("omits target keys when no writable calendars exist", async () => {
    saveIntegration("skylight", { config: { frameId: "no-calendar-frame" } });
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      String(url).endsWith("/source_calendars")
        ? Promise.resolve(Response.json({ data: [{ id: "1", attributes: { name: "Family", read_only: true } }] }))
        : real(url, init),
    );
    try {
      await run({ op: "event.create", event });
      expect((await writes())[0].body).toEqual({ ...bodyEvent, invited_emails: [], rrule: null });
    } finally {
      saveIntegration("skylight", { config: { frameId: "4418006" } });
    }
  });
});

describe("pure inverse operations", () => {
  it.each([cases[0][0], cases[1][0], cases[6][0], cases[7][0], cases[9][0]])("round trips $op", (op) => {
    const inverse = inverseOf(op)!;
    expect(inverseOf(inverse)).toEqual(op);
  });
  it("claim restores its previous assignment; assigning is not independently undoable", () => {
    const op: SkylightWriteOp = { op: "chore.claim", ...chore, fromCategoryId: "14463836" };
    expect(inverseOf(op, { toCategoryId: "13600771" })).toEqual({ op: "chore.assign", ...chore, toCategoryId: "14463836" });
    expect(inverseOf({ op: "chore.assign", ...chore, toCategoryId: null })).toBeNull();
  });
  it("uses created ids and restores removed/deleted contents", () => {
    expect(inverseOf(cases[4][0], { itemId: "new" })).toEqual({ ...list, op: "list.remove", itemId: "new" });
    expect(inverseOf(cases[4][0])).toBeNull();
    expect(inverseOf(cases[5][0])).toEqual(cases[4][0]);
    expect(inverseOf({ op: "event.create", event }, { eventId: "new" })).toEqual({ op: "event.delete", eventId: "new", previous: event });
    expect(inverseOf({ op: "event.create", event })).toBeNull();
    expect(inverseOf({ op: "event.delete", eventId: "old", previous: event })).toEqual({ op: "event.create", event });
  });
});

describe("guards and upstream errors", () => {
  it("rejects disabled, Hermes and read-only connections without writing", async () => {
    saveIntegration("skylight", { enabled: false });
    expect(() => assertSkylightWritable()).toThrow(/Connect Skylight/);
    saveIntegration("skylight", { enabled: true, config: { mode: "hermes" } });
    await expect(run(cases[0][0])).rejects.toMatchObject({ status: 409, code: "hermes_mode" });
    saveIntegration("skylight", { config: { mode: "direct", writes: "false" } });
    await expect(run(cases[0][0])).rejects.toMatchObject({ status: 403, code: "writes_off" });
    expect(await writes()).toHaveLength(0);
  });
  it("refuses recurring claims and missing member selection", async () => {
    await expect(run({ op: "chore.claim", ...chore, choreId: "123-2026-11-09-1800", fromCategoryId: null })).rejects.toMatchObject({
      status: 409,
      code: "recurring",
    });
    saveIntegration("skylight", { config: { members: "" } });
    await expect(run({ op: "chore.claim", ...chore, fromCategoryId: null })).rejects.toMatchObject({ status: 409, code: "pick_member" });
    expect(await writes()).toHaveLength(0);
  });
  it("limits each user to 12 writes in a rolling minute and recovers afterwards", async () => {
    for (let i = 0; i < 12; i++) {
      await run(cases[0][0]);
      tick();
    }
    await expect(run(cases[0][0])).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await writes()).toHaveLength(12);
    await runSkylightWrite(cases[0][0], { id: "another-user" }, opts);
    tick(60_001);
    await expect(run(cases[0][0])).resolves.toBeDefined();
  });
  it("spaces concurrent writes globally, including different users", async () => {
    const real = globalThis.fetch;
    const times: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (init?.method === "PUT") times.push(performance.now());
      return real(url, init);
    });
    await Promise.all([run(cases[0][0]), runSkylightWrite(cases[0][0], { id: "other" }, opts), run(cases[0][0])]);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(240);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(240);
  });
  it("maps 404 and validation failures without exposing upstream details", async () => {
    await expect(run({ op: "list.remove", ...list, itemId: "gone" })).rejects.toMatchObject({ status: 404, code: "gone" });
    tick();
    await expect(run({ op: "event.create", event: { ...event, endsAt: event.startsAt } })).rejects.toMatchObject({ status: 502 });
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      init?.method === "PUT" ? Promise.resolve(Response.json({ secret: "do-not-expose-this" }, { status: 500 })) : real(url, init),
    );
    tick();
    await expect(run(cases[0][0])).rejects.toMatchObject({ status: 502, message: "Couldn't confirm the Skylight change. Refresh before trying again." });
  });
});

describe("persistence, undo and Activity", () => {
  async function recorded() {
    const op = cases[0][0];
    const result = await run(op);
    return recordWrite(op, { id: userId }, result.created);
  }
  it("only lets the same user undo, runs the inverse once, and records a non-undoable undo row", async () => {
    const row = await recorded();
    await expect(undoWrite(row.id, { id: "someone-else" }, opts)).rejects.toMatchObject({ status: 409, code: "not_undoable" });
    tick();
    const undone = await withVia("agent:devchief", () => undoWrite(row.id, { id: userId }, opts));
    expect(undone).toMatchObject({ undoOf: row.id, inverse: null, via: "agent:devchief", op: "chore.reopen" });
    expect(getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, row.id)).get()?.undoneAt).toBeTruthy();
    await expect(undoWrite(row.id, { id: userId }, opts)).rejects.toMatchObject({ code: "not_undoable" });
    await expect(undoWrite(undone.id, { id: userId }, opts)).rejects.toMatchObject({ code: "not_undoable" });
    expect((await writes()).map((w) => w.body)).toEqual([{ status: "complete" }, { status: "pending" }]);
    expect(getDb().select().from(schema.skylightWrites).all()).toHaveLength(2);
    expect(listActivity(userById(userId)!, {}).items.find((i) => i.id === `sw:${undone.id}`)).toMatchObject({
      actor: { kind: "agent", name: "devchief" },
      verb: "undid a Skylight change",
    });
  });
  it("rejects old, missing and inverse-less rows; rejects an overlapping undo", async () => {
    const row = await recorded();
    getDb()
      .update(schema.skylightWrites)
      .set({ at: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString() })
      .where(eq(schema.skylightWrites.id, row.id))
      .run();
    await expect(undoWrite(row.id, { id: userId }, opts)).rejects.toMatchObject({ code: "not_undoable" });
    await expect(undoWrite("missing", { id: userId }, opts)).rejects.toMatchObject({ code: "not_undoable" });
    const noInverse = recordWrite({ op: "chore.assign", ...chore, toCategoryId: null }, { id: userId });
    await expect(undoWrite(noInverse.id, { id: userId }, opts)).rejects.toMatchObject({ code: "not_undoable" });
    tick();
    const fresh = await recorded();
    tick();
    const attempts = await Promise.allSettled([undoWrite(fresh.id, { id: userId }, opts), undoWrite(fresh.id, { id: userId }, opts)]);
    expect(attempts.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
  it("does not mark a failed inverse as undone", async () => {
    const row = recordWrite({ op: "list.add", listId: "7001", listLabel: "Groceries", label: "Gone" }, { id: userId }, { itemId: "gone" });
    await expect(undoWrite(row.id, { id: userId }, opts)).rejects.toMatchObject({ code: "gone" });
    expect(getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, row.id)).get()?.undoneAt).toBeNull();
  });
  it("shows a person's write label and pages ties with the chores filter", () => {
    const op = cases[0][0];
    const row = recordWrite(op, { id: userId });
    recordWrite(op, { id: "another-user" });
    const u = userById(userId)!;
    expect(listActivity(u, {}).items.find((i) => i.id === `sw:${row.id}`)).toMatchObject({
      actor: { kind: "you", name: "You" },
      detail: describeSkylightWrite(op),
      verb: "marked done in Skylight",
      object: null,
      undoOpId: null,
    });
    expect(listActivity(u, { types: ["edit"] }).items.some((i) => i.id.startsWith("sw:"))).toBe(false);
    for (let i = 0; i < 5; i++) recordWrite(op, { id: userId });
    __setActivitySourceCap(2);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = listActivity(u, { limit: 2, cursor });
      ids.push(...page.items.filter((i) => i.id.startsWith("sw:")).map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(listActivity({ ...u, capabilities: new Set() }, {}).items.some((i) => i.id.startsWith("sw:"))).toBe(false);
  });
});

describe("mock strict validation and state", () => {
  it.each([
    ["POST", "/calendar_events", { data: { attributes: bodyEvent } }],
    ["PUT", "/chores/55900629/completions", { status: "completed" }],
    ["PUT", "/chores/55900629/completions", { status: "complete", unexpected: true }],
    ["PUT", "/chores/55900629/completions", { status: "complete", instance_date: "2026-11-09" }],
    ["PUT", "/chores/55900777/completions", { status: "complete", category_id: "13600772" }],
    ["POST", "/lists/7001/list_items", {}],
    ["POST", "/lists/7001/list_items", { label: "" }],
    ["PUT", "/lists/7001/list_items/7101", { status: "complete" }],
    ["PUT", "/chores/55900629", { category_id: "13600771" }],
    ["POST", "/calendar_events", { ...bodyEvent, starts_at: "2026-11-09T08:00:00" }],
    ["POST", "/calendar_events", { ...bodyEvent, ends_at: bodyEvent.starts_at }],
    ["POST", "/calendar_events", { ...bodyEvent, all_day: true }],
    ["POST", "/calendar_events", { ...bodyEvent, calendar_id: "read-only" }],
    ["POST", "/calendar_events", { ...bodyEvent, unexpected: true }],
  ] as const)("rejects invalid %s %s", async (method, path, body) => {
    await expect(raw(method, path, body)).rejects.toMatchObject({ status: 422 });
    expect(await writes()).toHaveLength(0);
  });
  it("rejects duplicate version headers and unauthenticated writes", async () => {
    const r = await fetch(`${base}/skylight/api/frames`, { headers: { "skylight-api-version": "2026-06-01, 2026-06-01" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ errors: ["invalid api version"] });
    const unauth = await fetch(`${base}/skylight/api${f}/lists/7001/list_items`, {
      method: "POST",
      headers: { "skylight-api-version": "2026-06-01", "content-type": "application/json" },
      body: JSON.stringify({ label: "No auth" }),
    });
    expect(unauth.status).toBe(401);
    expect(await writes()).toHaveLength(0);
  });
  it("filters inclusive chore dates, paginates and restores seeds/reset write history", async () => {
    type Chores = {
      data: { id: string; attributes: { start: string; status: string; completed_on: string }; relationships: { category: { data: { id: string } | null } } }[];
      links?: { next: string };
      meta: { total: number };
    };
    const first = await skylightRequest<Chores>("GET", `${f}/chores`, { query: { after: "2000-01-01", before: "2099-01-01", include_late: "true" } });
    expect(first.data).toHaveLength(6);
    expect(first.meta.total).toBe(9);
    const next = new URL(first.links!.next, "http://mock");
    expect(next.searchParams.get("include_late")).toBe("true");
    const second = await skylightRequest<Chores>("GET", next.pathname.replace(/^\/api/, ""), { query: Object.fromEntries(next.searchParams) });
    expect(second.data).toHaveLength(3);
    expect(second.links).toBeUndefined();
    const done = [...first.data, ...second.data].filter((c) => c.attributes.status === "complete");
    expect(done).toHaveLength(3);
    for (const c of done) {
      const doc = await skylightRequest<Chores>("GET", `${f}/chores`, { query: { after: c.attributes.completed_on, before: c.attributes.completed_on } });
      expect(doc.data.some((d) => d.id === c.id)).toBe(true);
      expect(doc.data.every((d) => d.attributes.start === c.attributes.completed_on)).toBe(true);
    }
    await run({ op: "list.remove", ...list });
    expect(await writes()).toHaveLength(1);
    await fetch(`${base}/__mock/reset`, { method: "POST" });
    expect(await writes()).toHaveLength(0);
    const l = await skylightRequest<{ included: { id: string }[] }>("GET", `${f}/lists/7001`);
    expect(l.included.map((i) => i.id)).toContain("7101");
  });
  it("filters events by frame date with an exclusive maximum and persists update/delete", async () => {
    const created = await run({ op: "event.create", event });
    const query = { date_min: "2026-11-09", date_max: "2026-11-10" };
    const read = () => skylightRequest<{ data: { id: string; attributes: { summary: string } }[] }>("GET", `${f}/calendar_events`, { query });
    expect((await read()).data.some((e) => e.id === created.created.eventId)).toBe(true);
    expect(
      (await skylightRequest<{ data: unknown[] }>("GET", `${f}/calendar_events`, { query: { date_min: "2026-11-08", date_max: "2026-11-09" } })).data,
    ).toHaveLength(0);
    tick();
    await run({ op: "event.update", eventId: created.created.eventId!, event: { ...event, summary: "Changed" }, previous: event });
    expect((await read()).data.find((e) => e.id === created.created.eventId)?.attributes.summary).toBe("Changed");
    tick();
    await run({ op: "event.delete", eventId: created.created.eventId!, previous: event });
    expect((await read()).data.some((e) => e.id === created.created.eventId)).toBe(false);
  });
});

async function route(handler: typeof postWrite | typeof postUndo, body?: unknown, id?: string, authenticated = true) {
  return handler(
    new NextRequest("http://jarvis.test/api/skylight/write", {
      method: "POST",
      headers: {
        "x-jarvis-csrf": "1",
        "content-type": "application/json",
        ...(authenticated ? { cookie: `jarvis_session=${createSession(userId).token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve<Record<string, string>>(id ? { id } : {}) },
  );
}

describe("routes and smart family calendar", () => {
  it("enforces authentication/capability/schema and records successful writes, undo and failure audits", async () => {
    expect((await route(postWrite, cases[0][0], undefined, false)).status).toBe(401);
    getDb().update(schema.users).set({ role: "kid" }).where(eq(schema.users.id, userId)).run();
    try {
      expect((await route(postWrite, cases[0][0])).status).toBe(403);
      expect((await route(postUndo, undefined, "missing")).status).toBe(403);
      expect(await writes()).toHaveLength(0);
    } finally {
      getDb().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, userId)).run();
    }
    expect((await route(postWrite, { op: "unknown" })).status).toBe(400);
    const r = await route(postWrite, cases[0][0]);
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result).toMatchObject({ ok: true, message: "Marked done", undoable: true });
    expect(getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, result.writeId)).get()).toBeDefined();
    tick();
    expect((await route(postUndo, undefined, result.writeId)).status).toBe(200);
    expect((await route(postUndo, undefined, result.writeId)).status).toBe(409);
    tick();
    expect((await route(postWrite, { op: "list.remove", ...list, itemId: "gone" })).status).toBe(404);
    const audits = getDb()
      .select()
      .from(schema.auditLog)
      .all()
      .filter((a) => a.action.startsWith("skylight."));
    expect(audits.map((a) => [a.action, a.result])).toEqual([
      ["skylight.write", "ok"],
      ["skylight.undo", "ok"],
      ["skylight.undo", "error"],
      ["skylight.write", "error"],
    ]);
  });
  it("uses Skylight with its own capability/setting, no HA calendar, and records an undoable event", async () => {
    const u = { ...userById(userId)!, capabilities: new Set(["skylight.write", "skylight.view"]) };
    saveSmartSettings(userId, { enabled: true, calendarWrites: false });
    expect(() => requireCalendarWrites(u)).toThrow(/Calendar writes are off/);
    saveSmartSettings(userId, { calendarWrites: true });
    expect(requireCalendarWrites(u)).toBeNull();
    expect(() => requireCalendarWrites({ ...u, capabilities: new Set(["home_assistant.calendar"]) })).toThrow(/access to change Skylight/);
    const result = await addCalendarBlock(
      u,
      { kind: "calendar.block", ref: "todo:test", date: "2026-11-09", start: "08:00", minutes: 30 },
      "Family walk",
      opts.correlationId,
    );
    expect(result.message).toBe("Added to the family calendar");
    expect(result.undo.type).toBe("skylight");
    expect((await writes())[0].body).toMatchObject({
      summary: "Family walk",
      description: "Planned in Jarvis",
      starts_at: "2026-11-09T14:00:00.000Z",
      ends_at: "2026-11-09T14:30:00.000Z",
    });
    if (result.undo.type !== "skylight") throw new Error("Expected Skylight undo");
    const row = getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, result.undo.writeId)).get()!;
    expect(JSON.parse(row.inverse!)).toMatchObject({ op: "event.delete", eventId: "ev-1" });
    tick();
    await undoWrite(row.id, u, opts);
    const doc = await skylightRequest<{ data: { id: string }[] }>("GET", `${f}/calendar_events`);
    expect(doc.data.some((e) => e.id === "ev-1")).toBe(false);
  });
});
