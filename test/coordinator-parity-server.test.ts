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
      ["sub:api_g:s1", "running", "homelabchief"],
      ["sub:api_g:s2", "done", "homelabchief"],
    ]);
    // replay: nothing new
    expect(syncDelegatedRuns(owner, "api_g", "homelabchief", [sub("s1", "running"), sub("s2", "completed")])).toBe(0);
    // s1 finishes
    expect(syncDelegatedRuns(owner, "api_g", "homelabchief", [sub("s1", "failed", { error: "boom" })])).toBe(1);
    rows = runsOf(project.id);
    expect(rows.find((r) => r.delegationId === "sub:api_g:s1")?.state).toBe("failed");
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
    ).toEqual(["deleg_9:a", "sub:api_s:b"]);
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
    expect(runsOf(area.id).map((r) => [r.delegationId, r.state])).toEqual([["sub:api_r0:bg1", "running"]]);
    // next tick: only the 5 not yet read; then nothing until activity moves
    const second = reconcileDelegatedRuns(now, read);
    expect(second.queued).toBe(5);
    await second.done;
    expect(reconcileDelegatedRuns(now, read).queued).toBe(0);
    expect(runsOf(area.id).length).toBe(1);
  });

  it("dedupes a jarvis_run_start that arrives after the mirror, mirrors handle-only children, carries heartbeats (#251)", () => {
    const area = store.createItem(owner, { kind: "area", title: "Dock" }, cid);
    store.placeConversation(owner, { sessionId: "api_d", parentId: area.id, title: "Dock coordinator" }, cid);
    expect(
      syncDelegatedRuns(
        owner,
        "api_d",
        "devchief",
        [sub("c1", "running", { childSessionId: "child_1", updatedAt: "2026-11-07T10:00:00.000Z" })],
        new Date("2026-11-07T10:00:00Z"),
      ),
    ).toBe(1);
    // heartbeat: same state, newer child activity → updated_at moves (no Stalled while alive)
    expect(
      syncDelegatedRuns(
        owner,
        "api_d",
        "devchief",
        [sub("c1", "running", { childSessionId: "child_1", updatedAt: "2026-11-07T11:00:00.000Z" })],
        new Date("2026-11-07T11:05:00Z"),
      ),
    ).toBe(1);
    expect(runsOf(area.id)[0]!.updatedAt).toBe("2026-11-07T11:00:00.000Z");
    // the agent registers the same child itself afterwards → the automatic mirror goes away
    registerAgentRun(owner, "devchief", { itemId: area.id, title: "Mine", hermesSessionId: "child_1" }, cid, "tok_1");
    syncDelegatedRuns(owner, "api_d", "devchief", [sub("c1", "running", { childSessionId: "child_1" })]);
    expect(runsOf(area.id).map((r) => r.delegationId)).toEqual([null]);
    // a child known only by its sub-agent handle is mirrored too
    expect(syncDelegatedRuns(owner, "api_d", "devchief", [sub("sa_1", "running", { delegationId: null, subagentId: "sa_1" })])).toBe(1);
    expect(runsOf(area.id).some((r) => r.delegationId === "sub:api_d:sa_1")).toBe(true);
  });

  it("namespaces mirror keys by parent conversation and adopts pre-#251 keys", () => {
    const area = store.createItem(owner, { kind: "area", title: "Yard" }, cid);
    const other = store.createItem(owner, { kind: "area", title: "Barn" }, cid);
    store.placeConversation(owner, { sessionId: "api_y1", parentId: area.id, title: "Yard 1" }, cid);
    store.placeConversation(owner, { sessionId: "api_y2", parentId: other.id, title: "Barn 1" }, cid);
    registerAgentRun(owner, "devchief", { itemId: area.id, title: "Old mirror", delegationId: "sub:same" }, cid);
    expect(syncDelegatedRuns(owner, "api_y1", "devchief", [sub("same", "completed")])).toBe(1);
    expect(runsOf(area.id).map((r) => [r.delegationId, r.state])).toEqual([["sub:api_y1:same", "done"]]);
    expect(syncDelegatedRuns(owner, "api_y2", "devchief", [sub("same", "running")])).toBe(1);
    expect(runsOf(other.id).map((r) => r.delegationId)).toEqual(["sub:api_y2:same"]);
  });

  it("reconcile requeues a session whose mirror hit the write cap and rechecks in-flight children older than 24 h", async () => {
    __resetReconcile();
    const now = new Date("2026-11-07T18:00:00Z");
    const area = store.createItem(owner, { kind: "area", title: "Mill" }, cid);
    store.placeConversation(owner, { sessionId: "api_cap", parentId: area.id, title: "Mill chat" }, cid);
    store.placeConversation(owner, { sessionId: "api_long", parentId: area.id, title: "Long chat" }, cid);
    writeIndex(
      owner.id,
      [{ id: "api_cap", title: "Mill chat", lastActiveAt: new Date(now.getTime() - 60_000).toISOString(), pinned: false, archived: false }],
      true,
      now,
    );
    for (let i = 0; i < 25; i++) upsertExecution("api_cap", sub(`k${i}`, "completed", { delegationId: `deleg_k${i}` }), null);
    upsertExecution("api_long", sub("old1", "running", { delegationId: "deleg_old", updatedAt: new Date(now.getTime() - 48 * 3600_000).toISOString() }), null);
    const read = vi.fn(async (u: CurrentUser, sid: string) => syncDelegatedRuns(u, sid, "devchief", executionRecords(sid)));
    await reconcileDelegatedRuns(now, read).done;
    expect(read.mock.calls.map((c) => c[1]).sort()).toEqual(["api_cap", "api_long"]);
    expect(runsOf(area.id).filter((r) => r.delegationId?.startsWith("sub:api_cap:")).length).toBe(20);
    const again = reconcileDelegatedRuns(now, read);
    expect(again.queued).toBe(1);
    await again.done;
    expect(runsOf(area.id).filter((r) => r.delegationId?.startsWith("sub:api_cap:")).length).toBe(25);
  });
});
