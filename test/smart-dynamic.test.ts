import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createItem, listItems, updateItem } from "@/server/work/store";
import { dynamicCards, isoWeekStart, weeklyReviewWindow } from "@/server/smart/dynamic";
import { approvalQueue } from "@/server/smart/queue";
import { INBOX_REF, saveSmartSettings, saveState, upsertSurface, hydrate, ownedSurface, itemExcluded } from "@/server/smart/store";
import { inboxEntries } from "@/server/work/inbox";
import { applyIntents, undoIntent } from "@/server/smart/apply";
import { formIntents } from "@/lib/jarvis-ui/v2";
import type { PropsOf } from "@/lib/jarvis-ui/catalog";
import { GET } from "@/app/api/smart/dynamic/route";

const snapshots = vi.hoisted(() => ({
  sky: { actions: [] as unknown[], events: [] as unknown[] },
  ha: { actions: [], events: [] as unknown[], homeExceptions: [] as unknown[] },
  allowlist: "",
}));
vi.mock("@/server/sources", () => ({
  adapterContext: (now = new Date()) => ({ timezone: "America/Chicago", now, today: "2026-11-06" }),
  cachedSource: (source: string) => ({ status: { source, state: "ok" }, data: source === "skylight" ? snapshots.sky : snapshots.ha }),
  scopeResult: (_u: unknown, r: unknown) => r,
  refreshSource: vi.fn(async () => undefined),
}));
vi.mock("@/integrations/store", () => ({ resolveIntegration: () => ({ enabled: true, config: { controlAllowlist: snapshots.allowlist } }) }));
let owner: ReturnType<typeof resolveUser>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T19:00:00Z"));
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  saveSmartSettings(id, { enabled: true });
  snapshots.sky.actions = [];
  snapshots.sky.events = [];
  snapshots.ha.events = [];
  snapshots.ha.homeExceptions = [];
  snapshots.allowlist = "";
});
afterEach(() => vi.useRealTimers());
function setup() {
  const area = createItem(owner!, { kind: "area", title: "Iris workshop" }, "test");
  const item = createItem(owner!, { kind: "thread", parentId: area.id, title: "Iris sandpaper", targetDate: "2026-11-01" }, "test");
  const finance = createItem(owner!, { kind: "area", title: "Finance" }, "test");
  updateItem(owner!, finance.id, { settings: { aiPolicy: "excluded" } }, "test");
  createItem(owner!, { kind: "thread", parentId: finance.id, title: "Forbidden money title", targetDate: "2026-11-01" }, "test");
  return { area, item };
}
describe("deterministic owner dynamic cards", () => {
  it("uses ISO Monday boundary and Fri noon through Sunday local window", () => {
    expect(isoWeekStart("2027-01-03")).toBe("2026-12-28");
    expect(weeklyReviewWindow("2026-11-06", 719)).toBe(false);
    expect(weeklyReviewWindow("2026-11-06", 720)).toBe(true);
    expect(weeklyReviewWindow("2026-11-08", 1439)).toBe(true);
    expect(weeklyReviewWindow("2026-11-09", 0)).toBe(false);
  });
  it("weekly form creates -> real local apply -> readback -> persisted done -> undo", async () => {
    const { area } = setup();
    const cards = dynamicCards(owner!).cards;
    const card = cards.find((c) => c.kind === "weekly-review")!;
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).not.toContain("Forbidden money");
    const p = card.spec.elements.r!.props as PropsOf<"Form">;
    const intents = formIntents(p, { rating: 4, parent: `item:${area.id}`, next: "Iris finish jig" });
    expect(intents).toHaveLength(1);
    const surface = upsertSurface(owner!, { sessionId: card.sessionId, blockIndex: 0, spec: card.spec });
    const result = await applyIntents(owner!, { surfaceId: surface.id, intents, idempotencyKey: "iris-weekly-1" }, "test");
    expect(result.results[0]?.ok).toBe(true);
    const created = listItems(owner!.id).find((i) => i.title === "Iris finish jig")!;
    expect(created.parentId).toBe(area.id);
    expect(dynamicCards(owner!).cards.some((c) => c.kind === "weekly-review")).toBe(false);
    await undoIntent(owner!, { surfaceId: surface.id, intentHash: result.results[0]!.intentHash }, "test");
    expect(listItems(owner!.id).some((i) => i.id === created.id)).toBe(false);
    expect(dynamicCards(owner!).cards.some((c) => c.kind === "weekly-review")).toBe(true);
  });
  it("polling the same cards writes no new surface rows (write only on change)", () => {
    setup();
    snapshots.ha.homeExceptions = [{ entityId: "cover.garage_door", state: "open", since: "2026-11-06T17:00:00Z" }];
    const surfaces = () => getDb().select().from(schema.uiSurfaces).all().length;
    expect(dynamicCards(owner!).cards.length).toBeGreaterThan(0);
    const first = surfaces();
    vi.setSystemTime(new Date("2026-11-06T19:01:00Z"));
    dynamicCards(owner!);
    vi.setSystemTime(new Date("2026-11-06T19:02:00Z"));
    dynamicCards(owner!);
    expect(surfaces()).toBe(first);
  });
  it("matrix and Gantt bind at server apply and restore prior values", async () => {
    const { item } = setup();
    const props = {
      title: "Iris route",
      ref: `item:${item.id}`,
      criteria: [
        { id: "speed", label: "Speed", weight: 1 },
        { id: "risk", label: "Risk", weight: 2 },
      ],
      options: [
        { id: "a", label: "Iris route A", scores: { speed: 5, risk: 4 } },
        { id: "b", label: "Iris route B", scores: { speed: 2, risk: 3 } },
      ],
    };
    const spec = { root: "r", elements: { r: { type: "DecisionMatrix", props } } };
    const surface = upsertSurface(owner!, { sessionId: "iris-matrix", blockIndex: 0, spec });
    await expect(
      applyIntents(
        owner!,
        { surfaceId: surface.id, intents: [{ kind: "item.update", ref: props.ref, patch: { nextAction: "Decided: Forged" } }], idempotencyKey: "iris-forged" },
        "test",
      ),
    ).rejects.toMatchObject({ code: "not_offered" });
    const r = await applyIntents(
      owner!,
      {
        surfaceId: surface.id,
        intents: [{ kind: "item.update", ref: props.ref, patch: { nextAction: "Decided: Iris route A" } }],
        idempotencyKey: "iris-matrix-1",
      },
      "test",
    );
    expect(listItems(owner!.id).find((i) => i.id === item.id)?.nextAction).toBe("Decided: Iris route A");
    await undoIntent(owner!, { surfaceId: surface.id, intentHash: r.results[0]!.intentHash }, "test");
    expect(listItems(owner!.id).find((i) => i.id === item.id)?.nextAction).toBe(item.nextAction);
    const gantt = upsertSurface(owner!, {
      sessionId: "iris-gantt",
      blockIndex: 0,
      spec: { root: "r", elements: { r: { type: "Gantt", props: { title: "Iris gantt", rows: [{ ref: props.ref }] } } } },
    });
    const move = await applyIntents(
      owner!,
      { surfaceId: gantt.id, intents: [{ kind: "item.update", ref: props.ref, patch: { targetDate: "2026-11-09" } }], idempotencyKey: "iris-gantt-1" },
      "test",
    );
    expect((await hydrate(owner!, [props.ref]))[props.ref]).toMatchObject({ due: "2026-11-09", createdDate: "2026-11-06" });
    await undoIntent(owner!, { surfaceId: gantt.id, intentHash: move.results[0]!.intentHash }, "test");
    expect(listItems(owner!.id).find((i) => i.id === item.id)?.targetDate).toBe("2026-11-01");
  });
  it("skips absent sources; garage is read-only unless close_cover is allowlisted", () => {
    setup();
    expect(dynamicCards(owner!).cards.map((c) => c.kind)).toEqual(["weekly-review"]);
    snapshots.ha.homeExceptions = [{ entityId: "cover.iris_garage", state: "open", name: "Iris garage", since: "2026-11-06T17:00:00Z" }];
    const readonly = dynamicCards(owner!).cards[0]!;
    expect(readonly.kind).toBe("garage");
    expect(readonly.garage?.closeAllowed).toBe(false);
    snapshots.allowlist = "cover.iris_garage: close_cover";
    const close = dynamicCards(owner!).cards[0]!;
    expect(close.garage).toMatchObject({ closeAllowed: true, undoAllowed: false });
    snapshots.allowlist += ", open_cover";
    expect(dynamicCards(owner!).cards[0]!.garage?.undoAllowed).toBe(true);
  });
  it("finds calendar overlaps with create-only options and counts chores from source", () => {
    setup();
    snapshots.ha.events = [
      { id: "iris-e1", title: "Iris soccer", startsAt: "2026-11-06T21:00:00Z", endsAt: "2026-11-06T22:00:00Z" },
      { id: "iris-e2", title: "Iris dentist", startsAt: "2026-11-06T21:30:00Z", endsAt: "2026-11-06T22:30:00Z" },
    ];
    snapshots.sky.actions = [
      { title: "Iris sweep", status: "completed", skylight: { kind: "chore", completedOn: "2026-11-06" } },
      { title: "Iris bins", status: "open", skylight: { kind: "chore" }, assignee: { kind: "up_for_grabs" } },
    ];
    const cards = dynamicCards(owner!).cards;
    expect(cards.find((c) => c.kind === "chores")?.line.text).toBe("1 of 2 done · 1 up for grabs");
    const conflict = cards.find((c) => c.kind === "calendar-conflict")!;
    const props = conflict.spec.elements.choice!.props as PropsOf<"DecisionCard">;
    expect(props.options.map((o) => o.intent?.kind)).toEqual(["item.create", "item.create"]);
  });
  it("files conflict follow-ups in Inbox, not the arbitrary first area; Apply and Undo are local only", async () => {
    const { area } = setup();
    snapshots.ha.events = [
      { id: "e1", title: "Soccer", startsAt: "2026-11-06T21:00:00Z", endsAt: "2026-11-06T22:00:00Z" },
      { id: "e2", title: "Dentist", startsAt: "2026-11-06T21:30:00Z", endsAt: "2026-11-06T22:30:00Z" },
    ];
    const card = dynamicCards(owner!).cards.find((c) => c.kind === "calendar-conflict")!;
    const props = card.spec.elements.choice!.props as PropsOf<"DecisionCard">;
    expect(props.options.map((o) => (o.intent && "parentRef" in o.intent ? o.intent.parentRef : null))).toEqual([INBOX_REF, INBOX_REF]);
    expect(inboxEntries(owner!.id)).toEqual([]);
    expect((await hydrate(owner!, [INBOX_REF]))[INBOX_REF]).toMatchObject({ title: "Inbox", href: "/inbox" });
    const surface = upsertSurface(owner!, { sessionId: card.sessionId, blockIndex: 0, spec: card.spec });
    saveState(owner!, surface.id, { pending: 1, staged: [["move0", props.options[0]!.intent]] });
    expect(JSON.stringify(approvalQueue(owner!))).toContain(encodeURIComponent(card.id));
    const r = await applyIntents(owner!, { surfaceId: surface.id, intents: [props.options[0]!.intent], idempotencyKey: "conflict-inbox" }, "test");
    expect(r.results[0]?.ok).toBe(true);
    expect(inboxEntries(owner!.id)).toMatchObject([{ title: "Call to move Soccer", source: "capture" }]);
    expect(getDb().select().from(schema.aiJobs).all()).toEqual([]);
    expect(
      listItems(owner!.id)
        .filter((i) => i.parentId === area.id)
        .map((i) => i.title),
    ).toEqual(["Iris sandpaper"]);
    await undoIntent(owner!, { surfaceId: surface.id, intentHash: r.results[0]!.intentHash }, "test");
    expect(inboxEntries(owner!.id)).toEqual([]);
  });
  it("offers conflict captures even with no eligible area", () => {
    snapshots.ha.events = [
      { id: "e1", title: "Soccer", startsAt: "2026-11-06T21:00:00Z", endsAt: "2026-11-06T22:00:00Z" },
      { id: "e2", title: "Dentist", startsAt: "2026-11-06T21:30:00Z", endsAt: "2026-11-06T22:30:00Z" },
    ];
    expect(dynamicCards(owner!).cards.some((c) => c.kind === "calendar-conflict")).toBe(true);
  });
  it.each(["weekly-review", "calendar-conflict", "chores", "garage"] as const)(
    "recovers pending %s snapshots after rollover without rewriting them",
    (kind) => {
      const id = `${kind}:2026-11-06`;
      const spec = { root: "r", elements: { r: { type: "Text", props: { text: "Frozen draft" } } } };
      const surface = upsertSurface(owner!, { sessionId: `dynamic:${id}`, blockIndex: 0, spec });
      saveState(owner!, surface.id, { pending: 1, staged: [["saved", { kind: "item.create", parentRef: INBOX_REF, title: "Call" }]] });
      // A different hash in the same daily session must not shadow the staged one.
      upsertSurface(owner!, {
        sessionId: `dynamic:${id}`,
        blockIndex: 0,
        spec: { root: "r", elements: { r: { type: "Text", props: { text: "New snapshot" } } } },
      });
      vi.setSystemTime(new Date("2026-11-09T19:00:00Z"));
      const before = getDb().select().from(schema.uiSurfaces).all();
      const recovered = dynamicCards(owner!, new Date(), id).cards.find((c) => c.id === id)!;
      expect(recovered.kind).toBe(kind);
      const reopened = upsertSurface(owner!, { sessionId: recovered.sessionId, blockIndex: recovered.blockIndex, spec: recovered.spec });
      expect(reopened.id).toBe(surface.id);
      expect(reopened.state.pending).toBe(1);
      expect(getDb().select().from(schema.uiSurfaces).all()).toEqual(before);
    },
  );
  it("recovers a changed same-day conflict instead of generating a new hash", () => {
    snapshots.ha.events = [
      { id: "e1", title: "Soccer", startsAt: "2026-11-06T21:00:00Z", endsAt: "2026-11-06T22:00:00Z" },
      { id: "e2", title: "Dentist", startsAt: "2026-11-06T21:30:00Z", endsAt: "2026-11-06T22:30:00Z" },
    ];
    const first = dynamicCards(owner!).cards[0]!;
    const surface = upsertSurface(owner!, { sessionId: first.sessionId, blockIndex: 0, spec: first.spec });
    saveState(owner!, surface.id, { pending: 1 });
    snapshots.ha.events = snapshots.ha.events.map((e) => ({ ...(e as object), title: "Changed event" }));
    expect(dynamicCards(owner!, new Date(), first.id).cards.find((c) => c.id === first.id)?.spec).toEqual(first.spec);
    snapshots.ha.events = [];
    expect(dynamicCards(owner!, new Date(), first.id).cards.find((c) => c.id === first.id)?.spec).toEqual(first.spec);
  });
  it("does not resurrect unstaged or newly excluded snapshots", () => {
    const { area } = setup();
    const id = "calendar-conflict:2026-11-05";
    const surface = upsertSurface(owner!, {
      sessionId: `dynamic:${id}`,
      blockIndex: 0,
      spec: {
        root: "r",
        elements: { r: { type: "TaskList", props: { title: "Draft", rows: [{ ref: `item:${area.id}` }] } } },
      },
    });
    expect(dynamicCards(owner!, new Date(), id).cards.some((c) => c.id === id)).toBe(false);
    saveState(owner!, surface.id, { pending: 1 });
    updateItem(owner!, area.id, { settings: { aiPolicy: "excluded" } }, "test");
    expect(dynamicCards(owner!, new Date(), id).cards.some((c) => c.id === id)).toBe(false);
    expect(ownedSurface(owner!.id, surface.id).stateJson).toContain('"pending":1');
  });
  it.each(["not-json", '{"root":"missing","elements":{}}'])("revalidates stored drafts and ignores corrupt specs: %s", (specJson) => {
    const id = "calendar-conflict:2026-11-05";
    const surface = upsertSurface(owner!, {
      sessionId: `dynamic:${id}`,
      blockIndex: 0,
      spec: {
        root: "r",
        elements: { r: { type: "Text", props: { text: "Draft" } } },
      },
    });
    saveState(owner!, surface.id, { pending: 1 });
    getDb().update(schema.uiSurfaces).set({ specJson }).where(eq(schema.uiSurfaces.id, surface.id)).run();
    expect(dynamicCards(owner!, new Date(), id).cards.some((c) => c.id === id)).toBe(false);
    expect(ownedSurface(owner!.id, surface.id).specJson).toBe(specJson);
  });
  it("excludes nested AI-excluded ancestors, but permits Finance inside an allowed root", () => {
    const { area, item } = setup();
    const nested = { ...area, id: "nested", parentId: area.id, settings: { ...area.settings!, aiPolicy: "excluded" as const } };
    const leaf = { ...item, parentId: nested.id };
    const map = new Map([area, nested, leaf].map((i) => [i.id, i]));
    expect(itemExcluded(leaf, map)).toBe(true);
    map.set(nested.id, { ...nested, title: "Finance", settings: null });
    expect(itemExcluded(leaf, map)).toBe(false);
  });
  it("route enforces owner identity, not just admin/capabilities; off is empty", async () => {
    setup();
    const otherId = createPerson({ name: "Other", username: "irisother", role: "admin", passcode: "synthetic-pass" }, owner!.id).id;
    const req = new NextRequest("http://jarvis.test/api/smart/dynamic", { headers: { cookie: `jarvis_session=${createSession(otherId).token}` } });
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    saveSmartSettings(owner!.id, { enabled: false });
    expect(dynamicCards(owner!).cards).toEqual([]);
  });
  it("shows Hermes-mode chores without inventing assignments, and refreshes read-card data", () => {
    setup();
    snapshots.sky.actions = [
      { title: "Iris Hermes sweep", status: "completed", sourceLabel: "Skylight · Chores" },
      { title: "Iris Hermes bins", status: "open", sourceLabel: "Skylight · Chores" },
    ];
    const first = dynamicCards(owner!).cards.find((c) => c.kind === "chores")!;
    expect(first.line.text).toBe("1 of 2 done · assignments unavailable");
    expect(JSON.stringify(first.spec)).toContain("Open · assignment unavailable");
    snapshots.sky.actions = [{ title: "Iris Hermes bins", status: "completed", sourceLabel: "Skylight · Chores" }];
    const next = dynamicCards(owner!).cards.find((c) => c.kind === "chores")!;
    expect(next.line.text).toBe("1 of 1 done · 0 up for grabs");
    expect(next.spec).not.toEqual(first.spec);
  });
  it("queue hydrates owner decisions without AI-excluded areas", () => {
    const { item } = setup();
    updateItem(owner!, item.id, { decision: { question: "Iris next step?", choices: ["a", "b"] } }, "test");
    const queue = approvalQueue(owner!);
    expect(queue).toMatchObject({ kind: "approvals" });
    expect(JSON.stringify(queue)).toContain("Iris sandpaper");
    expect(JSON.stringify(queue)).not.toContain("Forbidden money");
  });
});
