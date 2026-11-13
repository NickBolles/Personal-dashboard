import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startMockServer, MOCK_CREDENTIALS } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, userById } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { updatePreferences } from "@/server/settings";
import { getAiSettings, saveAiSettings } from "@/server/ai/settings";
import { createItem } from "@/server/work/store";
import { answerDecisionRef } from "@/server/work/decision-store";
import { hooks } from "@/server/hooks";
import { applyPlannedTriage, applySuggestion, backfillCaptureTriage, registerCaptureTriage, retryTriage, undoTriage } from "@/server/capture/triage";
import { triageForItem, triageViewsForInbox } from "@/server/capture/triage-views";
import { inboxEntries } from "@/server/work/inbox";
import { DEFAULT_CAPTURE_ACTIONS, decideTriage, pickList, stripRouting, triageActionSchema, type CaptureActionSettings } from "@/lib/capture-triage";
import { triageOutput } from "@/lib/ai";

const LISTS = [
  { id: "7001", label: "Groceries", kind: "shopping" },
  { id: "7002", label: "House projects", kind: "to_do" },
];
const S = DEFAULT_CAPTURE_ACTIONS;
const act = (a: Record<string, unknown>) => triageActionSchema.parse(a);
const ctx = (over: Partial<{ settings: CaptureActionSettings; backfill: boolean; chosen: boolean; title: string }> = {}) => ({
  settings: S,
  lists: LISTS,
  title: over.title ?? "add milk to grocery",
  text: over.title ?? "add milk to grocery",
  ...over,
});

describe("capture triage contract (pure)", () => {
  it("validates and clips model output; unknown types are risky 'other'", () => {
    const a = act({
      type: "teleport",
      confidence: 7,
      label: "x".repeat(500),
      event: { summary: "Dentist", date: "next tuesday", time: "25:00" },
      missing: "date",
    });
    expect(a.type).toBe("other");
    expect(a.confidence).toBe(0);
    expect(a.label!.length).toBe(200);
    expect(a.event).toMatchObject({ date: null, time: null });
    expect(a.missing).toEqual([]);
    // the whole triage output keeps working without an action (triage@1 answers)
    expect(triageOutput.parse({ title: "t" }).action).toBeNull();
    expect(triageOutput.parse({ title: "t", action: "garbage" }).action).toBeNull();
  });

  it("auto-handles a confident, allowed, low-risk Skylight list add (grocery by name)", () => {
    const out = decideTriage(act({ type: "skylight_list_add", confidence: 0.9, label: "Milk", listId: null }), ctx());
    expect(out).toEqual({ kind: "auto", action: { type: "skylight_list_add", listId: "7001", listLabel: "Groceries", label: "Milk" } });
    expect(pickList(LISTS, "nope", "Replace key battery")?.label).toBe("House projects");
    expect(stripRouting("Add Replace key batter on skylight")).toBe("Replace key batter");
  });

  it("gates: risky → suggest, low confidence / not allowed / triage-only / back-fill → suggest, off → skip", () => {
    expect(decideTriage(act({ type: "ha_device", confidence: 1, summary: "Open the garage" }), ctx()).kind).toBe("suggest");
    expect(decideTriage(act({ type: "ha_device", confidence: 1 }), ctx({ chosen: true })).kind).toBe("suggest"); // never, even when picked
    const list = act({ type: "skylight_list_add", confidence: 0.6, label: "Milk" });
    expect(decideTriage(list, ctx())).toMatchObject({ kind: "suggest", reason: "low_confidence" });
    const sure = act({ type: "skylight_list_add", confidence: 0.95, label: "Milk" });
    expect(decideTriage(sure, ctx({ settings: { ...S, mode: "triage_only" } }))).toMatchObject({ kind: "suggest", reason: "triage_only" });
    expect(decideTriage(sure, ctx({ settings: { ...S, allow: { ...S.allow, skylightList: false } } }))).toMatchObject({
      kind: "suggest",
      reason: "not_allowed",
    });
    expect(decideTriage(sure, ctx({ settings: { ...S, autoHandle: false } }))).toEqual({ kind: "skip", reason: "off" });
    expect(decideTriage(sure, ctx({ backfill: true }))).toMatchObject({ kind: "suggest", reason: "backfill" });
    expect(decideTriage(sure, ctx({ backfill: true, title: "Add milk on skylight" })).kind).toBe("auto");
    // triage-only never creates a D-n either
    const appt = act({ type: "skylight_event_create", confidence: 0.9, event: { summary: "Dentist" }, missing: ["time"] });
    expect(decideTriage(appt, ctx({ settings: { ...S, mode: "triage_only" } }))).toMatchObject({ kind: "suggest", reason: "triage_only" });
    // the owner's explicit pick overrides mode/allowlist/confidence
    expect(decideTriage(list, ctx({ chosen: true, settings: { ...S, mode: "triage_only" } })).kind).toBe("auto");
    expect(decideTriage(act({ type: "note" }), ctx()).kind).toBe("file");
  });

  it("an appointment without a date/time needs input: one question, sensible choices, never a guessed date", () => {
    const out = decideTriage(
      act({ type: "skylight_event_create", confidence: 0.9, event: { summary: "Dentist appointment" }, missing: ["date", "time"] }),
      ctx({ title: "dentist appointment" }),
    );
    expect(out.kind).toBe("needs_input");
    if (out.kind !== "needs_input") return;
    expect(out.question).toMatch(/date and time/);
    expect(out.choices.map((c) => c.action?.type)).toEqual(["skylight_list_add", "jarvis_task"]);
    expect(out.choices[0]!.action).toMatchObject({ listId: "7002", label: "Dentist appointment" });
    expect(out.choices.some((c) => c.action?.type === "skylight_event_create")).toBe(false);
    // with a date and time it is done directly
    const timed = decideTriage(
      act({ type: "skylight_event_create", confidence: 0.9, event: { summary: "Dentist", date: "2026-11-20", time: "14:30" } }),
      ctx(),
    );
    expect(timed).toMatchObject({ kind: "auto", action: { type: "skylight_event_create", date: "2026-11-20", time: "14:30", durationMinutes: 60 } });
  });
});

// --- Server: the applier against the strict Skylight mock (never real Skylight) ---

let server: Server;
let base: string;
let userId: string;

const user = () => userById(userId)!;
async function writes() {
  return (await (await fetch(`${base}/__mock/skylight/writes`)).json()).writes as { method: string; path: string; body: unknown }[];
}
function capture(title: string, extra: Partial<typeof schema.workInbox.$inferInsert> = {}) {
  const id = `inb_${Math.random().toString(36).slice(2, 12)}`;
  getDb()
    .insert(schema.workInbox)
    .values({ id, userId, source: "capture", title, note: "", reason: "You captured it", channel: "web", triageState: "done", ...extra })
    .run();
  return id;
}
function plan(inboxId: string, action: Record<string, unknown> | null, extra: Partial<typeof schema.captureTriage.$inferInsert> = {}) {
  const id = `ctr_${Math.random().toString(36).slice(2, 12)}`;
  getDb()
    .insert(schema.captureTriage)
    .values({ id, userId, inboxId, state: "planned", planJson: JSON.stringify(action), profile: "chiefofstaff", ...extra })
    .run();
  return id;
}
const row = (id: string) => getDb().select().from(schema.captureTriage).where(eq(schema.captureTriage.id, id)).get()!;
const item = (id: string) => getDb().select().from(schema.workItems).where(eq(schema.workItems.id, id)).get()!;

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __setTestDatabase();
  userId = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "synthetic-pass" });
  updatePreferences({ timezone: "America/Chicago" });
  saveAiSettings({ enabled: true });
  saveIntegration("skylight", {
    enabled: true,
    config: { mode: "direct", baseUrl: `${base}/skylight`, frameId: "4418006", members: "13600771", writes: "true" },
    secrets: { refreshToken: MOCK_CREDENTIALS.skylightRefresh },
  });
  getDb()
    .insert(schema.sourceSnapshots)
    .values({ source: "skylight", state: "ok", payload: JSON.stringify({ extra: { lists: LISTS } }) })
    .run();
  registerCaptureTriage(() => undefined);
  hooks().triagePlanned = null; // tests drive the applier explicitly
});
afterAll(() => server?.close());
beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST" });
});

describe("capture triage applier", () => {
  it("'add milk to grocery' → exact Skylight list write, ready-to-settle item with Undo, R-n run, never settled; idempotent", async () => {
    const inboxId = capture("add milk to grocery");
    const id = plan(inboxId, { type: "skylight_list_add", confidence: 0.92, label: "Milk", listId: "7001", summary: "Add Milk to Groceries" });
    await applyPlannedTriage();
    const w = await writes();
    expect(w).toEqual([{ method: "POST", path: "/api/frames/4418006/lists/7001/list_items", body: { label: "Milk" } }]);
    const r = row(id);
    expect(r.state).toBe("done");
    expect(r.summary).toBe("Done: added “Milk” to Groceries on Skylight.");
    const it = item(r.itemId!);
    expect(it.status).toBe("ready_to_settle");
    expect(it.title).toBe("Milk");
    expect(it.createdVia).toBe("agent:chiefofstaff");
    const entry = getDb().select().from(schema.workInbox).where(eq(schema.workInbox.id, inboxId)).get()!;
    expect(entry.acceptedItemId).toBe(r.itemId);
    const view = triageForItem(userId, r.itemId!)!;
    expect(view).toMatchObject({ state: "done", undoable: true, openHref: "/skylight" });
    expect(view.runRef).toMatch(/^R-\d+$/);
    const run = getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.runId!)).get()!;
    expect(run).toMatchObject({ state: "done", itemId: r.itemId, profile: "chiefofstaff" });
    expect(getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, r.skylightWriteId!)).get()!.via).toBe("agent:chiefofstaff");
    // a second pass (or a duplicate plan) never writes again
    await applyPlannedTriage();
    expect((await writes()).length).toBe(1);
    expect(() => plan(inboxId, { type: "skylight_list_add", confidence: 1, label: "Milk" })).toThrow();
    // Undo removes the Skylight item and puts the capture item back to captured (not settled, not deleted)
    const undone = await undoTriage(user(), id, "t");
    expect(undone.state).toBe("undone");
    expect((await writes()).at(-1)).toMatchObject({ method: "DELETE", path: expect.stringMatching(/^\/api\/frames\/4418006\/lists\/7001\/list_items\/\d+$/) });
    expect(item(r.itemId!).status).toBe("captured");
    await expect(undoTriage(user(), id, "t")).rejects.toMatchObject({ code: "not_undoable" });
    expect(
      getDb()
        .select()
        .from(schema.workItems)
        .all()
        .some((i) => i.status === "settled"),
    ).toBe(false);
  });

  it("'dentist appointment' without a time → one D-n with choices; answering runs the chosen choice", async () => {
    const inboxId = capture("Add Schedule dentist appt to skylight");
    const id = plan(inboxId, { type: "skylight_event_create", confidence: 0.9, event: { summary: "Dentist appointment" }, missing: ["date", "time"] });
    await applyPlannedTriage();
    const r = row(id);
    expect(r.state).toBe("needs_input");
    expect((await writes()).length).toBe(0);
    const d = getDb().select().from(schema.decisions).where(eq(schema.decisions.id, r.decisionId!)).get()!;
    const choices = JSON.parse(d.choicesJson) as string[];
    expect(choices).toEqual(["Add “Dentist appointment” to House projects on Skylight", "Just keep it as a Jarvis to-do"]);
    expect(d.raisedBy).toBe("agent:chiefofstaff");
    expect(triageForItem(userId, r.itemId!)!.decisionRef).toBe(`D-${d.seq}`);
    // owner answers → the hook replans with the chosen action → list add → ready to settle
    answerDecisionRef(userId, `D-${d.seq}`, choices[0]!, "item", "t");
    expect(row(id).state).toBe("planned");
    await applyPlannedTriage();
    expect(await writes()).toEqual([{ method: "POST", path: "/api/frames/4418006/lists/7002/list_items", body: { label: "Dentist appointment" } }]);
    expect(row(id).state).toBe("done");
    expect(item(r.itemId!).status).toBe("ready_to_settle");
  });

  it("an appointment WITH a date/time creates the calendar event with the existing event shape", async () => {
    const inboxId = capture("dentist tue nov 17 2:30pm on skylight");
    const id = plan(inboxId, {
      type: "skylight_event_create",
      confidence: 0.9,
      event: { summary: "Dentist", date: "2026-11-17", time: "14:30", durationMinutes: 45 },
    });
    await applyPlannedTriage();
    expect(row(id).state).toBe("done");
    const w = (await writes()).find((x) => x.path.endsWith("/calendar_events"))!;
    expect(w.body).toMatchObject({
      summary: "Dentist",
      all_day: false,
      starts_at: "2026-11-17T20:30:00.000Z",
      ends_at: "2026-11-17T21:15:00.000Z",
      timezone: "America/Chicago",
      rrule: null,
    });
  });

  it("'open garage' is only suggested: no write, no item; Do it refuses risky types", async () => {
    const inboxId = capture("open garage");
    const id = plan(inboxId, { type: "ha_device", confidence: 0.99, summary: "Open the garage door" });
    await applyPlannedTriage();
    const r = row(id);
    expect(r).toMatchObject({ state: "suggested", itemId: null });
    expect(r.summary).toMatch(/^Suggested: Open the garage door\. Jarvis only suggests this/);
    expect((await writes()).length).toBe(0);
    expect(() => applySuggestion(user(), id)).toThrow(/can't do this one/);
    const views = triageViewsForInbox(userId, [{ id: inboxId, triageState: "done", updatedAt: "" }]);
    expect(views.get(inboxId)).toMatchObject({ state: "suggested", canApply: false });
    expect(inboxEntries(userId).find((e) => e.id === inboxId)!.capture!.triage).toMatchObject({ state: "suggested" });
  });

  it("back-fill honours capture AI opt-outs: global 'Nothing' and per-capture skips are never queued", () => {
    const db = getDb();
    const resetKey = () => db.delete(schema.settings).where(eq(schema.settings.key, "capture_triage:backfill:v1")).run();
    const optedOut = capture("Add batteries on skylight (opted out)", { triageState: "skipped", triageSkipReason: "off" });
    const normal = capture("Add light bulbs on skylight");
    const state = (id: string) => db.select().from(schema.workInbox).where(eq(schema.workInbox.id, id)).get()!.triageState;
    resetKey();
    const ai = getAiSettings();
    saveAiSettings({ capture: { ...ai.capture, auto: "off" } });
    try {
      expect(backfillCaptureTriage()).toEqual({ queued: 0 });
      expect(state(normal)).toBe("done");
    } finally {
      saveAiSettings({ capture: ai.capture });
    }
    resetKey();
    const out = backfillCaptureTriage();
    expect(out.queued).toBeGreaterThanOrEqual(1);
    expect(state(optedOut)).toBe("skipped");
    expect(state(normal)).toBe("queued");
  });

  it("back-fill acts only on captures that name Skylight; the rest are suggestions with Do it", async () => {
    const named = capture("Add Replace key batter on skylight");
    const a = plan(named, { type: "skylight_list_add", confidence: 0.9, label: "Replace key battery", listId: "7002" }, { backfill: true });
    const other = capture("buy eggs");
    const b = plan(other, { type: "skylight_list_add", confidence: 0.9, label: "Eggs", listId: "7001" }, { backfill: true });
    await applyPlannedTriage();
    expect(row(a).state).toBe("done");
    expect(row(b)).toMatchObject({ state: "suggested" });
    expect((await writes()).map((w) => w.body)).toEqual([{ label: "Replace key battery" }]);
    expect(applySuggestion(user(), b).state).toBe("planned");
    await applyPlannedTriage();
    expect(row(b).state).toBe("done");
  });

  it("honours Exclude from AI, the 12 writes/min budget, failures + Retry, and settings off", async () => {
    // excluded area: a capture filed straight into it is left alone
    const area = createItem(user(), { kind: "area", title: "Private stuff" }, "t");
    getDb()
      .update(schema.workItems)
      .set({ settings: JSON.stringify({ aiPolicy: "excluded" }) })
      .where(eq(schema.workItems.id, area.id))
      .run();
    const ex = capture("add milk on skylight", { acceptedItemId: area.id, acceptedAt: new Date().toISOString() });
    const e1 = plan(ex, { type: "skylight_list_add", confidence: 1, label: "Milk", listId: "7001" });
    // rate limit: a full budget makes the row wait instead of failing
    const { runSkylightWrite } = await import("@/integrations/skylight/write");
    const filler: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++)
      filler.push(
        runSkylightWrite({ op: "list.add", listId: "7001", listLabel: "Groceries", label: `x${i}` }, { id: userId }, { correlationId: "t" }).catch(
          () => undefined,
        ),
      );
    await Promise.all(filler);
    const rl = capture("add bread to grocery");
    const e2 = plan(rl, { type: "skylight_list_add", confidence: 1, label: "Bread", listId: "7001" });
    await applyPlannedTriage();
    expect(row(e1).state).toBe("skipped");
    expect(row(e2)).toMatchObject({ state: "planned", errorCode: "rate_limited" });
    // Skylight down → failed with Retry; Retry re-plans the stored action
    saveIntegration("skylight", { enabled: true, config: { writes: "false" } });
    getDb()
      .update(schema.captureTriage)
      .set({ notBefore: new Date(0).toISOString() })
      .where(eq(schema.captureTriage.id, e2))
      .run();
    await applyPlannedTriage();
    expect(row(e2)).toMatchObject({ state: "failed", errorCode: "writes_off" });
    expect(triageViewsForInbox(userId, [{ id: rl, triageState: "done", updatedAt: "" }]).get(rl)).toMatchObject({ state: "failed" });
    saveIntegration("skylight", { enabled: true, config: { writes: "true" } });
    expect(retryTriage(user(), e2, "t").state).toBe("planned");
    // the global AI switch stops the applier: planned rows wait
    saveAiSettings({ enabled: false });
    expect(await applyPlannedTriage()).toBe(0);
    expect(row(e2).state).toBe("planned");
    saveAiSettings({ enabled: true });
    // auto-handle off → left as captured
    saveAiSettings({ capture: { auto: "triage_and_investigate", investigateMinConfidence: 0.6, stripLocation: false, actions: { ...S, autoHandle: false } } });
    const off = capture("add jam to grocery");
    const e3 = plan(off, { type: "skylight_list_add", confidence: 1, label: "Jam", listId: "7001" });
    getDb().update(schema.captureTriage).set({ state: "failed" }).where(eq(schema.captureTriage.id, e2)).run();
    await applyPlannedTriage();
    expect(row(e3).state).toBe("skipped");
    saveAiSettings({ capture: { auto: "triage_and_investigate", investigateMinConfidence: 0.6, stripLocation: false, actions: S } });
  });
});
