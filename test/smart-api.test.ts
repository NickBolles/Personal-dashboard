import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as store from "@/server/work/store";
import * as settingsRoute from "@/app/api/smart/settings/route";
import * as hydrateRoute from "@/app/api/smart/hydrate/route";
import * as surfacesRoute from "@/app/api/smart/surfaces/route";
import * as stateRoute from "@/app/api/smart/surfaces/[id]/state/route";
import * as applyRoute from "@/app/api/smart/apply/route";
import * as undoRoute from "@/app/api/smart/undo/route";

const TODOS = [
  { id: "todos:gt-1", source: "todos", sourceId: "gt-1", title: "Return ladder", status: "open", dueAt: "2026-10-02T04:59:00.000Z", dueIsDate: true },
  { id: "todos:gt-2", source: "todos", sourceId: "gt-2", title: "Renew registration", status: "open", dueAt: "2026-10-06T04:59:00.000Z", dueIsDate: true },
];

vi.mock("@/server/sources", () => ({
  adapterContext: () => ({ now: new Date(), timezone: "America/Chicago", today: "2026-10-27" }),
  cachedSource: () => ({ status: { source: "todos", state: "ok" }, data: { actions: TODOS } }),
  scopeResult: (_u: unknown, r: unknown) => r,
  refreshSource: vi.fn(async () => undefined),
}));
vi.mock("@/integrations/todos/adapter", () => ({
  todosAdapter: { act: vi.fn(async () => ({ ok: true, message: "ok" })) },
  dropTodo: vi.fn(async () => undefined),
  reopenTodo: vi.fn(async () => undefined),
}));

let owner: string, other: string;
const cid = "smart-test";

function call(handler: unknown, opts: { user?: string; method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const { user = owner, method = "POST", body, params = {} } = opts;
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest("http://jarvis.test/api/smart", {
      method,
      headers: { cookie: `jarvis_session=${createSession(user).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}

const spec = (itemId: string) => ({
  v: 1,
  catalog: "jarvis-ui@1",
  root: "r",
  elements: {
    r: { type: "Stack", props: {}, children: ["a", "b"] },
    a: {
      type: "TaskList",
      props: {
        title: "Overdue",
        rows: [
          { ref: "todo:gt-1", suggestion: "do_week" },
          { ref: "todo:gt-2", suggestion: "drop", reason: "Done already" },
          { ref: `item:${itemId}`, suggestion: "reschedule", suggestedDate: "2026-11-06" },
        ],
      },
    },
    b: { type: "Checklist", props: { title: "Runbook", steps: [{ id: "one", label: "Step one" }] } },
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T17:00:00Z"));
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
});

afterEach(() => vi.useRealTimers());

async function setup() {
  const me = resolveUser(new Headers(), createSession(owner).token)!;
  const area = store.createItem(me, { kind: "area", title: "Momentum bets" }, cid);
  const item = store.createItem(me, { kind: "project", title: "Team totals", parentId: area.id }, cid);
  const fin = store.createItem(me, { kind: "area", title: "Finance" }, cid);
  const finItem = store.createItem(me, { kind: "project", title: "Taxes", parentId: fin.id }, cid);
  expect((await call(settingsRoute.PUT, { method: "PUT", body: { enabled: true } })).status).toBe(200);
  const s = await (await call(surfacesRoute.PUT, { method: "PUT", body: { sessionId: "sess-1", blockIndex: 0, spec: spec(item.id) } })).json();
  return { item, finItem, surfaceId: s.id as string };
}

describe("smart UI API", () => {
  it("is off by default and refuses everything until the person turns it on", async () => {
    expect(await (await call(settingsRoute.GET, { method: "GET" })).json()).toEqual({ enabled: false });
    const r = await call(hydrateRoute.POST, { body: { refs: ["todo:gt-1"] } });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("smart_off");
  });

  it("stores the surface idempotently and hydrates live data (titles never from the model)", async () => {
    const { item, finItem, surfaceId } = await setup();
    const again = await (await call(surfacesRoute.PUT, { method: "PUT", body: { sessionId: "sess-1", blockIndex: 0, spec: spec(item.id) } })).json();
    expect(again.id).toBe(surfaceId);
    const h = await (await call(hydrateRoute.POST, { body: { refs: ["todo:gt-1", `item:${item.id}`, `item:${finItem.id}`, "todo:nope"] } })).json();
    expect(h.refs["todo:gt-1"]).toMatchObject({ title: "Return ladder", due: "2026-10-01", kind: "todo" });
    expect(h.refs[`item:${item.id}`]).toMatchObject({ title: "Team totals", where: "Momentum bets" });
    expect(h.refs[`item:${finItem.id}`]).toEqual({ ref: `item:${finItem.id}`, unavailable: "finance" });
    expect(h.refs["todo:nope"]).toMatchObject({ unavailable: "unknown" });
    const bad = await call(surfacesRoute.PUT, { method: "PUT", body: { sessionId: "s", blockIndex: 0, spec: { root: "x", elements: {} } } });
    expect(bad.status).toBe(400);
  });

  it("applies offered intents with per-intent results, replays idempotently, and undoes", async () => {
    const { todosAdapter, dropTodo, reopenTodo } = await import("@/integrations/todos/adapter");
    const { item, surfaceId } = await setup();
    const intents = [
      { kind: "todo.snooze", ref: "todo:gt-1", date: "2026-10-30" },
      { kind: "todo.drop", ref: "todo:gt-2", note: "Done already" },
      { kind: "item.update", ref: `item:${item.id}`, patch: { targetDate: "2026-11-06" } },
    ];
    const r = await call(applyRoute.POST, { body: { surfaceId, intents, idempotencyKey: `${surfaceId}:1` } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, true]);
    expect(todosAdapter.act!).toHaveBeenCalledWith("gt-1", "snooze", expect.objectContaining({ until: "2026-10-30" }));
    expect(dropTodo).toHaveBeenCalledWith("gt-2", "Done already", expect.anything());
    expect(store.getDetail(owner, item.id).item.targetDate).toBe("2026-11-06");
    // replay: same key → same results, no second write
    vi.mocked(todosAdapter.act!).mockClear();
    const replay = await (await call(applyRoute.POST, { body: { surfaceId, intents, idempotencyKey: `${surfaceId}:1` } })).json();
    expect(replay.results).toHaveLength(3);
    expect(todosAdapter.act!).not.toHaveBeenCalled();
    // undo the item date and the snooze (back to the old due date) and the drop (reopen)
    const [snooze, drop, upd] = body.results as { intentHash: string }[];
    expect((await call(undoRoute.POST, { body: { surfaceId, intentHash: upd!.intentHash } })).status).toBe(200);
    expect(store.getDetail(owner, item.id).item.targetDate).toBeNull();
    await call(undoRoute.POST, { body: { surfaceId, intentHash: snooze!.intentHash } });
    expect(todosAdapter.act!).toHaveBeenLastCalledWith("gt-1", "snooze", expect.objectContaining({ until: "2026-10-01" }));
    await call(undoRoute.POST, { body: { surfaceId, intentHash: drop!.intentHash } });
    expect(reopenTodo).toHaveBeenCalledWith("gt-2", expect.anything());
    expect((await call(undoRoute.POST, { body: { surfaceId, intentHash: drop!.intentHash } })).status).toBe(404);
  });

  it("refuses forged intents (400), Finance (403), settle, and other people's surfaces", async () => {
    const { item, finItem, surfaceId } = await setup();
    const send = (intents: unknown[], user = owner) =>
      call(applyRoute.POST, { user, body: { surfaceId, intents, idempotencyKey: `${surfaceId}:${Math.random()}` } });
    expect((await send([{ kind: "todo.complete", ref: "todo:not-offered" }])).status).toBe(400);
    expect((await send([{ kind: "todo.snooze", ref: "todo:gt-1", date: "2029-01-01" }])).status).toBe(400);
    expect((await send([{ kind: "item.update", ref: `item:${item.id}`, patch: { status: "settled" } }])).status).toBe(400);
    expect((await send([{ kind: "item.create", parentRef: `item:${item.id}`, title: "x" }])).status).toBe(400);
    // Finance: even a spec that offers it is refused at apply
    const finSpec = { root: "a", elements: { a: { type: "TaskList", props: { title: "F", rows: [{ ref: `item:${finItem.id}`, suggestion: "drop" }] } } } };
    const fs = await (await call(surfacesRoute.PUT, { method: "PUT", body: { sessionId: "sess-2", blockIndex: 0, spec: finSpec } })).json();
    const f = await call(applyRoute.POST, {
      body: { surfaceId: fs.id, intents: [{ kind: "item.update", ref: `item:${finItem.id}`, patch: { status: "abandoned" } }], idempotencyKey: "k-finance-1" },
    });
    const fj = await f.clone().json();
    expect([f.status, fj.code]).toEqual([403, "finance_excluded"]);
    expect((await f.json()).code).toBe("finance_excluded");
    expect(store.getDetail(owner, finItem.id).item.status).not.toBe("abandoned");
    // someone else's surface
    await call(settingsRoute.PUT, { user: other, method: "PUT", body: { enabled: true } });
    expect((await send([{ kind: "todo.snooze", ref: "todo:gt-1", date: "2026-10-30" }], other)).status).toBe(404);
  });

  it("saves checklist ticks as surface state (≤ 16 KB) without running anything", async () => {
    const { surfaceId } = await setup();
    const r = await call(stateRoute.PATCH, { method: "PATCH", params: { id: surfaceId }, body: { state: { checks: ["Runbook::one"] } } });
    expect((await r.json()).state).toEqual({ checks: ["Runbook::one"] });
    const big = await call(stateRoute.PATCH, {
      method: "PATCH",
      params: { id: surfaceId },
      body: { state: { checks: Array.from({ length: 200 }, () => "x".repeat(290)) } },
    });
    expect(big.status).toBe(400);
  });
});
