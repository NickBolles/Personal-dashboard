import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createPathSchema, defaultChildKind, isContainer, parseQuickPath, itemPrimary, primaryAction, rollup, type WorkItem } from "@/lib/work";
import * as store from "@/server/work/store";
import * as pathRoute from "@/app/api/work/items/path/route";

/** Areas structure: quick add with paths, container vs work rules, rollups and the primary action. */

let owner: string, other: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const them = () => resolveUser(new Headers(), createSession(other).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
});

describe("parseQuickPath", () => {
  it("splits on spaced slashes only", () => {
    expect(parseQuickPath("Momentum bets / V5 evaluator / hydration fix")).toEqual(["Momentum bets", "V5 evaluator", "hydration fix"]);
    expect(parseQuickPath("Fix CI/CD flake")).toEqual(["Fix CI/CD flake"]);
    expect(parseQuickPath("  a  /   / b ")).toEqual(["a", "b"]);
    expect(parseQuickPath("a / b / c / d / e / f / g")).toHaveLength(6);
    expect(parseQuickPath("   ")).toEqual([]);
  });
});

describe("node types", () => {
  it("areas and projects are containers; threads, notes and chats are work", () => {
    expect(isContainer({ kind: "area", parentId: null })).toBe(true);
    expect(isContainer({ kind: "project", parentId: "x" })).toBe(true);
    expect(isContainer({ kind: "thread", parentId: null })).toBe(true); // anything at the top acts as an area
    expect(isContainer({ kind: "thread", parentId: "x" })).toBe(false);
    expect(isContainer({ kind: "conversation", parentId: "x" })).toBe(false);
  });
  it("default child kinds: area → project → thread", () => {
    expect(defaultChildKind(null)).toBe("area");
    expect(defaultChildKind({ kind: "area", parentId: null })).toBe("project");
    expect(defaultChildKind({ kind: "project", parentId: "a" })).toBe("thread");
    expect(defaultChildKind({ kind: "thread", parentId: "p" })).toBe("thread");
  });
});

describe("primaryAction", () => {
  const d = (status: string, extra: Partial<{ packets: unknown[]; validations: { status: string }[]; kind: string; sessionId: string | null }> = {}) => ({
    item: { kind: (extra.kind ?? "thread") as WorkItem["kind"], status: status as WorkItem["status"], sessionId: extra.sessionId ?? null },
    packets: extra.packets ?? [],
    validations: extra.validations ?? [],
  });
  it("picks one action from state", () => {
    expect(primaryAction(d("captured"), true)).toBe("packet");
    expect(primaryAction(d("in_progress", { packets: [{}] }), true)).toBe("continue");
    expect(primaryAction(d("in_progress", { packets: [{}] }), false)).toBe("packet");
    expect(primaryAction(d("ready_to_settle"), true)).toBe("settle");
    expect(primaryAction(d("awaiting_validation", { validations: [{ status: "pending" }] }), true)).toBe("record");
    expect(primaryAction(d("awaiting_validation", { validations: [{ status: "pass" }] }), true)).toBe("settle");
    expect(primaryAction(d("settled"), true)).toBe("reopen");
    expect(primaryAction(d("exploring", { kind: "conversation", sessionId: "s1" }), true)).toBe("open_chat");
  });
});

describe("itemPrimary", () => {
  const d = (
    status: string,
    extra: Partial<{
      packets: unknown[];
      validations: { status: string }[];
      links: { kind: string; url: string | null }[];
      blockedBy: { open: boolean }[];
    }> = {},
  ) => ({
    item: { kind: "thread" as WorkItem["kind"], status: status as WorkItem["status"], sessionId: null },
    packets: extra.packets ?? [],
    validations: extra.validations ?? [],
    links: extra.links ?? [],
    blockedBy: extra.blockedBy ?? [],
  });
  const pr = [{ kind: "github_pr", url: "https://github.com/o/r/pull/1" }];
  it("maps every state to exactly one primary", () => {
    expect(itemPrimary(d("in_progress", { packets: [{}] }), true)).toBe("continue");
    expect(itemPrimary(d("in_review", { links: pr }), true)).toBe("open_pr");
    expect(itemPrimary(d("in_review"), true)).toBe("packet");
    expect(itemPrimary(d("awaiting_validation", { validations: [{ status: "pending" }] }), true)).toBe("record");
    expect(itemPrimary(d("ready_to_settle", { blockedBy: [{ open: true }] }), true)).toBe("settle");
    expect(itemPrimary(d("settled"), true)).toBe("reopen");
    expect(itemPrimary(d("in_progress", { packets: [{}], blockedBy: [{ open: true }] }), true)).toBe("resolve_blocker");
    expect(itemPrimary(d("in_progress", { blockedBy: [{ open: false }] }), true)).toBe("packet");
  });
});

describe("rollup", () => {
  it("counts work under a node, not containers or chats as work", () => {
    const it = (id: string, parentId: string | null, kind: WorkItem["kind"], status: WorkItem["status"] = "captured", archived = false) => ({
      id,
      parentId,
      kind,
      status,
      archived,
    });
    const items = [
      it("a", null, "area"),
      it("p", "a", "project"),
      it("t1", "p", "thread", "in_progress"),
      it("t2", "p", "thread", "settled"),
      it("t3", "p", "thread", "awaiting_validation"),
      it("c", "p", "conversation", "exploring"),
      it("x", "p", "thread", "captured", true),
      it("t4", "a", "note"),
    ];
    expect(rollup(items, "a")).toEqual({ containers: 1, total: 4, open: 3, active: 1, done: 1, proofDue: 1, conversations: 1 });
    expect(rollup(items, "p")).toMatchObject({ containers: 0, total: 3, done: 1 });
  });
});

describe("createPath", () => {
  it("creates missing levels (area, projects) and reuses existing ones by title", () => {
    const r = store.createPath(me(), { path: ["Momentum bets", "V5 evaluator", "Hydration fix"] }, cid);
    expect(r.created).toBe(3);
    expect(r.item.kind).toBe("thread");
    const all = store.listItems(owner);
    const area = all.find((i) => i.title === "Momentum bets")!;
    const project = all.find((i) => i.title === "V5 evaluator")!;
    expect(area.parentId).toBeNull();
    expect(area.kind).toBe("area");
    expect(project).toMatchObject({ parentId: area.id, kind: "project" });
    expect(r.item.parentId).toBe(project.id);

    const again = store.createPath(me(), { path: ["momentum BETS", "v5 evaluator", "Latency bench"], kind: "investigation" }, cid);
    expect(again.created).toBe(1);
    expect(again.item).toMatchObject({ parentId: project.id, kind: "investigation" });
  });

  it("is relative to a parent and defaults the leaf kind from it", () => {
    const area = store.createItem(me(), { kind: "area", title: "Home" }, cid);
    const leaf = store.createPath(me(), { parentId: area.id, path: ["Garage"] }, cid);
    expect(leaf.item).toMatchObject({ parentId: area.id, kind: "project" });
    const deep = store.createPath(me(), { parentId: leaf.item.id, path: ["Shelves", "Buy brackets"] }, cid);
    expect(deep.created).toBe(2);
    expect(deep.item.kind).toBe("thread");
  });

  it("puts a single top-level non-area in Miscellaneous and refuses areas below the top", () => {
    const r = store.createPath(me(), { path: ["Loose idea"], kind: "thread" }, cid);
    const misc = store.listItems(owner).find((i) => i.builtIn)!;
    expect(r.item.parentId).toBe(misc.id);
    const top = store.createPath(me(), { path: ["Health"] }, cid);
    expect(top.item).toMatchObject({ parentId: null, kind: "area" });
    expect(() => store.createPath(me(), { parentId: top.item.id, path: ["Nested area"], kind: "area" }, cid)).toThrow(/top-level/);
  });

  it("refuses notes as parents and other people's items", () => {
    const area = store.createItem(me(), { kind: "area", title: "Ideas" }, cid);
    const note = store.createItem(me(), { kind: "note", title: "Scratch", parentId: area.id }, cid);
    expect(() => store.createPath(me(), { parentId: note.id, path: ["Child"] }, cid)).toThrow(/Notes can't/);
    expect(() => store.createPath(me(), { parentId: area.id, path: ["Scratch", "Child"] }, cid)).toThrow(/note/);
    expect(() => store.createPath(them(), { parentId: area.id, path: ["Sneaky"] }, cid)).toThrow(/not found/i);
    expect(createPathSchema.safeParse({ path: [] }).success).toBe(false);
    expect(createPathSchema.safeParse({ path: ["a"], extra: 1 }).success).toBe(false);
  });

  it("route requires a session", async () => {
    const req = (cookie?: string) =>
      new NextRequest("http://jarvis.test/api/work/items/path", {
        method: "POST",
        headers: { ...(cookie ? { cookie } : {}), "x-jarvis-csrf": "1", "content-type": "application/json" },
        body: JSON.stringify({ path: ["Area X", "Proj"] }),
      });
    const anon = await pathRoute.POST(req(), { params: Promise.resolve({}) });
    expect(anon.status).toBe(401);
    const ok = await pathRoute.POST(req(`jarvis_session=${createSession(owner).token}`), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { created: number }).created).toBe(2);
  });
});
