/**
 * The Areas conversations view must survive a slow Hermes list (8–14 s in
 * prod) instead of reporting "Hermes didn't answer" with an empty list, and
 * fall back to the last good list (access re-checked) when Hermes fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@/lib/hermes";

const listSessions = vi.fn();
const getSessionSummary = vi.fn();
const sessionAccess = vi.fn((..._a: unknown[]): "read" | "write" | null => "write");
vi.mock("@/server/assistant", () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  getSessionSummary: (...a: unknown[]) => getSessionSummary(...a),
  sessionAccess: (...a: unknown[]) => sessionAccess(...a),
}));

import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as conversations from "@/server/work/conversations";

const s = (id: string, title: string, at: string): SessionSummary => ({ id, title, lastActiveAt: at, startedAt: at }) as SessionSummary;
const rows = [s("h1", "Hermes one", "2026-10-25T10:00:00Z"), s("h2", "Hermes two", "2026-10-24T10:00:00Z")];
let owner: string;
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

beforeEach(() => {
  __setTestDatabase();
  conversations.__resetConversationCache();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  listSessions.mockReset();
  getSessionSummary.mockReset();
  sessionAccess.mockReset().mockReturnValue("write");
});
afterEach(() => vi.useRealTimers());

describe("conversation list budget", () => {
  it("waits for a slow Hermes list (beyond the old 6 s race) instead of reporting it unavailable", async () => {
    vi.useFakeTimers();
    listSessions.mockImplementation(() => new Promise((r) => setTimeout(() => r({ sessions: rows, unavailable: [], nextOffset: 100 }), 9_000)));
    const p = conversations.conversationList(me(), "all");
    await vi.advanceTimersByTimeAsync(9_000);
    const view = await p;
    expect(view.unavailable).toEqual([]);
    expect(view.conversations.map((c) => c.id)).toEqual(["h1", "h2"]);
    expect(conversations.LIST_BUDGET_MS).toBeGreaterThan(20_000);
  });

  it("shares one upstream list between concurrent requests", async () => {
    let resolve!: (v: unknown) => void;
    listSessions.mockImplementation(() => new Promise((r) => (resolve = r)));
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

  it("past the budget, reports Hermes and shows the last good list, re-checking access", async () => {
    listSessions.mockResolvedValueOnce({ sessions: rows, unavailable: [], nextOffset: null });
    expect((await conversations.conversationList(me(), "all")).conversations).toHaveLength(2);

    vi.useFakeTimers();
    listSessions.mockImplementation(() => new Promise(() => {}));
    sessionAccess.mockImplementation((_u, id) => (id === "h2" ? null : "write"));
    const p = conversations.conversationList(me(), "all");
    await vi.advanceTimersByTimeAsync(conversations.LIST_BUDGET_MS);
    const view = await p;
    expect(view.unavailable).toEqual(["Hermes"]);
    expect(view.conversations.map((c) => c.id)).toEqual(["h1"]);
  });

  it("with no good list yet, a failure is still reported, never a silent empty list", async () => {
    listSessions.mockRejectedValue(new Error("Hermes 502"));
    const view = await conversations.conversationList(me(), "all");
    expect(view).toMatchObject({ conversations: [], unavailable: ["Hermes"] });
  });

  it("a partial list (Claude only) keeps the remembered Hermes rows", async () => {
    listSessions.mockResolvedValueOnce({ sessions: rows, unavailable: [], nextOffset: null });
    await conversations.conversationList(me(), "all");
    const loc = s("loc_1", "Claude chat", "2026-10-25T12:00:00Z");
    listSessions.mockResolvedValueOnce({ sessions: [loc], unavailable: ["Hermes"], nextOffset: 0 });
    const view = await conversations.conversationList(me(), "all");
    expect(view.unavailable).toEqual(["Hermes"]);
    expect(view.conversations.map((c) => c.id)).toEqual(["loc_1", "h1", "h2"]);
  });

  it("filing checks the one session, not the whole transcript", async () => {
    getSessionSummary.mockResolvedValue({ ...rows[0], readOnly: false });
    const r = await conversations.fileConversation(me(), { sessionId: "h1", itemId: null }, "corr");
    expect(getSessionSummary).toHaveBeenCalledWith(expect.anything(), "h1");
    expect(r.item).toMatchObject({ kind: "conversation", sessionId: "h1", title: "Hermes one" });
  });
});
