/** Activity timeline: normalisation, day grouping, cursor paging (lib/activity.ts) + server scoping/undo (server/work/activity.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as store from "@/server/work/store";
import { listActivity } from "@/server/work/activity";
import * as activityRoute from "@/app/api/work/activity/route";
import {
  actorFor,
  decodeCursor,
  encodeCursor,
  groupByDay,
  normalizeWorkEvent,
  pageActivity,
  type ActivityItem,
  type ActivityResponse,
  type RawWorkEvent,
} from "@/lib/activity";

const ev = (over: Partial<RawWorkEvent> = {}): RawWorkEvent => ({
  id: "e1",
  itemId: "i1",
  kind: "edit",
  fromStatus: null,
  toStatus: null,
  reason: "Edited title",
  actor: "u1",
  source: null,
  at: "2026-11-01T18:00:00.000Z",
  ...over,
});

const row = (id: string, at: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  at,
  type: "edit",
  actor: { kind: "you", name: "You" },
  verb: "edited",
  object: { id: "i1", title: "Garage" },
  detail: null,
  undoOpId: null,
  ...over,
});

describe("normalizeWorkEvent", () => {
  it("maps kinds to types, verbs and actors", () => {
    const edit = normalizeWorkEvent(ev(), "u1", "Garage door");
    expect(edit).toMatchObject({ id: "ev:e1", type: "edit", verb: "edited title", actor: { kind: "you" }, object: { id: "i1", title: "Garage door" } });
    const st = normalizeWorkEvent(ev({ kind: "status", fromStatus: "ready", toStatus: "in_progress", reason: null }), "u1", "X");
    expect(st.type).toBe("status");
    expect(st.verb).toMatch(/moved to/);
    expect(st.detail).toContain("→");
    expect(normalizeWorkEvent(ev({ kind: "merged", source: "github", actor: "u1" }), "u1", "X")).toMatchObject({ type: "github", actor: { kind: "github" } });
    expect(normalizeWorkEvent(ev({ kind: "created", reason: null }), "u1", null)).toMatchObject({
      type: "created",
      verb: "created",
      object: { title: "Untitled" },
    });
    expect(normalizeWorkEvent(ev({ kind: "archived", reason: null }), "u1", "X")).toMatchObject({ type: "structure", verb: "archived" });
  });

  it("names agents and other people without leaking ids", () => {
    expect(actorFor("agent:momentumchief", null, "u1")).toEqual({ kind: "agent", name: "momentumchief" });
    expect(actorFor("hermes", null, "u1")).toEqual({ kind: "agent", name: "Hermes" });
    expect(actorFor("someone-else-id", null, "u1")).toEqual({ kind: "you", name: "Someone" });
    expect(actorFor("system", null, "u1").kind).toBe("system");
  });
});

describe("groupByDay", () => {
  it("groups sorted rows by local calendar day with Today/Yesterday labels", () => {
    const now = new Date("2026-11-01T18:00:00Z"); // noon CT
    const groups = groupByDay(
      [row("c", "2026-11-01T17:00:00Z"), row("b", "2026-11-01T06:30:00Z"), row("a", "2026-11-01T04:00:00Z"), row("z", "2026-10-20T15:00:00Z")],
      "America/Chicago",
      now,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1], // 04:00Z = 23:00 CT Oct 31
      ["Tue, Oct 20", 1],
    ]);
  });
});

describe("cursor paging", () => {
  it("round-trips the cursor and rejects junk", () => {
    const c = encodeCursor({ at: "2026-11-01T00:00:00.000Z", id: "ev:x" });
    expect(decodeCursor(c)).toEqual({ at: "2026-11-01T00:00:00.000Z", id: "ev:x" });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("pages newest first with stable ties and no duplicates or gaps", () => {
    const all = Array.from({ length: 7 }, (_, i) => row(`r${i}`, i < 4 ? "2026-11-01T10:00:00Z" : `2026-10-2${i}T10:00:00Z`));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: ActivityResponse = pageActivity(all, { cursor, limit: 3 });
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(0, 4)).toEqual(["r3", "r2", "r1", "r0"]);
  });

  it("breaks same-millisecond ties by insertion seq, across pages", () => {
    const at = "2026-11-01T10:00:00.000Z";
    // ids deliberately sort opposite to insertion order
    const all = [
      row("ev:z", at, { seq: 1 }),
      row("ev:y", at, { seq: 2 }),
      row("ev:x", at, { seq: 3 }),
      row("run:q", at),
      row("ev:w", "2026-11-01T09:00:00.000Z", { seq: 4 }),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: ActivityResponse = pageActivity(all, { cursor, limit: 2 });
      seen.push(...p.items.map((i) => i.id));
      expect(p.items.every((i) => !("seq" in i))).toBe(true);
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["ev:x", "ev:y", "ev:z", "run:q", "ev:w"]);
    expect(decodeCursor(encodeCursor({ at, id: "ev:y", seq: 2 }))).toEqual({ at, id: "ev:y", seq: 2 });
  });

  it("filters by type, actor and search words", () => {
    const all = [
      row("a", "2026-11-01T10:00:00Z", { verb: "edited title" }),
      row("b", "2026-11-01T11:00:00Z", { type: "chat", actor: { kind: "agent", name: "Hermes" }, verb: "replied in" }),
    ];
    expect(pageActivity(all, { types: ["chat"] }).items.map((i) => i.id)).toEqual(["b"]);
    expect(pageActivity(all, { actor: "you" }).items.map((i) => i.id)).toEqual(["a"]);
    expect(pageActivity(all, { q: "garage title" }).items.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("listActivity (server)", () => {
  let owner: string, other: string;
  const cid = "test-correlation";
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  });
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;

  it("scopes to the viewer's items, includes a subtree, and offers Undo for the latest edit", () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "Workshop" }, cid);
    const item = store.createItem(u, { kind: "thread", title: "Bench vise", parentId: area.id }, cid);
    store.updateItem(u, item.id, { title: "Bench vise mount" }, cid);
    const own = listActivity(u, { item: item.id });
    const edit = own.items.find((i) => i.type === "edit");
    expect(edit?.undoOpId).toBeTruthy();
    expect(own.items.every((i) => i.object?.id === item.id)).toBe(true);
    const subtree = listActivity(u, { item: area.id, descendants: true });
    expect(subtree.items.some((i) => i.object?.id === item.id)).toBe(true);
    expect(listActivity(u, { item: area.id }).items.some((i) => i.object?.id === item.id)).toBe(false);
    // Another person sees none of it and can't probe the id.
    const o = userOf(other);
    expect(listActivity(o, {}).items.some((i) => i.object?.id === item.id)).toBe(false);
    expect(() => listActivity(o, { item: item.id })).toThrow();
    // After undo the op is spent.
    store.undoOp(u, edit!.undoOpId!, cid);
    expect(listActivity(u, { item: item.id }).items.find((i) => i.id === edit!.id)?.undoOpId).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives Undo to the newest of two quick edits, and it reverts that edit", () => {
    // Frozen clock: with a real clock an event and its op could straddle a millisecond and
    // the closest-time match swapped Undo targets (CI flake); see the follow-up issue.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T08:00:00.000Z"));
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Lathe chuck" }, cid);
    store.updateItem(u, item.id, { title: "Lathe chuck key" }, cid);
    store.updateItem(u, item.id, { summary: "Find the spare key" }, cid);
    const edits = listActivity(u, { item: item.id }).items.filter((i) => i.type === "edit");
    const withUndo = edits.filter((i) => i.undoOpId);
    expect(withUndo).toHaveLength(1);
    expect(withUndo[0].id).toBe(edits[0].id);
    store.undoOp(u, withUndo[0].undoOpId!, cid);
    const after = store.getDetail(u.id, item.id).item;
    expect(after.title).toBe("Lathe chuck key");
    expect(after.summary ?? "").not.toBe("Find the spare key");
  });

  it("pairs each edit with its own op even when every timestamp read moves the clock (#152)", () => {
    // Worst case for the old per-row stamps: each toISOString() is 1 ms later than the last.
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Bandsaw fence" }, cid);
    const real = Date.prototype.toISOString;
    let t = Date.now() + 1000;
    const spy = vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
      return real.call(new Date(Date.UTC(1970, 0, 1, 0, 0, 0, t++)));
    });
    try {
      store.updateItem(u, item.id, { title: "Bandsaw fence rail" }, cid);
      store.updateItem(u, item.id, { summary: "Square it to the blade" }, cid);
      spy.mockRestore();
      // one stamp per mutation: every edit op shares its event's timestamp
      const db = getDb();
      const evAt = db
        .select()
        .from(schema.workEvents)
        .where(eq(schema.workEvents.itemId, item.id))
        .all()
        .filter((e) => e.kind === "edit")
        .map((e) => e.at);
      const opAt = db
        .select()
        .from(schema.workOps)
        .where(eq(schema.workOps.itemId, item.id))
        .all()
        .filter((o) => o.kind === "edit")
        .map((o) => o.createdAt);
      expect(opAt.sort()).toEqual(evAt.sort());
      const edits = listActivity(u, { item: item.id }).items.filter((i) => i.type === "edit");
      const withUndo = edits.filter((i) => i.undoOpId);
      expect(withUndo).toHaveLength(1);
      expect(withUndo[0].id).toBe(edits[0].id);
      store.undoOp(u, withUndo[0].undoOpId!, cid);
      const after = store.getDetail(u.id, item.id).item;
      expect(after.title).toBe("Bandsaw fence rail");
      expect(after.summary ?? "").not.toBe("Square it to the blade");
    } finally {
      spy.mockRestore();
    }
  });

  it("orders same-millisecond edits by insertion, not by their random ids", () => {
    // Freeze the clock so both edits always share one timestamp (the case that used to flake).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T08:00:00.000Z"));
    const u = userOf(owner);
    for (let n = 0; n < 12; n++) {
      const item = store.createItem(u, { kind: "thread", title: `Drill press ${n}` }, cid);
      store.updateItem(u, item.id, { title: `Drill press ${n} table` }, cid);
      store.updateItem(u, item.id, { summary: `Shim the table ${n}` }, cid);
      const edits = listActivity(u, { item: item.id }).items.filter((i) => i.type === "edit");
      expect(edits).toHaveLength(2);
      expect(edits[0].at).toBe(edits[1].at);
      expect(edits[0].verb).toContain("summary");
      expect(edits.map((i) => Boolean(i.undoOpId))).toEqual([true, false]);
      expect(edits.every((i) => !("seq" in i))).toBe(true);
      store.undoOp(u, edits[0].undoOpId!, cid);
      const after = store.getDetail(u.id, item.id).item;
      expect(after.title).toBe(`Drill press ${n} table`);
      expect(after.summary ?? "").not.toBe(`Shim the table ${n}`);
    }
  });

  it("GET /api/work/activity requires a session and honours filters", async () => {
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Lathe belt" }, cid);
    store.updateItem(u, item.id, { summary: "Order a 4L belt" }, cid);
    const req = (q: string, cookie = true) =>
      activityRoute.GET(
        new NextRequest(`http://jarvis.test/api/work/activity${q}`, { headers: cookie ? { cookie: `jarvis_session=${createSession(owner).token}` } : {} }),
        { params: Promise.resolve({}) },
      );
    expect((await req("", false)).status).toBe(401);
    const res = await req(`?item=${item.id}&type=created`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivityResponse;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.type === "created")).toBe(true);
  });
});
