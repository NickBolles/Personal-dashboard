/** Coordinator parity server side: coordinator brief in filed context + sub-agents mirrored as agent runs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { mintAgentToken } from "@/server/agent-access/tokens";
import { filedChatContext } from "@/server/work/chat-context";
import { sameTaskTitle, syncDelegatedRuns } from "@/server/work/delegated-runs";
import { registerAgentRun } from "@/server/work/registered-runs";
import { executionRecords, executionState, upsertExecution } from "@/server/chat/execution-store";
import { writeIndex } from "@/server/work/conversation-index";
import { __resetReconcile, RECONCILE_MAX_PER_TICK, reconcileDelegatedRuns, sweepStaleMirrors } from "@/server/work/delegated-reconcile";
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
    expect(noTools).toContain("**Next action:**");
    expect(noTools).not.toContain("**Current state:**");
    expect(noTools).toContain("never claim you changed anything");
    mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ["work.read"] }, cid);
    const withTools = filedChatContext(owner, "api_coord", "devchief")!;
    expect(withTools).toContain("jarvis_run_start");
    expect(withTools).toContain("hermesSessionId = api_coord");
    // CW v3: no status footer; decisions by D-n via jarvis_raise_decision, progress via jarvis_run_event.
    expect(withTools).not.toContain("**Current state:**");
    expect(withTools).toContain("don't re-list open decisions");
    expect(withTools).toContain("jarvis_raise_decision");
    expect(withTools).toContain("D-n");
    expect(withTools).toContain("jarvis_run_event");
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

  it("closes a dispatch record through its ended child session (mirror no longer stuck running)", () => {
    const area = store.createItem(owner, { kind: "area", title: "Momentum" }, cid);
    store.placeConversation(owner, { sessionId: "api_m", parentId: area.id, title: "Momentum coordinator" }, cid);
    const dispatch = sub("sa-0-1df9", "running", {
      delegationId: "deleg_9d9c",
      subagentId: "sa-0-1df9",
      title: "Write the bet",
      startedAt: "2026-11-08T02:55:00.000Z",
      updatedAt: "2026-11-08T02:55:02.000Z",
    });
    const child = (extra: Partial<ExecutionRecord> = {}) =>
      sub("20261107_185502_8edf29", "unknown", {
        delegationId: null,
        childSessionId: "20261107_185502_8edf29",
        title: "Subagent: Write the bet",
        startedAt: "2026-11-08T02:55:03.000Z",
        updatedAt: "2026-11-08T03:10:00.000Z",
        ...extra,
      });
    expect(syncDelegatedRuns(owner, "api_m", "momentumchief", [dispatch, child()], new Date("2026-11-08T03:11:00Z"))).toBe(1);
    expect(runsOf(area.id).map((r) => [r.delegationId, r.state])).toEqual([["sub:api_m:sa-0-1df9", "running"]]);
    syncDelegatedRuns(
      owner,
      "api_m",
      "momentumchief",
      [dispatch, child({ endedAt: "2026-11-08T03:27:10.000Z", updatedAt: "2026-11-08T03:27:10.000Z" })],
      new Date("2026-11-08T04:00:00Z"),
    );
    expect(runsOf(area.id).map((r) => [r.delegationId, r.state, r.finishedAt])).toEqual([["sub:api_m:sa-0-1df9", "done", "2026-11-08T03:27:10.000Z"]]);
  });

  it("never lets a time-only fallback take another task's child session (title matches win)", () => {
    const area = store.createItem(owner, { kind: "area", title: "Pairs" }, cid);
    store.placeConversation(owner, { sessionId: "api_p", parentId: area.id, title: "Pairs coordinator" }, cid);
    const at = "2026-11-08T02:55:00.000Z";
    const a = sub("sa-0-x", "running", { delegationId: "deleg_p", subagentId: "sa-0-x", title: "Task A", startedAt: at });
    const b = sub("sa-1-x", "running", { delegationId: "deleg_p", subagentId: "sa-1-x", title: "Task B", startedAt: at });
    const childB = sub("child_b", "unknown", {
      delegationId: null,
      childSessionId: "child_b",
      title: "Subagent: Task B",
      startedAt: "2026-11-08T02:55:04.000Z",
      endedAt: "2026-11-08T03:20:00.000Z",
      updatedAt: "2026-11-08T03:20:00.000Z",
    });
    syncDelegatedRuns(owner, "api_p", "devchief", [a, b, childB], new Date("2026-11-08T04:00:00Z"));
    const rows = runsOf(area.id);
    expect(rows.find((r) => r.delegationId === "sub:api_p:sa-0-x")?.state).toBe("running");
    expect(rows.find((r) => r.delegationId === "sub:api_p:sa-1-x")?.state).toBe("done");
  });

  it("back-fill (#258): old unfinished children are not mirrored; old children with a known end are mirrored terminal", () => {
    const area = store.createItem(owner, { kind: "area", title: "Backfill" }, cid);
    store.placeConversation(owner, { sessionId: "api_bf", parentId: area.id, title: "Backfill coordinator" }, cid);
    const now = new Date("2026-11-09T01:00:00Z");
    const old = "2026-11-05T13:45:00.000Z";
    const lost = sub("sa-0-lost", "running", { delegationId: "deleg_l", subagentId: "sa-0-lost", title: "Lost task", startedAt: old, updatedAt: old });
    const ended = sub("sa-0-end", "running", { delegationId: "deleg_e", subagentId: "sa-0-end", title: "Ended task", startedAt: old, updatedAt: old });
    const endedChild = sub("child_end", "unknown", {
      delegationId: null,
      childSessionId: "child_end",
      title: "Subagent: Ended task",
      startedAt: "2026-11-05T13:45:01.000Z",
      endedAt: "2026-11-05T14:10:00.000Z",
      updatedAt: "2026-11-05T14:10:00.000Z",
    });
    const failedOld = sub("sa-0-fail", "failed", { delegationId: "deleg_f", subagentId: "sa-0-fail", startedAt: old, updatedAt: old, error: "boom" });
    const fresh = sub("sa-0-new", "running", { delegationId: "deleg_n", subagentId: "sa-0-new", startedAt: "2026-11-09T00:40:00.000Z" });
    syncDelegatedRuns(owner, "api_bf", "chiefofstaff", [lost, ended, endedChild, failedOld, fresh], now);
    const rows = runsOf(area.id);
    expect(rows.map((r) => [r.delegationId, r.state, r.finishedAt]).sort()).toEqual([
      ["sub:api_bf:sa-0-end", "done", "2026-11-05T14:10:00.000Z"],
      ["sub:api_bf:sa-0-fail", "failed", old],
      ["sub:api_bf:sa-0-new", "running", null],
    ]);
    // an existing open mirror whose child went silent for over a day is withdrawn on the next read
    syncDelegatedRuns(owner, "api_bf", "chiefofstaff", [fresh], now);
    expect(syncDelegatedRuns(owner, "api_bf", "chiefofstaff", [fresh], new Date("2026-11-10T02:00:00Z"))).toBe(1);
    expect(runsOf(area.id).some((r) => r.delegationId === "sub:api_bf:sa-0-new")).toBe(false);
  });

  it("reconcile sweep (#258) settles release-65 back-filled mirrors from persisted records, once, without touching agent registrations", async () => {
    __resetReconcile();
    const area = store.createItem(owner, { kind: "area", title: "Sweep" }, cid);
    store.placeConversation(owner, { sessionId: "api_sw", parentId: area.id, title: "Sweep coordinator" }, cid);
    const then = new Date("2026-11-05T13:50:00Z");
    const now = new Date("2026-11-09T01:00:00Z");
    const at = "2026-11-05T13:45:00.000Z";
    const lost = sub("sa-0-lost", "running", { delegationId: "deleg_l", subagentId: "sa-0-lost", title: "Lost task", startedAt: at, updatedAt: at });
    const ended = sub("sa-0-end", "running", { delegationId: "deleg_e", subagentId: "sa-0-end", title: "Ended task", startedAt: at, updatedAt: at });
    const child = sub("child_end", "unknown", {
      delegationId: null,
      childSessionId: "child_end",
      title: "Subagent: Ended task",
      startedAt: "2026-11-05T13:45:01.000Z",
      updatedAt: "2026-11-05T13:46:00.000Z",
    });
    // What release 65 left behind: mirrors registered as running with their historical start (stalled ever since).
    syncDelegatedRuns(owner, "api_sw", "chiefofstaff", [lost, ended, child], then);
    expect(runsOf(area.id).map((r) => r.state)).toEqual(["running", "running"]);
    // Persisted evidence now: the paired child session ended; the other dispatch never reported back.
    upsertExecution("api_sw", lost, "chiefofstaff");
    upsertExecution("api_sw", ended, "chiefofstaff");
    upsertExecution("api_sw", { ...child, endedAt: "2026-11-05T14:12:56.000Z", updatedAt: "2026-11-05T14:12:56.000Z" }, "chiefofstaff");
    registerAgentRun(owner, "momentumchief", { itemId: area.id, title: "Token-owned", delegationId: "deleg_tok" }, cid, "tok_1", then);
    const recent = sub("sa-0-live", "running", { delegationId: "deleg_v", subagentId: "sa-0-live", startedAt: "2026-11-09T00:30:00.000Z" });
    syncDelegatedRuns(owner, "api_sw", "chiefofstaff", [recent], new Date("2026-11-09T00:30:00Z"));
    // More than one page (200) of newer records: the old child's end is still found (Codex P2).
    for (let i = 0; i < 205; i++)
      upsertExecution("api_sw", sub(`f${i}`, "completed", { delegationId: `deleg_f${i}`, updatedAt: "2026-11-08T00:00:00.000Z" }), "chiefofstaff");
    const read = vi.fn(async () => 0);
    await reconcileDelegatedRuns(now, read).done;
    const rows = runsOf(area.id);
    expect(rows.map((r) => [r.delegationId, r.state, r.finishedAt]).sort()).toEqual([
      ["deleg_tok", "running", null],
      ["sub:api_sw:sa-0-end", "done", "2026-11-05T14:12:56.000Z"],
      ["sub:api_sw:sa-0-live", "running", null],
    ]);
    expect(sweepStaleMirrors(now)).toEqual({ closed: 0, removed: 0 });
  });

  it("pairs ended children whose session title Hermes truncated with an ellipsis (#261: prod sa-0/sa-1 titles)", () => {
    const area = store.createItem(owner, { kind: "area", title: "Truncated" }, cid);
    store.placeConversation(owner, { sessionId: "api_tr", parentId: area.id, title: "Truncated coordinator" }, cid);
    const at = "2026-11-06T16:41:20.000Z";
    const goalA = "Resume owning Jarvis Phase 2 implementation from the handoff and ship the board";
    const goalB = "Review the Phase 2 board for regressions and post findings on the PR";
    const a = sub("sa-0-53892b77", "running", { delegationId: "deleg_t", subagentId: "sa-0-53892b77", title: goalA, startedAt: at, updatedAt: at });
    const b = sub("sa-1-ff85b8a7", "running", { delegationId: "deleg_t", subagentId: "sa-1-ff85b8a7", title: goalB, startedAt: at, updatedAt: at });
    const child = (id: string, title: string, end: string) =>
      sub(id, "unknown", { delegationId: null, childSessionId: id, title, startedAt: "2026-11-06T16:41:23.000Z", endedAt: end, updatedAt: end });
    const ca = child("20261106_164123_0e04e3", "Subagent: Resume owning Jarvis Phase 2 implementation…", "2026-11-06T18:02:00.000Z");
    const cb = child("20261106_164123_451eb3", "Subagent: Review the Phase 2 board for regressi...", "2026-11-06T17:30:00.000Z");
    syncDelegatedRuns(owner, "api_tr", "devchief", [a, b, ca, cb], new Date("2026-11-09T01:00:00Z"));
    expect(
      runsOf(area.id)
        .map((r) => [r.delegationId, r.state, r.finishedAt])
        .sort(),
    ).toEqual([
      ["sub:api_tr:sa-0-53892b77", "done", "2026-11-06T18:02:00.000Z"],
      ["sub:api_tr:sa-1-ff85b8a7", "done", "2026-11-06T17:30:00.000Z"],
    ]);
  });

  it("a truncated title shared by two dispatches pairs neither by title; a too-short prefix never matches", () => {
    expect(sameTaskTitle("Subagent: Resume owning Jarvis…", "Resume owning Jarvis Phase 2")).toBe(true);
    expect(sameTaskTitle("Subagent: Resume…", "Resume owning Jarvis Phase 2")).toBe(false);
    expect(sameTaskTitle("Subagent: Resume owning Jarvis", "Resume owning Jarvis Phase 2")).toBe(false);
    expect(sameTaskTitle("Subagent: Task B", "task b")).toBe(true);
    const area = store.createItem(owner, { kind: "area", title: "Ambiguous" }, cid);
    store.placeConversation(owner, { sessionId: "api_am", parentId: area.id, title: "Ambiguous coordinator" }, cid);
    const at = "2026-11-08T02:55:00.000Z";
    const a = sub("sa-0-am", "running", { delegationId: "deleg_am", subagentId: "sa-0-am", title: "Audit the release clone for drift", startedAt: at });
    const b = sub("sa-1-am", "running", { delegationId: "deleg_am", subagentId: "sa-1-am", title: "Audit the release clone for secrets", startedAt: at });
    const c = sub("child_am", "unknown", {
      delegationId: null,
      childSessionId: "child_am",
      title: "Subagent: Audit the release clone for…",
      startedAt: "2026-11-08T02:55:02.000Z",
      endedAt: "2026-11-08T03:00:00.000Z",
      updatedAt: "2026-11-08T03:00:00.000Z",
    });
    syncDelegatedRuns(owner, "api_am", "devchief", [a, b, c], new Date("2026-11-08T04:00:00Z"));
    expect(
      runsOf(area.id)
        .map((r) => r.state)
        .sort(),
    ).toEqual(["running", "running"]);
  });

  it("sweep (#260) heartbeats kept live mirrors so they leave the stale batch", () => {
    const area = store.createItem(owner, { kind: "area", title: "Heartbeat" }, cid);
    store.placeConversation(owner, { sessionId: "api_hb", parentId: area.id, title: "Heartbeat coordinator" }, cid);
    const then = new Date("2026-11-07T00:00:00Z");
    const now = new Date("2026-11-09T01:00:00Z");
    const live = sub("sa-0-hb", "running", {
      delegationId: "deleg_hb",
      subagentId: "sa-0-hb",
      title: "Long task",
      startedAt: then.toISOString(),
      updatedAt: then.toISOString(),
    });
    syncDelegatedRuns(owner, "api_hb", "chiefofstaff", [live], then);
    // the persisted record shows activity an hour ago, but the mirror row was never touched since
    upsertExecution("api_hb", { ...live, updatedAt: "2026-11-09T00:00:00.000Z" }, "chiefofstaff");
    expect(sweepStaleMirrors(now)).toEqual({ closed: 0, removed: 0 });
    const row = runsOf(area.id).find((r) => r.delegationId === "sub:api_hb:sa-0-hb")!;
    expect([row.state, row.updatedAt]).toEqual(["running", "2026-11-09T00:00:00.000Z"]);
  });
});
