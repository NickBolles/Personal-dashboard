import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, userById } from "@/server/auth";
import { createPerson } from "@/server/people";
import { HermesExecutionClient, HermesSessionClient } from "@/integrations/hermes/client";
import { normalizeRunEvent } from "@/integrations/hermes/normalize";
import { getSessionDetail, getSessionSummary, relayRunEvents, sessionAccess, sessionProfile } from "@/integrations/hermes/service";
import { reduceRun, type RunState } from "@/components/chat/useRunStream";
import { executionRecords, upsertExecution } from "@/server/chat/execution-store";
import { backfillExecutions } from "@/server/chat/execution-backfill";
import { chatExecution } from "@/server/chat/execution";
import * as executionRoute from "@/app/api/hermes/sessions/[id]/execution/route";
import * as conversationsRoute from "@/app/api/work/conversations/route";
import { createItem } from "@/server/work/store";
import { writeIndex } from "@/server/work/conversation-index";
import { __resetConversationCache } from "@/server/work/conversations";
import type { ChatExecutionResponse } from "@/lib/chat-execution";
import type { ConversationListResponse } from "@/lib/work";
import type { SessionSummary } from "@/lib/hermes";

vi.mock("@/server/agents/routing", async (original) => ({
  ...(await original<typeof import("@/server/agents/routing")>()),
  connForProfile: (profile: string | null) => ({ baseUrl: `http://unit.invalid/${profile ?? "default"}` }),
}));

let owner: string;
let other: string;
const me = () => userById(owner)!;
const at = "2026-11-01T00:00:00.000Z";
const later = "2026-11-01T00:00:01.000Z";
const identity = {
  subagent_id: "sa-1",
  child_session_id: "child-1",
  delegation_id: "deleg-1",
  parent_id: "root",
  task_index: 0,
  task_count: 2,
  duration_seconds: 1,
};

beforeEach(() => {
  __setTestDatabase();
  __resetConversationCache();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-other" }, owner).id;
  getDb().insert(schema.sessionMeta).values({ sessionId: "parent-1", userId: owner, hermesProfile: "devchief" }).run();
  vi.spyOn(HermesSessionClient, "get").mockImplementation(async (conn, id) => {
    if (id === "child-1" && conn.baseUrl !== "http://unit.invalid/devchief") throw new Error("wrong profile");
    return { session: { id, title: id, source: "api_server" } };
  });
  vi.spyOn(HermesSessionClient, "messages").mockResolvedValue({ data: [] });
  vi.spyOn(HermesSessionClient, "list").mockRejectedValue(new Error("A chat open must not list sessions"));
});
afterEach(() => vi.restoreAllMocks());

async function call(handler: typeof executionRoute.GET | typeof conversationsRoute.GET, id = "parent-1", userId = owner, query = "") {
  const req = new NextRequest(`http://jarvis.test/api/test${query}`, { headers: { cookie: `jarvis_session=${createSession(userId).token}` } });
  return handler(req, { params: Promise.resolve({ id }) });
}
async function relay(events: Record<string, unknown>[], runId = "run-1") {
  getDb()
    .insert(schema.runs)
    .values({ runId, sessionId: "parent-1", userId: owner, hermesProfile: "devchief", idempotencyKey: runId, status: "running" })
    .onConflictDoNothing()
    .run();
  vi.spyOn(HermesExecutionClient, "events").mockResolvedValue(
    new Response(events.map((event, seq) => `data: ${JSON.stringify({ ...event, seq })}\n\n`).join("")),
  );
  return new Response(relayRunEvents(me(), runId, undefined, new AbortController().signal)).text();
}

describe("durable execution identity", () => {
  it("normalizes every child field and carries it through the activity reducer", () => {
    const started = normalizeRunEvent({ event: "subagent.start", ...identity, timestamp: 1 });
    const completed = normalizeRunEvent({ event: "subagent.complete", ...identity, status: "success", timestamp: 2 });
    const fields = { childSessionId: "child-1", delegationId: "deleg-1", parentId: "root", taskIndex: 0, taskCount: 2, durationSec: 1 };
    expect(started).toMatchObject(fields);
    expect(completed).toMatchObject(fields);
    let state: RunState = { phase: "running", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 };
    state = reduceRun(state, { type: "event", event: started });
    state = reduceRun(state, { type: "event", event: completed });
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toMatchObject(fields);
    expect(normalizeRunEvent({ event: "tool.started", tool_call_id: "call-1", timestamp: 1 })).toMatchObject({ callId: "call-1" });
    expect(normalizeRunEvent({ event: "subagent.complete", duration: 3 })).toMatchObject({ durationSec: 3 });
  });

  it("matches replayed activities by child/delegation identity, not by a repeated goal", () => {
    let state: RunState = { phase: "running", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 };
    const first = { type: "subagent.started" as const, childSessionId: "child-a", delegationId: "deleg-a", taskIndex: 0, goal: "Same goal", at };
    const second = { ...first, childSessionId: "child-b", taskIndex: 1 };
    for (const event of [first, second, second]) state = reduceRun(state, { type: "event", event });
    state = reduceRun(state, { type: "event", event: { ...second, type: "subagent.completed", status: "completed", summary: "Second result" } });
    expect(state.activity).toHaveLength(2);
    expect(state.activity[0]).toMatchObject({ childSessionId: "child-a", done: false });
    expect(state.activity[1]).toMatchObject({ childSessionId: "child-b", done: true, summary: "Second result" });
    state = reduceRun(state, { type: "event", event: second });
    expect(state.activity).toHaveLength(2);
    expect(state.activity[1]).toMatchObject({ done: true });
  });

  it("relays started → completed exactly once, survives replay and routes the child to its parent's profile", async () => {
    const events = [
      { event: "subagent.start", ...identity, goal: "Bounded task", timestamp: 1 },
      { event: "subagent.complete", ...identity, goal: "Bounded task", status: "completed", summary: "Done", timestamp: 2 },
      { event: "run.completed", timestamp: 3 },
    ];
    await relay(events);
    await relay(events);
    expect(executionRecords("parent-1")).toHaveLength(1);
    expect(executionRecords("parent-1")[0]).toMatchObject({ state: "completed", childSessionId: "child-1", childProfile: "devchief", summary: "Done" });
    expect(sessionProfile("child-1")).toBe("devchief");
    const child = await getSessionDetail(me(), "child-1");
    expect(child.session.agentProfile).toBe("devchief");
    expect(child.parent?.id).toBe("parent-1");
    expect(HermesSessionClient.list).not.toHaveBeenCalled();
  });

  it("parent completion does not complete an unfinished child; an unknown child status stays unknown", async () => {
    await relay([
      { event: "subagent.start", ...identity, timestamp: 1 },
      { event: "run.completed", timestamp: 2 },
    ]);
    expect(executionRecords("parent-1")[0]?.state).toBe("running");
    await relay([
      { event: "subagent.complete", ...identity, status: "unrecognised", timestamp: 3 },
      { event: "run.completed", timestamp: 4 },
    ]);
    expect(executionRecords("parent-1")[0]).toMatchObject({ state: "unknown", endedAt: null });
    await relay([{ event: "subagent.start", ...identity, timestamp: 1 }]);
    expect(executionRecords("parent-1")[0]?.state).toBe("unknown");
  });

  it("retains immediate lineage for nested agents instead of treating runtime parent_id as a chat id", async () => {
    await relay([
      { event: "subagent.start", ...identity, timestamp: 1 },
      { event: "subagent.start", ...identity, subagent_id: "sa-nested", child_session_id: "nested-1", parent_id: "sa-1", timestamp: 2 },
    ]);
    expect(executionRecords("parent-1")).toHaveLength(1);
    expect(executionRecords("child-1")[0]?.childSessionId).toBe("nested-1");
    expect(sessionProfile("nested-1")).toBe("devchief");
    expect((await chatExecution(me(), "nested-1")).parent?.id).toBe("child-1");
  });

  it("dedupes list-discovered child ids and handle-only events when a later event bridges them", async () => {
    upsertExecution(
      "parent-1",
      { key: "subagent:child-1", source: "subagent", id: "child-1", childSessionId: "child-1", title: "Child", state: "unknown", updatedAt: at },
      "devchief",
    );
    await relay([{ event: "subagent.start", subagent_id: "sa-1", timestamp: 1 }]);
    await relay([{ event: "subagent.complete", ...identity, status: "completed", timestamp: 2 }]);
    expect(executionRecords("parent-1")).toHaveLength(1);
    expect(executionRecords("parent-1")[0]?.state).toBe("completed");
  });

  it.each([
    ["success", "completed"],
    ["error", "failed"],
    ["interrupted", "cancelled"],
    ["mystery", "unknown"],
    ["running", "unknown"],
    ["waiting", "unknown"],
  ])("maps %s without success inference", async (status, expected) => {
    await relay([{ event: "subagent.complete", ...identity, status, timestamp: 1 }]);
    expect(executionRecords("parent-1")[0]?.state).toBe(expected);
  });

  it("backfills notices and complete delegate tool JSON, deduping live and durable identities", async () => {
    await relay([{ event: "subagent.start", ...identity, timestamp: 1 }]);
    const timeline = [
      {
        kind: "tool" as const,
        id: "tool-1",
        tool: "delegate_task",
        summary: "",
        detail: JSON.stringify({
          delegation_id: "deleg-1",
          results: [{ ...identity, task_index: 0, status: "completed", summary: "See https://github.com/o/r/pull/1", live_transcript: "/host/task.log" }],
        }),
        at: later,
      },
      {
        kind: "user" as const,
        id: "notice-1",
        at: later,
        text: "[ASYNC DELEGATION COMPLETE — deleg-1]\nOriginal goal: Task\nStatus: completed   Duration: 1s\nDone\nFull live transcript (complete tool/assistant trace): /host/task.log",
      },
      {
        kind: "user" as const,
        id: "process-1",
        at: later,
        text: "[IMPORTANT: 2 background processes completed. Treat these results as one batch.]\n\n[IMPORTANT: Background process p1 completed (exit code 0).\nCommand: tests\nTranscript: /host/p1.log\nOutput:\nok]\n\n[IMPORTANT: Background process p2 completed (exit code 1).\nCommand: check\nOutput:\nfailed]",
      },
    ];
    backfillExecutions("parent-1", timeline, "devchief");
    backfillExecutions("parent-1", timeline, "devchief");
    const rows = executionRecords("parent-1");
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.source === "subagent")).toMatchObject({
      state: "completed",
      childSessionId: "child-1",
      transcriptPath: "/host/task.log",
      links: [{ url: "https://github.com/o/r/pull/1", kind: "github" }],
    });
    expect(rows.find((r) => r.id === "p1")).toMatchObject({ source: "process", state: "completed", transcriptPath: "/host/p1.log", href: null });
    expect(rows.find((r) => r.id === "p2")).toMatchObject({ state: "failed", error: "failed" });
  });

  it("prioritizes recent outcomes within the backfill cap and preserves explicit cancellation", () => {
    const timeline = Array.from({ length: 220 }, (_, i) => ({
      kind: "user" as const,
      id: `notice-${i}`,
      at,
      text: `[Background process p${i} heartbeat #1 — still running after 1s.\nCommand: check\nOutput since last heartbeat:\nworking]`,
    }));
    timeline.push({
      kind: "user",
      id: "cancelled",
      at: later,
      text: "[IMPORTANT: Background process cancelled-proc terminated by owner (exit code 0).\nCommand: check\nOutput:\nstopped]",
    });
    expect(backfillExecutions("parent-1", timeline, "devchief")).toBe(200);
    expect(executionRecords("parent-1").find((r) => r.id === "cancelled-proc")).toMatchObject({ state: "cancelled", endedAt: later });
    expect(executionRecords("parent-1").some((r) => r.id === "p0")).toBe(false);
  });

  it("a durable completion notice with an unknown status does not leave a live child running", async () => {
    await relay([{ event: "subagent.start", ...identity, timestamp: 1 }]);
    backfillExecutions(
      "parent-1",
      [
        {
          kind: "user",
          id: "unknown-outcome",
          at: later,
          text: "[ASYNC DELEGATION COMPLETE — deleg-1]\nOriginal goal: Task\nStatus: unexpected   Duration: 1s\nOutcome unavailable",
        },
      ],
      "devchief",
    );
    expect(executionRecords("parent-1")[0]).toMatchObject({ state: "unknown", endedAt: null });
  });

  it("caps backfill, rejects truncated JSON, and does not invent a child id for the inspected host's dispatch payload", () => {
    backfillExecutions("parent-1", [{ kind: "tool", id: "bad", tool: "delegate_task", summary: "", detail: '{"child_session_id":"child-1"' }], "devchief");
    expect(executionRecords("parent-1")).toEqual([]);
    const n = backfillExecutions(
      "parent-1",
      [
        {
          kind: "tool",
          id: "dispatch",
          tool: "delegate_task",
          summary: "",
          detail: JSON.stringify({
            status: "dispatched",
            delegation_id: "deleg-host",
            subagent_ids: Array.from({ length: 250 }, (_, i) => `sa-${i}`),
            goals: ["Task"],
            live_transcripts: ["/host/task.log"],
          }),
        },
      ],
      "devchief",
    );
    expect(n).toBe(200);
    expect(executionRecords("parent-1")).toHaveLength(200);
    expect(executionRecords("parent-1").every((r) => !r.childSessionId && r.state === "running")).toBe(true);
  });
});

describe("execution endpoint", () => {
  it("merges persisted children, forks, registered runs and exact-session Jarvis runs with bounded safe output", async () => {
    upsertExecution(
      "parent-1",
      {
        key: "subagent:sa-1",
        id: "sa-1",
        source: "subagent",
        title: "Task",
        childSessionId: "child-1",
        state: "completed",
        summary: "🌊".repeat(5000),
        error: "🌊".repeat(3000),
        updatedAt: at,
      },
      "devchief",
    );
    getDb().insert(schema.sessionMeta).values({ sessionId: "fork-1", userId: owner, forkedFromSessionId: "parent-1" }).run();
    const area = createItem(me(), { kind: "area", title: "Dev" }, "test");
    const item = createItem(me(), { kind: "thread", parentId: area.id, title: "Task" }, "test");
    getDb()
      .insert(schema.agentRuns)
      .values([
        {
          id: "reg-1",
          userId: owner,
          itemId: item.id,
          profile: "devchief",
          title: "Task",
          hermesSessionId: "child-1",
          state: "done",
          prUrl: "https://github.com/o/r/pull/2",
        },
        { id: "unrelated", userId: owner, itemId: item.id, profile: "devchief", title: "Task", hermesSessionId: "other-session" },
      ])
      .run();
    getDb().insert(schema.runs).values({ runId: "jrun", sessionId: "parent-1", userId: owner, idempotencyKey: "jrun", status: "failed" }).run();
    const res = await call(executionRoute.GET);
    expect(res.status).toBe(200);
    const out: ChatExecutionResponse = await res.json();
    expect(out.records.map((r) => r.source).sort()).toEqual(["fork", "jarvis_run", "registered_run", "subagent"]);
    expect(out.records.find((r) => r.id === "reg-1")).toMatchObject({
      state: "completed",
      href: `/areas?item=${item.id}`,
      links: [{ url: "https://github.com/o/r/pull/2", kind: "github" }],
    });
    const child = out.records.find((r) => r.id === "sa-1")!;
    expect(Buffer.byteLength(child.summary!)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(child.error!)).toBeLessThanOrEqual(2048);
    expect(out.sources.find((s) => s.source === "transcript")?.state).toBe("ok");
    expect(out.sources.find((s) => s.source === "hermes_children")?.state).toBe("stale");
    expect(HermesSessionClient.list).not.toHaveBeenCalled();
  });

  it("distinguishes an empty transcript from an unavailable source and keeps persisted results", async () => {
    const empty = await chatExecution(me(), "parent-1");
    expect(empty.records).toEqual([]);
    expect(empty.sources.find((s) => s.source === "transcript")?.state).toBe("ok");
    upsertExecution("parent-1", { key: "process:p", id: "p", source: "process", title: "Process", state: "running" }, null);
    vi.mocked(HermesSessionClient.messages).mockRejectedValue(new Error("offline"));
    const out = await chatExecution(me(), "parent-1");
    expect(out.records).toHaveLength(1);
    expect(out.sources.find((s) => s.source === "transcript")?.state).toBe("unavailable");
  });

  it("checks parent permission before fetching detail, including direct child URLs and return-to-parent", async () => {
    upsertExecution(
      "parent-1",
      { key: "subagent:sa-1", id: "sa-1", source: "subagent", title: "Task", childSessionId: "child-1", state: "running" },
      "devchief",
    );
    expect((await call(executionRoute.GET, "parent-1", other)).status).toBe(404);
    expect((await call(executionRoute.GET, "child-1", other)).status).toBe(404);
    await expect(getSessionDetail(userById(other)!, "child-1")).rejects.toThrow("Conversation not found");
    expect(HermesSessionClient.get).not.toHaveBeenCalled();
    getDb().update(schema.sessionMeta).set({ shared: true }).where(eq(schema.sessionMeta.sessionId, "parent-1")).run();
    expect(sessionAccess(userById(other)!, "child-1")).toBe("read");
    const out = await chatExecution(userById(other)!, "child-1");
    expect(out.parent).toMatchObject({ id: "parent-1", href: "/chat/parent-1" });
    getDb().update(schema.sessionMeta).set({ shared: false }).where(eq(schema.sessionMeta.sessionId, "parent-1")).run();
    expect(sessionAccess(userById(other)!, "child-1")).toBeNull();
  });

  it("checks the runtime parent before returning an unindexed child's detail or summary", async () => {
    getDb().insert(schema.sessionMeta).values({ sessionId: "other-parent", userId: other }).run();
    vi.mocked(HermesSessionClient.get).mockResolvedValue({ session: { id: "unindexed-child", source: "subagent", parent_session_id: "other-parent" } });
    await expect(getSessionDetail(me(), "unindexed-child")).rejects.toThrow("Conversation not found");
    await expect(getSessionSummary(me(), "unindexed-child")).rejects.toThrow("Conversation not found");
    expect((await call(executionRoute.GET, "unindexed-child")).status).toBe(404);
  });

  it("does not overwrite or leak an unrelated private child's mapping from transcript claims", async () => {
    getDb().insert(schema.sessionMeta).values({ sessionId: "private-child", userId: other, hermesProfile: "otherchief" }).run();
    backfillExecutions(
      "parent-1",
      [{ kind: "tool", id: "spoof", tool: "delegate_task", summary: "", detail: JSON.stringify({ child_session_id: "private-child", status: "completed" }) }],
      "devchief",
    );
    expect(executionRecords("parent-1")[0]?.childSessionId).toBeNull();
    expect(sessionProfile("private-child")).toBe("otherchief");
    expect((await call(executionRoute.GET, "private-child")).status).toBe(404);
  });
});

describe("#176 server filters", () => {
  it("filters area, unread and agents before the 100-row slice, with counts over the full area set", async () => {
    const area = createItem(me(), { kind: "area", title: "Area" }, "test");
    const project = createItem(me(), { kind: "project", title: "Project", parentId: area.id }, "test");
    const sessions: SessionSummary[] = Array.from({ length: 240 }, (_, i) => ({
      id: `filter-${i}`,
      title: `Conversation ${i}`,
      pinned: false,
      archived: false,
      lastActiveAt: at,
      agentProfile: i >= 110 ? "devchief" : undefined,
    }));
    getDb().insert(schema.conversationReads).values({ userId: owner, sessionId: "*", readAt: "2026-06-01T00:00:00Z" }).run();
    getDb()
      .insert(schema.conversationReads)
      .values(sessions.slice(0, 110).map((s) => ({ userId: owner, sessionId: s.id, readAt: later })))
      .run();
    // 125 rows in the selected area, all of its unread/agent rows are beyond the old 100-row slice.
    getDb()
      .insert(schema.workItems)
      .values(
        sessions.slice(0, 125).map((s) => ({ id: `node-${s.id}`, userId: owner, parentId: project.id, kind: "conversation", title: s.title, sessionId: s.id })),
      )
      .run();
    writeIndex(owner, sessions, true);
    const get = async (view: string, areaId = area.id) => {
      const res = await call(conversationsRoute.GET, "unused", owner, `?view=${view}&areaId=${areaId}`);
      expect(res.status).toBe(200);
      return res.json() as Promise<ConversationListResponse>;
    };
    const all = await get("all");
    const unread = await get("unread");
    const agents = await get("agents");
    expect(all.conversations).toHaveLength(100);
    expect(unread.conversations).toHaveLength(15);
    expect(agents.conversations).toHaveLength(15);
    expect(unread.conversations.every((c) => c.unread && c.agentProfile === "devchief")).toBe(true);
    expect(all.counts).toEqual({ unread: 15, agents: 15 });
    expect(unread.counts).toEqual(all.counts);
    expect(agents.counts).toEqual(all.counts);
    expect((await get("all", "not-your-area")).counts).toEqual({ unread: 0, agents: 0 });
    const legacy = await call(conversationsRoute.GET, "unused", owner, "?areaId=not-your-area");
    expect((await legacy.json()).conversations).toEqual([]);
    const unscoped = await call(conversationsRoute.GET, "unused", owner, "?view=agents");
    expect((await unscoped.json()).conversations).toHaveLength(100);
    expect(HermesSessionClient.list).not.toHaveBeenCalled();
  });
});
