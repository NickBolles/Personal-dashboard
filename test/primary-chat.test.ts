import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, getSqlite, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createLocalSession } from "@/server/assistant/local";
import * as store from "@/server/work/store";
import { chatServesOthers, continueInConversation, ensureTaskChat, setPrimaryChat } from "@/server/work/primary-chat";
import { agentRuns } from "@/server/work/agent-runs";
import { listDecisions } from "@/server/work/decisions";
import { conversationItem } from "@/server/work/delegated-runs";
import { reconcileCandidates } from "@/server/work/delegated-reconcile";
import { registerAgentRun } from "@/server/work/registered-runs";
import { forkConversation } from "@/server/areas";
import { areaDefaultsFor } from "@/server/references";
import { canHaveChat, taskChats } from "@/lib/task-chat";
import { packetSchema } from "@/lib/work";

/** Task threads, step 1: one primary chat per task, stored on the task, read by everything that needs "the" chat. */

let owner: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function tree() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Home" }, cid);
  const project = store.createItem(u, { kind: "project", title: "Office", parentId: area.id }, cid);
  const desk = store.createItem(u, { kind: "thread", title: "Standing desk", parentId: project.id }, cid);
  const shelf = store.createItem(u, { kind: "thread", title: "Shelving", parentId: project.id }, cid);
  return { u, area, project, desk, shelf };
}
const primaryOf = (id: string) => getDb().select().from(schema.workItems).where(eq(schema.workItems.id, id)).get()!.primarySessionId;
const link = (itemId: string, sessionId: string, at = "2026-11-01T00:00:00.000Z") =>
  getDb()
    .insert(schema.workLinks)
    .values({
      id: `l_${itemId}_${sessionId}`,
      itemId,
      kind: "chat_session",
      targetId: sessionId,
      url: null,
      title: `Chat ${sessionId}`,
      role: "source",
      createdAt: at,
    })
    .run();

describe("which items have a chat", () => {
  it("tasks and projects do; areas, conversations and notes do not", () => {
    expect(canHaveChat({ kind: "thread", parentId: "p" })).toBe(true);
    expect(canHaveChat({ kind: "investigation", parentId: "p" })).toBe(true);
    expect(canHaveChat({ kind: "project", parentId: "a" })).toBe(true);
    expect(canHaveChat({ kind: "area", parentId: null })).toBe(false);
    expect(canHaveChat({ kind: "conversation", parentId: "p" })).toBe(false);
    expect(canHaveChat({ kind: "note", parentId: "p" })).toBe(false);
  });

  it("lists the primary first and the others newest first, once each", () => {
    const chats = taskChats({
      item: { primarySessionId: "s2" },
      children: [
        { kind: "conversation", sessionId: "s1", title: "Old", archived: false, createdAt: "2026-11-01T00:00:00Z" },
        { kind: "conversation", sessionId: "s2", title: "Main", archived: false, createdAt: "2026-11-02T00:00:00Z" },
        { kind: "conversation", sessionId: "s9", title: "Archived", archived: true, createdAt: "2026-11-09T00:00:00Z" },
        { kind: "thread", sessionId: null, title: "Sub-task", archived: false, createdAt: "2026-11-03T00:00:00Z" },
      ],
      links: [
        { kind: "chat_session", targetId: "s1", title: "Old (link)", createdAt: "2026-11-05T00:00:00Z" },
        { kind: "chat_session", targetId: "s3", title: "Linked", createdAt: "2026-11-04T00:00:00Z" },
        { kind: "github_pr", targetId: "o/r#1", title: "PR", createdAt: "2026-11-04T00:00:00Z" },
      ],
    });
    expect(chats.primary).toMatchObject({ sessionId: "s2", title: "Main", source: "filed", primary: true });
    expect(chats.others.map((c) => [c.sessionId, c.source])).toEqual([
      ["s3", "linked"],
      ["s1", "filed"],
    ]);
    // A pointer that names a chat nothing else lists (a backfilled run chat) still is the primary.
    expect(taskChats({ item: { primarySessionId: "s7" }, children: [], links: [] }).primary).toMatchObject({ sessionId: "s7", source: "recorded" });
    expect(taskChats({ item: { primarySessionId: null }, children: [], links: [] })).toEqual({ primary: null, others: [] });
  });
});

describe("a task's chat is created with its first message", () => {
  it("files the conversation under the task and records it as primary, once", async () => {
    const { u, desk } = tree();
    expect(primaryOf(desk.id)).toBeNull();
    const [a, b] = await Promise.all([ensureTaskChat(u, desk.id, "claude", cid), ensureTaskChat(u, desk.id, "claude", cid)]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.created).toBe(true);
    expect(primaryOf(desk.id)).toBe(a.sessionId);
    const node = store.conversationNodes(owner).get(a.sessionId)!;
    expect(node.parentId).toBe(desk.id);
    // Asking again returns the same chat and creates nothing.
    expect(await ensureTaskChat(u, desk.id, "claude", cid)).toEqual({ sessionId: a.sessionId, created: false });
    expect([...store.conversationNodes(owner).values()].filter((n) => n.parentId === desk.id)).toHaveLength(1);
    expect(store.getDetail(owner, desk.id).item.primarySessionId).toBe(a.sessionId);
    expect(store.getDetail(owner, desk.id).events.some((e) => e.kind === "chat" && e.reason === "Chat started")).toBe(true);
  });

  it("refuses areas, notes and archived tasks", async () => {
    const { u, area, desk } = tree();
    const note = store.createItem(u, { kind: "note", title: "Measurements", parentId: desk.id }, cid);
    await expect(ensureTaskChat(u, area.id, "claude", cid)).rejects.toMatchObject({ code: "no_chat" });
    await expect(ensureTaskChat(u, note.id, "claude", cid)).rejects.toMatchObject({ code: "no_chat" });
    store.updateItem(u, desk.id, { archived: true }, cid);
    await expect(ensureTaskChat(u, desk.id, "claude", cid)).rejects.toMatchObject({ code: "archived" });
  });

  it("continue hands the packet to the task's own chat and never makes a second one", async () => {
    const { u, desk } = tree();
    const packet = store.createPacket(u, desk.id, packetSchema.parse({ objective: "Pick a frame", nextAction: "Compare prices" }), cid);
    const first = await continueInConversation(u, desk.id, "claude", cid);
    expect(first.created).toBe(true);
    expect(first.link).toMatchObject({ kind: "chat_session", lineage: "handoff_from", packetId: packet.id, targetId: first.session.id });
    expect(primaryOf(desk.id)).toBe(first.session.id);
    expect(store.conversationNodes(owner).get(first.session.id)?.parentId).toBe(desk.id);
    const again = await continueInConversation(u, desk.id, "claude", cid);
    expect(again).toMatchObject({ session: { id: first.session.id }, link: null, created: false });
    expect(store.getDetail(owner, desk.id).links.filter((l) => l.kind === "chat_session")).toHaveLength(1);
  });
});

describe("make primary", () => {
  it("swaps the primary among the task's own chats, with undo", async () => {
    const { u, desk } = tree();
    const first = await ensureTaskChat(u, desk.id, "claude", cid);
    const second = await createLocalSession(u, "Second look");
    store.placeConversation(u, { sessionId: second.id, parentId: desk.id, title: "Second look" }, cid);
    const out: store.OpOut = {};
    expect(setPrimaryChat(u, desk.id, second.id, cid, out).primarySessionId).toBe(second.id);
    expect(out.op).toMatchObject({ kind: "primary_chat", label: "Primary chat changed" });
    const chats = taskChats(store.getDetail(owner, desk.id));
    expect(chats.primary?.sessionId).toBe(second.id);
    expect(chats.others.map((c) => c.sessionId)).toEqual([first.sessionId]);
    expect(store.undoOp(u, out.op!.id, cid).item?.primarySessionId).toBe(first.sessionId);
  });

  it("files a linked chat under the task when it becomes primary", async () => {
    const { u, desk } = tree();
    const loose = await createLocalSession(u, "Loose chat");
    store.placeConversation(u, { sessionId: loose.id, parentId: null, title: "Loose chat" }, cid);
    link(desk.id, loose.id);
    setPrimaryChat(u, desk.id, loose.id, cid);
    expect(primaryOf(desk.id)).toBe(loose.id);
    expect(store.conversationNodes(owner).get(loose.id)?.parentId).toBe(desk.id);
  });

  it("never promotes a chat that served other work, or one that is not the task's", async () => {
    const { u, area, desk, shelf } = tree();
    // linked to two tasks
    link(desk.id, "sess-two");
    link(shelf.id, "sess-two");
    expect(() => setPrimaryChat(u, desk.id, "sess-two", cid)).toThrowError(/also served other work/);
    // linked here, but an agent run on another task names it
    link(desk.id, "sess-run");
    registerAgentRun(u, "homechief", { itemId: shelf.id, title: "Price lumber", hermesSessionId: "sess-run" }, cid);
    expect(chatServesOthers(owner, "sess-run", desk.id)).toBe(true);
    expect(() => setPrimaryChat(u, desk.id, "sess-run", cid)).toThrowError(/also served other work/);
    // linked here, filed under the area (a channel chat)
    link(desk.id, "sess-area");
    store.placeConversation(u, { sessionId: "sess-area", parentId: area.id, title: "Home coordinator" }, cid);
    expect(() => setPrimaryChat(u, desk.id, "sess-area", cid)).toThrowError(/also served other work/);
    // another task's primary
    const other = await ensureTaskChat(u, shelf.id, "claude", cid);
    link(desk.id, other.sessionId);
    expect(() => setPrimaryChat(u, desk.id, other.sessionId, cid)).toThrowError(/also served other work/);
    // not one of the task's chats at all
    expect(() => setPrimaryChat(u, desk.id, "sess-unknown", cid)).toThrowError(/isn't one of this task's chats/);
    expect(primaryOf(desk.id)).toBeNull();
  });
});

describe("forks", () => {
  it("forking a task does not share its chat", async () => {
    const { u, desk } = tree();
    const chat = await continueInConversation(u, desk.id, "claude", cid);
    store.addLink(u, desk.id, { kind: "url", url: "https://example.com/frames", title: "Frames", role: "source" }, cid);
    const fork = store.forkItem(u, desk.id, undefined, cid);
    const d = store.getDetail(owner, fork.id);
    expect(d.item.primarySessionId).toBeNull();
    expect(d.links.map((l) => l.kind)).toEqual(["url"]);
    expect(primaryOf(desk.id)).toBe(chat.session.id);
  });

  it("a fork of the primary chat is filed under the same task and the original stays primary", async () => {
    const { u, desk } = tree();
    // A recorded primary whose conversation sits in Miscellaneous (a backfilled pointer): the fork still lands on the task.
    const chat = await createLocalSession(u, "Desk chat");
    store.placeConversation(u, { sessionId: chat.id, parentId: null, title: "Desk chat" }, cid);
    getDb().update(schema.workItems).set({ primarySessionId: chat.id }).where(eq(schema.workItems.id, desk.id)).run();
    const fork = await forkConversation(u, chat.id, { title: "Desk chat (fork)" }, cid);
    expect(store.conversationNodes(owner).get(fork.session.id)?.parentId).toBe(desk.id);
    expect(primaryOf(desk.id)).toBe(chat.id);
    expect(taskChats(store.getDetail(owner, desk.id)).others.map((c) => c.sessionId)).toEqual([fork.session.id]);
  });
});

describe("every reader of the task's chat uses the stored primary", () => {
  it("agent runs, decisions, sub-agent mirroring, area defaults and the reconcile watch", () => {
    const { u, area, desk } = tree();
    // Two chats: an older one filed under the task, and a linked one that is the recorded primary.
    store.placeConversation(u, { sessionId: "sess-filed", parentId: desk.id, title: "Earlier chat" }, cid);
    link(desk.id, "sess-primary");
    getDb().update(schema.workItems).set({ primarySessionId: "sess-primary" }).where(eq(schema.workItems.id, desk.id)).run();
    registerAgentRun(u, "homechief", { itemId: desk.id, title: "Compare frames", hermesSessionId: "sess-filed" }, cid);

    expect(agentRuns(u).items[desk.id]?.sessionId).toBe("sess-primary");

    store.updateItem(u, desk.id, { decision: { question: "Budget ceiling?", choices: ["$300", "$350"] } }, cid);
    expect(listDecisions(u).entries.find((e) => e.itemId === desk.id)?.sessionId).toBe("sess-primary");

    // The primary works for its task even though it is not filed under it.
    expect(conversationItem(u, "sess-primary")).toBe(desk.id);
    expect(areaDefaultsFor(u, "sess-primary")).toMatchObject({ area: { id: area.id }, nodeId: desk.id });
    expect(conversationItem(u, "sess-filed")).toBe(desk.id);

    // The reconcile pass watches a primary that was never filed as a conversation.
    expect(getDb().select({ id: schema.workItems.id }).from(schema.workItems).where(eq(schema.workItems.sessionId, "sess-primary")).all()).toEqual([]);
    expect(() => reconcileCandidates()).not.toThrow();
  });
});

describe("backfill (drizzle/0047_primary_chat.sql)", () => {
  const backfill = () => {
    const file = fs.readFileSync(path.join(process.cwd(), "drizzle", "0047_primary_chat.sql"), "utf8");
    const statement = file.split("--> statement-breakpoint").at(-1)!;
    expect(statement).toContain("UPDATE work_items");
    getSqlite().exec(statement);
  };
  const conv = (parentId: string, sessionId: string, at: string, archived = false) =>
    getDb()
      .insert(schema.workItems)
      .values({
        id: `wk_${sessionId}`,
        userId: owner,
        parentId,
        kind: "conversation",
        title: sessionId,
        sessionId,
        status: "exploring",
        archived,
        createdAt: at,
      })
      .run();
  const run = (itemId: string, sessionId: string) =>
    getDb()
      .insert(schema.agentRuns)
      .values({ id: `run_${itemId}_${sessionId}`, userId: owner, itemId, profile: "homechief", title: "Run", hermesSessionId: sessionId })
      .run();
  const known = (sessionId: string) => getDb().insert(schema.sessionMeta).values({ sessionId, userId: owner }).run();

  it("promotes a chat only where it served one task, and only records the pointer", () => {
    const { u, area, project, desk, shelf } = tree();
    const misc = store.ensureMiscellaneous(owner);
    const lamp = store.createItem(u, { kind: "thread", title: "Lamp", parentId: project.id }, cid);
    const paint = store.createItem(u, { kind: "thread", title: "Paint", parentId: project.id }, cid);
    const rug = store.createItem(u, { kind: "thread", title: "Rug", parentId: project.id }, cid);
    const note = store.createItem(u, { kind: "note", title: "Measurements", parentId: desk.id }, cid);

    // desk: two chats of its own. The filed one wins over the linked one; among filed ones the newest wins.
    conv(desk.id, "desk-old", "2026-11-01T00:00:00.000Z");
    conv(desk.id, "desk-new", "2026-11-05T00:00:00.000Z");
    conv(desk.id, "desk-archived", "2026-11-09T00:00:00.000Z", true);
    link(desk.id, "desk-linked", "2026-11-08T00:00:00.000Z");
    // shelf: only a chat that is also linked to lamp. It served two tasks: nobody gets it.
    link(shelf.id, "shared", "2026-11-02T00:00:00.000Z");
    link(lamp.id, "shared", "2026-11-03T00:00:00.000Z");
    // lamp: a linked chat that sits unfiled in Miscellaneous. Miscellaneous is not "another item".
    conv(misc.id, "lamp-loose", "2026-11-04T00:00:00.000Z");
    link(lamp.id, "lamp-loose", "2026-11-04T00:00:00.000Z");
    // paint: runs name the coordinator's chat (filed under the area) and a chat Jarvis has never seen.
    conv(area.id, "coordinator", "2026-10-01T00:00:00.000Z");
    run(paint.id, "coordinator");
    run(paint.id, "unknown-session");
    // rug: a run names a chat Jarvis knows and nothing else uses.
    run(rug.id, "rug-run");
    known("rug-run");
    // project and note: chats of their own, but neither is backfilled.
    conv(project.id, "project-chat", "2026-11-06T00:00:00.000Z");
    link(note.id, "note-chat");

    const before = {
      items: getDb().select().from(schema.workItems).all().length,
      links: getDb().select().from(schema.workLinks).all().length,
      parents: getDb().select({ id: schema.workItems.id, parentId: schema.workItems.parentId }).from(schema.workItems).all(),
    };
    backfill();

    expect(primaryOf(desk.id)).toBe("desk-new");
    expect(primaryOf(shelf.id)).toBeNull();
    expect(primaryOf(lamp.id)).toBe("lamp-loose");
    expect(primaryOf(paint.id)).toBeNull();
    expect(primaryOf(rug.id)).toBe("rug-run");
    expect(primaryOf(project.id)).toBeNull();
    expect(primaryOf(note.id)).toBeNull();
    expect(primaryOf(area.id)).toBeNull();
    // Nothing is moved, linked or created.
    expect(getDb().select().from(schema.workItems).all()).toHaveLength(before.items);
    expect(getDb().select().from(schema.workLinks).all()).toHaveLength(before.links);
    expect(getDb().select({ id: schema.workItems.id, parentId: schema.workItems.parentId }).from(schema.workItems).all()).toEqual(before.parents);
    // Running it again changes nothing.
    backfill();
    expect(primaryOf(desk.id)).toBe("desk-new");
  });
});
