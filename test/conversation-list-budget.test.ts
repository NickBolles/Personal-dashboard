/**
 * The Areas conversation views render from a persisted per-person index
 * (stale-while-revalidate) instead of waiting 4–9 s for Hermes' list: cached
 * rows come back at once (access re-checked), a background refresh updates
 * them, a cold start returns the fast first page, and the dispatcher tick
 * keeps recently used indexes warm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@/lib/hermes";

const listSessions = vi.fn();
const listLocalConversations = vi.fn((..._a: unknown[]): SessionSummary[] => []);
const getSessionSummary = vi.fn();
const sessionAccess = vi.fn((..._a: unknown[]): "read" | "write" | null => "write");
vi.mock("@/server/assistant", () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  listLocalConversations: (...a: unknown[]) => listLocalConversations(...a),
  getSessionSummary: (...a: unknown[]) => getSessionSummary(...a),
  sessionAccess: (...a: unknown[]) => sessionAccess(...a),
}));

import { __setTestDatabase, getDb, schema } from "@/server/db";
import { eq } from "drizzle-orm";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as conversations from "@/server/work/conversations";
import { markIndexStale, noteIndexedSession, readIndex, syncIndexedTitle, writeIndex } from "@/server/work/conversation-index";
import { conversationNodes, placeConversation } from "@/server/work/store";
import { dispatchOnce, registerDispatcherTask } from "@/server/notifications/dispatcher";

const s = (id: string, title: string, at: string): SessionSummary => ({ id, title, lastActiveAt: at, startedAt: at }) as SessionSummary;
const rows = [s("h1", "Hermes one", "2026-10-25T10:00:00Z"), s("h2", "Hermes two", "2026-10-24T10:00:00Z")];
const more = [...rows, s("h3", "Hermes three", "2026-10-23T10:00:00Z")];
let owner: string;
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const ids = (v: { conversations: { id: string }[] }) => v.conversations.map((c) => c.id);
const ago = (ms: number) => new Date(Date.now() - ms);
const never = () => new Promise(() => {});

beforeEach(() => {
  __setTestDatabase();
  conversations.__resetConversationCache();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  listSessions.mockReset();
  listLocalConversations.mockReset().mockReturnValue([]);
  getSessionSummary.mockReset();
  sessionAccess.mockReset().mockReturnValue("write");
});
afterEach(() => vi.useRealTimers());

describe("conversation index: cold start", () => {
  it("returns the fast first page, stores it, then fills in the full window in the background", async () => {
    listSessions.mockImplementation((_u, opts: { offset?: number }) =>
      Promise.resolve(opts.offset === 0 ? { sessions: rows, unavailable: [], nextOffset: 20 } : { sessions: more, unavailable: [], nextOffset: 100 }),
    );
    const first = await conversations.conversationList(me(), "all");
    expect(ids(first)).toEqual(["h1", "h2"]);
    expect(first).toMatchObject({ unavailable: [], updating: true });
    expect(listSessions.mock.calls[0]![1]).toEqual({ offset: 0 });
    await conversations.__settleConversationRefreshes();
    expect(readIndex(owner)).toMatchObject({ complete: true });

    listSessions.mockClear();
    const second = await conversations.conversationList(me(), "all");
    expect(ids(second)).toEqual(["h1", "h2", "h3"]);
    expect(second).toMatchObject({ unavailable: [], updating: false });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("concurrent views share one upstream request", async () => {
    let resolve!: (v: unknown) => void;
    listSessions.mockImplementationOnce(() => new Promise((r) => (resolve = r))).mockImplementation(never);
    const u = me();
    const a = conversations.conversationList(u, "all");
    const b = conversations.conversationList(u, "unfiled");
    const c = conversations.unfiledConversations(u);
    resolve({ sessions: rows, unavailable: [], nextOffset: null });
    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(va.conversations).toHaveLength(2);
    expect(vb.unfiledCount).toBe(2);
    expect(vc.total).toBe(2);
  });

  it("a failure with nothing cached is reported, never a silent empty list", async () => {
    listSessions.mockRejectedValue(new Error("Hermes 502"));
    const view = await conversations.conversationList(me(), "all");
    expect(view).toMatchObject({ conversations: [], unavailable: ["Hermes"] });
    expect(readIndex(owner)).toMatchObject({ refreshedAt: null, lastError: "error" });
    // Right after that failure the next view doesn't wait on Hermes again.
    listSessions.mockClear();
    expect((await conversations.conversationList(me(), "all")).unavailable).toEqual(["Hermes"]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("waits for a slow first page (beyond the old 6 s race) instead of reporting it unavailable", async () => {
    vi.useFakeTimers();
    listSessions.mockImplementation(() => new Promise((r) => setTimeout(() => r({ sessions: rows, unavailable: [], nextOffset: null }), 9_000)));
    const p = conversations.conversationList(me(), "all");
    await vi.advanceTimersByTimeAsync(9_000);
    const view = await p;
    expect(view.unavailable).toEqual([]);
    expect(ids(view)).toEqual(["h1", "h2"]);
    expect(conversations.LIST_BUDGET_MS).toBeGreaterThan(20_000);
  });
});

describe("conversation index: stale-while-revalidate", () => {
  it("serves the cached list at once while Hermes is slow, flagged updating (no warning)", async () => {
    writeIndex(owner, rows, true, ago(5 * 60_000));
    listSessions.mockImplementation(never);
    const t = performance.now();
    const view = await conversations.conversationList(me(), "all");
    expect(performance.now() - t).toBeLessThan(500);
    expect(ids(view)).toEqual(["h1", "h2"]);
    expect(view).toMatchObject({ unavailable: [], updating: true });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("re-checks access on every cached row and merges Claude-direct conversations live", async () => {
    writeIndex(owner, rows, true);
    sessionAccess.mockImplementation((_u, id) => (id === "h2" ? null : "write"));
    listLocalConversations.mockReturnValue([s("loc_1", "Claude chat", "2026-10-25T12:00:00Z")]);
    const view = await conversations.conversationList(me(), "all");
    expect(ids(view)).toEqual(["loc_1", "h1"]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("cached reads still sync Claude-direct titles into the tree", async () => {
    placeConversation(me(), { sessionId: "loc_1", parentId: null, title: "New conversation" }, "corr");
    writeIndex(owner, rows, true);
    listLocalConversations.mockReturnValue([s("loc_1", "Plan groceries", "2026-10-25T12:00:00Z")]);
    await conversations.conversationList(me(), "all");
    expect(conversationNodes(owner).get("loc_1")?.title).toBe("Plan groceries");
  });

  it("a fresh list isn't refetched; ?refresh=1 revalidates in the background and the next read has it", async () => {
    writeIndex(owner, rows, true);
    listSessions.mockResolvedValue({ sessions: more, unavailable: [], nextOffset: 100 });
    await conversations.conversationList(me(), "all");
    expect(listSessions).not.toHaveBeenCalled();
    const v = await conversations.conversationList(me(), "all", null, { revalidate: true });
    expect(v).toMatchObject({ updating: true });
    expect(ids(v)).toEqual(["h1", "h2"]);
    await conversations.__settleConversationRefreshes();
    expect(ids(await conversations.conversationList(me(), "all"))).toEqual(["h1", "h2", "h3"]);
  });

  it("a failed background refresh keeps the cached rows", async () => {
    writeIndex(owner, rows, true, ago(2 * 60_000));
    listSessions.mockRejectedValue(new Error("Hermes 502"));
    await conversations.conversationList(me(), "all");
    await conversations.__settleConversationRefreshes();
    const view = await conversations.conversationList(me(), "all");
    expect(ids(view)).toEqual(["h1", "h2"]);
    expect(view.unavailable).toEqual([]);
    expect(readIndex(owner)!.lastError).toBe("error");
    // Backoff: polling right after the failure neither retries Hermes nor keeps reporting "updating".
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(view.updating).toBe(false);
    await conversations.conversationList(me(), "all", null, { revalidate: true });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("past STALE_OK_MS, waits for Hermes within the budget, then shows the cached list with the warning", async () => {
    writeIndex(owner, rows, true, ago(conversations.STALE_OK_MS + 60_000));
    vi.useFakeTimers();
    listSessions.mockImplementation(never);
    const p = conversations.conversationList(me(), "all");
    await vi.advanceTimersByTimeAsync(conversations.LIST_BUDGET_MS);
    const view = await p;
    expect(view.unavailable).toEqual(["Hermes"]);
    expect(ids(view)).toEqual(["h1", "h2"]);
  });

  it("a Claude-only partial refresh doesn't overwrite the cached Hermes rows", async () => {
    writeIndex(owner, rows, true, ago(2 * 60_000));
    listSessions.mockResolvedValue({ sessions: [s("loc_1", "Claude chat", "2026-10-25T12:00:00Z")], unavailable: ["Hermes"], nextOffset: 0 });
    await conversations.conversationList(me(), "all");
    await conversations.__settleConversationRefreshes();
    expect(readIndex(owner)!.sessions.map((x) => x.id)).toEqual(["h1", "h2"]);
  });

  it("changes made in Jarvis (rename, archive, new chat) patch the cached list", async () => {
    writeIndex(owner, rows, true);
    noteIndexedSession(owner, { ...rows[1]!, title: "Renamed", archived: true });
    noteIndexedSession(owner, s("h9", "Brand new", "2026-10-25T13:00:00Z"));
    noteIndexedSession(owner, s("loc_2", "Claude", "2026-10-25T13:00:00Z"));
    const cached = readIndex(owner)!.sessions;
    expect(cached.map((x) => x.id)).toEqual(["h9", "h1", "h2"]);
    expect(cached[2]).toMatchObject({ title: "Renamed", archived: true });
    expect(ids(await conversations.conversationList(me(), "all"))).toEqual(["h9", "h1"]);
    // Reads (insert: false) only refresh rows already listed.
    noteIndexedSession(owner, s("h10", "Opened, not listed", "2026-10-25T14:00:00Z"), { insert: false });
    expect(readIndex(owner)!.sessions.map((x) => x.id)).not.toContain("h10");
  });

  it("a conversation's new title reaches its tree node without waiting for a refresh; a started run marks the index stale", async () => {
    const node = placeConversation(me(), { sessionId: "h1", parentId: null, title: "Untitled conversation" }, "corr");
    syncIndexedTitle(owner, { id: "h1", title: "Plan the week" });
    expect(conversationNodes(owner).get("h1")).toMatchObject({ id: node.id, title: "Plan the week" });
    writeIndex(owner, rows, true);
    markIndexStale(owner);
    expect(readIndex(owner)!.complete).toBe(false);
    listSessions.mockImplementation(never);
    expect(await conversations.conversationList(me(), "all")).toMatchObject({ updating: true });
  });
});

describe("conversation index: warming", () => {
  it("refreshes due, recently used indexes in the background and skips fresh ones", async () => {
    writeIndex(owner, rows, true, ago(conversations.WARM_EVERY_MS + 1_000));
    listSessions.mockResolvedValue({ sessions: more, unavailable: [], nextOffset: 100 });
    expect(conversations.warmConversationIndexes()).toBe(1);
    await conversations.__settleConversationRefreshes();
    expect(readIndex(owner)!.sessions).toHaveLength(3);
    expect(conversations.warmConversationIndexes()).toBe(0);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("a user still queued from an earlier pass isn't queued again", async () => {
    writeIndex(owner, rows, true, ago(conversations.WARM_EVERY_MS + 1_000));
    let resolve!: (v: unknown) => void;
    listSessions.mockImplementation(() => new Promise((r) => (resolve = r)));
    expect(conversations.warmConversationIndexes()).toBe(1);
    expect(conversations.warmConversationIndexes()).toBe(0);
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    resolve({ sessions: more, unavailable: [], nextOffset: 100 });
    await conversations.__settleConversationRefreshes();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("rides the standalone dispatcher tick at its own interval", async () => {
    const run = vi.fn();
    registerDispatcherTask("test_task", 60_000, run);
    const t0 = new Date("2026-10-25T10:00:00Z");
    await dispatchOnce(t0);
    await dispatchOnce(new Date(t0.getTime() + 30_000));
    await dispatchOnce(new Date(t0.getTime() + 61_000));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("conversation index: robustness", () => {
  it("a refresh that started before a Jarvis change is dropped and fetched again", async () => {
    writeIndex(owner, rows, true, ago(2 * 60_000));
    const resolvers: ((v: unknown) => void)[] = [];
    listSessions.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    await conversations.conversationList(me(), "all");
    noteIndexedSession(owner, s("h9", "Brand new", "2026-10-25T13:00:00Z"));
    resolvers[0]!({ sessions: rows, unavailable: [], nextOffset: 100 });
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    expect(readIndex(owner)!.sessions.map((x) => x.id)).toContain("h9");
    resolvers[1]!({ sessions: [s("h9", "Brand new", "2026-10-25T13:00:00Z"), ...rows], unavailable: [], nextOffset: 100 });
    await conversations.__settleConversationRefreshes();
    expect(readIndex(owner)!.sessions.map((x) => x.id)).toEqual(["h9", "h1", "h2"]);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
  it("a refresh for a person deleted mid-flight resolves instead of rejecting", async () => {
    writeIndex(owner, rows, true, ago(2 * 60_000));
    let resolve!: (v: unknown) => void;
    listSessions.mockImplementation(() => new Promise((r) => (resolve = r)));
    const u = me();
    await conversations.conversationList(u, "all");
    getDb().delete(schema.users).where(eq(schema.users.id, owner)).run();
    resolve({ sessions: more, unavailable: [], nextOffset: 100 });
    await expect(conversations.__settleConversationRefreshes()).resolves.toBeUndefined();
    expect(readIndex(owner)).toBeNull();
  });
});

describe("filing", () => {
  it("checks the one session, not the whole transcript", async () => {
    getSessionSummary.mockResolvedValue({ ...rows[0], readOnly: false });
    const r = await conversations.fileConversation(me(), { sessionId: "h1", itemId: null }, "corr");
    expect(getSessionSummary).toHaveBeenCalledWith(expect.anything(), "h1");
    expect(r.item).toMatchObject({ kind: "conversation", sessionId: "h1", title: "Hermes one" });
  });
});
