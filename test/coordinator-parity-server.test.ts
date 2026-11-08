/** Coordinator parity server side: coordinator brief in filed context + sub-agents mirrored as agent runs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { mintAgentToken } from "@/server/agent-access/tokens";
import { filedChatContext } from "@/server/work/chat-context";
import { syncDelegatedRuns } from "@/server/work/delegated-runs";
import { registerAgentRun } from "@/server/work/registered-runs";
import { executionRecords, executionState, upsertExecution } from "@/server/chat/execution-store";
import { writeIndex } from "@/server/work/conversation-index";
import { __resetReconcile, RECONCILE_MAX_PER_TICK, reconcileDelegatedRuns } from "@/server/work/delegated-reconcile";
import type { ExecutionRecord } from "@/lib/chat-execution";

const cid = "test";
let owner: CurrentUser;
const sub = (id: string, state: ExecutionRecord["state"], extra: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  key: `subagent:${id}`,
  id,
  source: "subagent",
  title: `Task ${id}`,
  state,
  delegationId: "deleg_9",
  ...extra,
});
const runsOf = (itemId: string) => getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.itemId, itemId)).all();

describe("coordinator parity (server)", () => {
  beforeEach(() => {
    __setTestDatabase();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    owner = resolveUser(new Headers(), createSession(id).token)!;
  });

  it("a conversation filed directly under an area gets the coordinator brief with its session id; deeper chats get only the delegation rule", () => {
    const area = store.createItem(owner, { kind: "area", title: "General Dev" }, cid);
    const project = store.createItem(owner, { kind: "project", title: "Jarvis", parentId: area.id }, cid);
    store.placeConversation(owner, { sessionId: "api_coord", parentId: area.id, title: "General Dev coordinator" }, cid);
    store.placeConversation(owner, { sessionId: "api_deep", parentId: project.id, title: "Deep chat" }, cid);
    const noTools = filedChatContext(owner, "api_coord", "devchief")!;
    expect(noTools).toContain("You are the General Dev coordinator");
    expect(noTools).toContain("Jarvis conversation id: api_coord");
    expect(noTools).toContain("**Current state:**");
    expect(noTools).toContain("never claim you changed anything");
    mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ["work.read"] }, cid);
    const withTools = filedChatContext(owner, "api_coord", "devchief")!;
    expect(withTools).toContain("jarvis_run_start");
    expect(withTools).toContain("hermesSessionId = api_coord");
    const deep = filedChatContext(owner, "api_deep", "devchief")!;
    expect(deep).not.toContain("coordinator in Jarvis");
    expect(deep).toContain("If you dispatch sub-agents with delegate_task");
  });

  it("maps async spawn statuses to running instead of unknown", () => {
    expect(executionState("queued")).toBe("running");
    expect(executionState("dispatched")).toBe("running");
    expect(executionState("timeout")).toBe("failed");
    expect(executionState("weird")).toBe("unknown");
  });

  it("mirrors sub-agents of a filed conversation as agent runs on its item, idempotently, following state", () => {
    const area = store.createItem(owner, { kind: "area", title: "Home" }, cid);
    const project = store.createItem(owner, { kind: "project", title: "Garage", parentId: area.id }, cid);
    store.placeConversation(owner, { sessionId: "api_g", parentId: project.id, title: "Garage chat" }, cid);
    expect(syncDelegatedRuns(owner, "api_g", "homelabchief", [sub("s1", "running"), sub("s2", "completed", { summary: "Shelves ordered" })])).toBe(2);
    let rows = runsOf(project.id);
    expect(rows.map((r) => [r.delegationId, r.state, r.profile]).sort()).toEqual([
      ["sub:s1", "running", "homelabchief"],
      ["sub:s2", "done", "homelabchief"],
    ]);
    // replay: nothing new
    expect(syncDelegatedRuns(owner, "api_g", "homelabchief", [sub("s1", "running"), sub("s2", "completed")])).toBe(0);
    // s1 finishes
    expect(syncDelegatedRuns(owner, "api_g", "homelabchief", [sub("s1", "failed", { error: "boom" })])).toBe(1);
    rows = runsOf(project.id);
    expect(rows.find((r) => r.delegationId === "sub:s1")?.state).toBe("failed");
    expect(rows.length).toBe(2);
  });

  it("skips unfiled chats and delegations the agent already registered itself", () => {
    expect(syncDelegatedRuns(owner, "api_nowhere", null, [sub("s1", "running")])).toBe(0);
    const area = store.createItem(owner, { kind: "area", title: "Ops" }, cid);
    store.placeConversation(owner, { sessionId: "api_o", parentId: area.id, title: "Ops coordinator" }, cid);
    registerAgentRun(owner, "devchief", { itemId: area.id, title: "Mine", delegationId: "deleg_9" }, cid);
    expect(syncDelegatedRuns(owner, "api_o", "devchief", [sub("s1", "running")])).toBe(0);
    const rows = getDb()
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.itemId, area.id)))
      .all();
    expect(rows.map((r) => r.delegationId)).toEqual(["deleg_9"]);
  });

  it("matches per-child registrations, waits on unknown children and caps writes, not records", () => {
    const area = store.createItem(owner, { kind: "area", title: "Shop" }, cid);
    store.placeConversation(owner, { sessionId: "api_s", parentId: area.id, title: "Shop coordinator" }, cid);
    registerAgentRun(owner, "devchief", { itemId: area.id, title: "Child a", delegationId: "deleg_9:a" }, cid);
    expect(syncDelegatedRuns(owner, "api_s", "devchief", [sub("a", "running"), sub("b", "running"), sub("u", "unknown")])).toBe(1);
    expect(
      runsOf(area.id)
        .map((r) => r.delegationId)
        .sort(),
    ).toEqual(["deleg_9:a", "sub:b"]);
    const many = Array.from({ length: 25 }, (_, i) => sub(`m${i}`, "running"));
    expect(syncDelegatedRuns(owner, "api_s", "devchief", many)).toBe(20);
    expect(syncDelegatedRuns(owner, "api_s", "devchief", many)).toBe(5);
  });

  it("background reconcile registers sub-agents of recent filed conversations without the chat open (bounded, idempotent)", async () => {
    __resetReconcile();
    const now = new Date("2026-11-07T18:00:00Z");
    const area = store.createItem(owner, { kind: "area", title: "Lab" }, cid);
    for (let i = 0; i < 25; i++) store.placeConversation(owner, { sessionId: `api_r${i}`, parentId: area.id, title: `Lab chat ${i}` }, cid);
    store.placeConversation(owner, { sessionId: "api_old", parentId: area.id, title: "Old chat" }, cid);
    const recent = (i: number) => new Date(now.getTime() - (i + 1) * 60_000).toISOString();
    writeIndex(
      owner.id,
      [
        ...Array.from({ length: 25 }, (_, i) => ({ id: `api_r${i}`, title: `Lab chat ${i}`, lastActiveAt: recent(i), pinned: false, archived: false })),
        { id: "api_old", title: "Old chat", lastActiveAt: new Date(now.getTime() - 30 * 3600_000).toISOString(), pinned: false, archived: false },
        { id: "api_unfiled", title: "Unfiled", lastActiveAt: recent(0), pinned: false, archived: false },
      ],
      true,
      now,
    );
    upsertExecution("api_r0", sub("bg1", "running", { delegationId: "deleg_bg" }), null);
    const read = vi.fn(async (u: CurrentUser, sid: string) => syncDelegatedRuns(u, sid, "devchief", executionRecords(sid)));
    const first = reconcileDelegatedRuns(now, read);
    expect(first.queued).toBe(RECONCILE_MAX_PER_TICK);
    await first.done;
    expect(read.mock.calls.map((c) => c[1])).not.toContain("api_old");
    expect(read.mock.calls.map((c) => c[1])).not.toContain("api_unfiled");
    expect(runsOf(area.id).map((r) => [r.delegationId, r.state])).toEqual([["sub:bg1", "running"]]);
    // next tick: only the 5 not yet read; then nothing until activity moves
    const second = reconcileDelegatedRuns(now, read);
    expect(second.queued).toBe(5);
    await second.done;
    expect(reconcileDelegatedRuns(now, read).queued).toBe(0);
    expect(runsOf(area.id).length).toBe(1);
  });
});
