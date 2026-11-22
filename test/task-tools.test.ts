/**
 * Task threads, step 2: bots work in the task's chat. The three agent tools (start, steer, hand off), their limits,
 * and Undo. The first block runs against the in-process mock Hermes (the real path, through /api/mcp); the second
 * uses stand-ins for the assistant so each rule can be checked on its own.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { MOCK_PROFILE_KEYS } from "../mock-upstreams/hermes.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import { getSessionDetail } from "@/server/assistant";
import { saveAgentSettings } from "@/server/agents/routing";
import { suggestedKeyEnv } from "@/lib/agents";
import * as store from "@/server/work/store";
import { __resetAgentRate, agentFromToken, capabilitiesForScopes, mintAgentToken } from "@/server/agent-access/tokens";
import { TOOLS } from "@/server/agent-access/tools";
import { withVia } from "@/server/work/actor";
import { TASK_STARTS_PER_DAY, briefFooter, startTask, steerTask, workerFor, type TaskCaller, type TaskRunDeps } from "@/server/work/task-runs";
import { agentRuns } from "@/server/work/agent-runs";
import * as mcpRoute from "@/app/api/mcp/route";
import type { AgentScope } from "@/lib/agent-access";
import type { WorkItem } from "@/lib/work";

const cid = "test";
const KEY_ENV = suggestedKeyEnv("momentumchief");
const WITH_TASKS: AgentScope[] = ["work.read", "work.write", "runs.write", "tasks.run"];

let server: Server;
let owner: CurrentUser;
let n = 0;

function mcp(token: string, body: unknown) {
  return mcpRoute.POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp(token, { jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
  const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary tool JSON
  return { isError: !!j.result.isError, value: JSON.parse(j.result.content[0]!.text) as Record<string, any> };
}
const row = (id: string) => getDb().select().from(schema.workItems).where(eq(schema.workItems.id, id)).get()!;
const item = (id: string): WorkItem => store.toItem(row(id));
const runsOf = (itemId: string) => getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.itemId, itemId)).all();

function tree() {
  const area = store.createItem(owner, { kind: "area", title: "Portfolio" }, cid);
  store.updateItem(owner, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
  const project = store.createItem(owner, { kind: "project", title: "Ops", parentId: area.id }, cid);
  const task = store.createItem(owner, { kind: "thread", title: "Audit preview deployments", parentId: project.id }, cid);
  return { area, project, task };
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  process.env.JARVIS_MOCK_UPSTREAM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env[KEY_ENV];
  server?.close();
});
beforeEach(() => {
  __setTestDatabase();
  __resetAgentRate();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  const h = demoPresets()!.hermes!;
  saveIntegration("hermes", { enabled: true, config: h.config, secrets: h.secrets });
  process.env[KEY_ENV] = MOCK_PROFILE_KEYS.momentumchief;
  saveAgentSettings({ routing: true, aguiStream: false, routes: [{ profile: "momentumchief", keyEnv: KEY_ENV, baseUrl: null }] });
});

describe("scope", () => {
  it("the task tools need tasks.run, which is not a default scope and brings the chat capability", async () => {
    const without = mintAgentToken(owner, { name: "CoS", profile: "chiefofstaff", scopes: ["work.read", "work.write", "runs.write"] }, cid).token;
    const withTasks = mintAgentToken(owner, { name: "CoS tasks", profile: "chiefofstaff", scopes: WITH_TASKS }, cid).token;
    const names = async (token: string) =>
      ((await (await mcp(token, { jsonrpc: "2.0", id: ++n, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (t) => t.name,
      );
    const taskTools = ["jarvis_start_task", "jarvis_steer_task", "jarvis_hand_off"];
    expect((await names(without)).filter((t) => taskTools.includes(t))).toEqual([]);
    expect((await names(withTasks)).filter((t) => taskTools.includes(t))).toEqual(taskTools);
    expect(TOOLS.filter((t) => taskTools.includes(t.name)).every((t) => t.scope === "tasks.run")).toBe(true);
    const { task } = tree();
    const refused = await call(without, "jarvis_start_task", { itemId: task.id, brief: "Audit them" });
    expect(refused.isError).toBe(true);
    expect(capabilitiesForScopes(["tasks.run"], owner.capabilities).has("hermes.chat")).toBe(true);
    expect(capabilitiesForScopes(["work.read"], owner.capabilities).has("hermes.chat")).toBe(false);
  });
});

describe("start a task (through MCP, against the mock assistant)", () => {
  it("opens the task's own chat on the area's agent with the brief, registers the run there, and can be undone", async () => {
    const { task } = tree();
    const token = mintAgentToken(owner, { name: "CoS", profile: "chiefofstaff", scopes: WITH_TASKS }, cid).token;
    const started = await call(token, "jarvis_start_task", { itemId: task.id, brief: "List the live previews and which still get traffic." });
    expect(started.isError).toBe(false);
    const { sessionId, runId, ref, worker, href, undoOpId } = started.value;
    expect(worker).toBe("momentumchief");
    expect(href).toBe(`/areas?item=${task.id}&tab=chat`);
    expect(ref).toMatch(/^R-\d+$/);
    // The chat is the task's primary chat, filed under it, on the agent that answers for the area.
    expect(row(task.id).primarySessionId).toBe(sessionId);
    expect(store.conversationNodes(owner.id).get(sessionId)?.parentId).toBe(task.id);
    expect(getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, sessionId)).get()?.hermesProfile).toBe("momentumchief");
    // The run is registered on the task, in that chat, under the WORKING agent's profile (so it can report on it).
    const run = runsOf(task.id).find((r) => r.id === runId)!;
    expect(run).toMatchObject({ profile: "momentumchief", hermesSessionId: sessionId, state: "running" });
    expect(run.delegationId).toMatch(new RegExp(`^task:${task.id}:`));
    expect(agentRuns(owner).items[task.id]?.sessionId).toBe(sessionId);
    // The brief went into the chat, with how to report back.
    const detail = await getSessionDetail(owner, sessionId);
    const first = detail.timeline.find((t) => t.kind === "user");
    expect(first && "text" in first ? first.text : "").toContain("List the live previews and which still get traffic.");
    expect(first && "text" in first ? first.text : "").toContain(`jarvis_run_event (runId ${ref})`);
    // The owner sees it in Activity terms: an event on the task, by the bot that started it, with an undo.
    const events = store.getDetail(owner.id, task.id).events;
    expect(events.some((e) => e.reason === "Started in its chat: Audit preview deployments")).toBe(true);
    expect(undoOpId).toBeTruthy();
    const op = getDb().select().from(schema.workOps).where(eq(schema.workOps.id, undoOpId)).get()!;
    expect(op).toMatchObject({ kind: "task_start", via: "agent:chiefofstaff" });
    // Undo: the run stops being "working" at once; the chat stays the task's chat.
    const undone = store.undoOp(owner, undoOpId, cid);
    expect(undone).toMatchObject({ kind: "task_start", stopRunId: expect.any(String) });
    expect(runsOf(task.id).find((r) => r.id === runId)).toMatchObject({ state: "done", summary: "Stopped: you undid this start" });
    expect(row(task.id).primarySessionId).toBe(sessionId);
  });

  it("an area without a coordinator is served by the Chief of staff's agent", () => {
    const { task } = tree();
    const bare = store.createItem(owner, { kind: "area", title: "Garden" }, cid);
    const loose = store.createItem(owner, { kind: "thread", title: "Order mulch", parentId: bare.id }, cid);
    // "Portfolio" is the Chief of staff's area here (the same rule the Chief of staff panel uses).
    expect(workerFor(owner, item(task.id))).toBe("momentumchief");
    expect(workerFor(owner, item(loose.id))).toBe("momentumchief");
    // An assignee that is a routed agent wins; one that is not routed does not.
    store.updateItem(owner, loose.id, { assignee: "agent:momentumchief" }, cid);
    expect(workerFor(owner, item(loose.id))).toBe("momentumchief");
  });
});

describe("the rules, one at a time", () => {
  let profiles: Map<string, string | null>;
  let sent: { sessionId: string; input: string; idempotencyKey: string }[];
  let steered: { runId: string; input: string }[];
  let deps: TaskRunDeps;
  let caller: TaskCaller;
  const chat = (itemId: string, profile: string | null) => {
    const sessionId = `sess-${profiles.size + 1}`;
    profiles.set(sessionId, profile);
    store.placeConversation(owner, { sessionId, parentId: itemId, title: "Chat" }, cid);
    getDb().update(schema.workItems).set({ primarySessionId: sessionId }).where(eq(schema.workItems.id, itemId)).run();
    return sessionId;
  };
  const hermesRun = (sessionId: string, status: string) =>
    getDb()
      .insert(schema.runs)
      .values({ runId: `hr-${sessionId}-${status}`, sessionId, userId: owner.id, idempotencyKey: `k-${sessionId}-${status}-${Math.random()}`, status })
      .run();
  const start = (it: WorkItem, input: Parameters<typeof startTask>[2], now?: Date) =>
    withVia("agent:chiefofstaff", () => startTask(caller, it, input, cid, deps, now));

  beforeEach(() => {
    profiles = new Map();
    sent = [];
    steered = [];
    const principal = agentFromToken(mintAgentToken(owner, { name: "CoS", profile: "chiefofstaff", scopes: WITH_TASKS }, cid).token)!;
    caller = { user: principal.user, profile: principal.profile, tokenId: principal.tokenId };
    deps = {
      ensureChat: async (_user, itemId, _backend, _cid, opts) => ({ sessionId: chat(itemId, opts?.profile ?? null), created: true }),
      replaceChat: async (_user, itemId, profile) => {
        const prev = row(itemId).primarySessionId ?? null;
        return { sessionId: chat(itemId, profile), prev };
      },
      startRun: (async (_user: CurrentUser, r: { sessionId: string; input: string; idempotencyKey: string }) => {
        sent.push(r);
        return { runId: `hr-${sent.length}`, status: "running" };
      }) as unknown as TaskRunDeps["startRun"],
      steerRun: (async (_user: CurrentUser, runId: string, input: string) => {
        steered.push({ runId, input });
        return null;
      }) as unknown as TaskRunDeps["steerRun"],
      sessionProfile: (sessionId) => profiles.get(sessionId) ?? null,
    };
  });

  it("refuses what is not a task that can be worked: areas, notes, closed or archived work, AI turned off", async () => {
    const { area, task } = tree();
    const note = store.createItem(owner, { kind: "note", title: "Notes", parentId: task.id }, cid);
    await expect(start(item(area.id), { brief: "x" })).rejects.toMatchObject({ code: "bad_item" });
    await expect(start(item(note.id), { brief: "x" })).rejects.toMatchObject({ code: "bad_item" });
    await expect(start(item(task.id), { brief: "   " })).rejects.toMatchObject({ code: "brief" });
    await expect(start(item(task.id), { brief: "use the key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({
      code: "credentials",
    });
    store.updateItem(owner, task.id, { status: "abandoned", reason: "No longer needed" }, cid);
    await expect(start(item(task.id), { brief: "x" })).rejects.toMatchObject({ code: "closed" });
    const closedArea = store.createItem(owner, { kind: "area", title: "Private" }, cid);
    const hidden = store.createItem(owner, { kind: "thread", title: "Hidden", parentId: closedArea.id }, cid);
    store.updateItem(owner, closedArea.id, { settings: { aiPolicy: "excluded" } } as never, cid);
    await expect(start(item(hidden.id), { brief: "x" })).rejects.toMatchObject({ code: "ai_off" });
    expect(sent).toEqual([]);
    expect(runsOf(task.id)).toEqual([]);
  });

  it("starts in the task's existing chat, and not while a run is in flight there", async () => {
    const { task } = tree();
    const sessionId = chat(task.id, "momentumchief");
    hermesRun(sessionId, "running");
    await expect(start(item(task.id), { brief: "Go" })).rejects.toMatchObject({ code: "already_working" });
    getDb().update(schema.runs).set({ status: "completed" }).where(eq(schema.runs.sessionId, sessionId)).run();
    const started = await start(item(task.id), { brief: "Go", title: "Second pass" });
    expect(started.sessionId).toBe(sessionId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId, idempotencyKey: `task:${started.runId}` });
    expect(sent[0]!.input.startsWith("Go\n\n---\n")).toBe(true);
    expect(sent[0]!.input).toContain(briefFooter({ id: task.id, title: "Audit preview deployments" }, started.ref));
    expect(runsOf(task.id).find((r) => r.id === started.runId)?.title).toBe("Second pass");
  });

  it("a run that could not be started is recorded as failed, not left reading as working", async () => {
    const { task } = tree();
    deps.startRun = (async () => {
      throw new Error("Hermes is not answering");
    }) as unknown as TaskRunDeps["startRun"];
    await expect(start(item(task.id), { brief: "Go" })).rejects.toThrow("Hermes is not answering");
    expect(runsOf(task.id)).toHaveLength(1);
    expect(runsOf(task.id)[0]).toMatchObject({ state: "failed", summary: "Couldn't start: Hermes is not answering" });
    expect(
      getDb()
        .select()
        .from(schema.workOps)
        .where(and(eq(schema.workOps.itemId, task.id), eq(schema.workOps.kind, "task_start")))
        .all(),
    ).toEqual([]);
  });

  it("stops at the daily cap", async () => {
    const { project } = tree();
    const now = new Date("2026-11-22T15:00:00Z");
    for (let i = 0; i < TASK_STARTS_PER_DAY; i++) {
      const t = store.createItem(owner, { kind: "thread", title: `Task ${i}`, parentId: project.id }, cid);
      await start(item(t.id), { brief: "Go" }, now);
    }
    const extra = store.createItem(owner, { kind: "thread", title: "One too many", parentId: project.id }, cid);
    await expect(start(item(extra.id), { brief: "Go" }, now)).rejects.toMatchObject({ code: "daily_cap" });
    // The next day starts a new count.
    await expect(start(item(extra.id), { brief: "Go" }, new Date("2026-11-23T15:00:00Z"))).resolves.toMatchObject({ itemId: extra.id });
  });

  it("hand off: assigns the task, moves its chat to the new agent, and undo puts both back", async () => {
    const { task } = tree();
    saveAgentSettings({
      routing: true,
      aguiStream: false,
      routes: [
        { profile: "momentumchief", keyEnv: KEY_ENV, baseUrl: null },
        { profile: "devchief", keyEnv: KEY_ENV, baseUrl: null },
      ],
    });
    const first = chat(task.id, "momentumchief");
    await expect(start(item(task.id), { brief: "Take it", toProfile: "nobody" })).rejects.toMatchObject({ code: "unknown_profile" });
    const handed = await start(item(task.id), { brief: "Take it from here", toProfile: "devchief" });
    expect(handed.worker).toBe("devchief");
    expect(handed.sessionId).not.toBe(first);
    expect(row(task.id)).toMatchObject({ assignee: "agent:devchief", primarySessionId: handed.sessionId });
    expect(runsOf(task.id).find((r) => r.id === handed.runId)).toMatchObject({ profile: "devchief", hermesSessionId: handed.sessionId });
    expect(store.getDetail(owner.id, task.id).events.some((e) => e.reason === "Handed off to @devchief: Audit preview deployments")).toBe(true);
    // The chat it had is still the task's, under Other chats.
    expect(store.conversationNodes(owner.id).get(first)?.parentId).toBe(task.id);
    const undone = store.undoOp(owner, handed.undoOpId!, cid);
    expect(undone.kind).toBe("task_handoff");
    expect(row(task.id)).toMatchObject({ assignee: null, primarySessionId: first });
    expect(runsOf(task.id).find((r) => r.id === handed.runId)?.state).toBe("done");
    // Handing to the agent the chat is already with keeps the chat.
    const again = await start(item(task.id), { brief: "Carry on", toProfile: "momentumchief" });
    expect(again.sessionId).toBe(first);
  });

  it("steer: guidance for the run in flight, the next message when nothing runs, nothing while it waits on the owner", async () => {
    const { task } = tree();
    await expect(steerTask(caller, item(task.id), { message: "Use last month's list" }, cid, deps)).rejects.toMatchObject({ code: "no_chat" });
    const sessionId = chat(task.id, "momentumchief");
    await expect(steerTask(caller, item(task.id), { message: "Use last month's list" }, cid, deps)).resolves.toMatchObject({ delivered: "message", sessionId });
    expect(sent).toEqual([expect.objectContaining({ sessionId, input: "Use last month's list" })]);
    hermesRun(sessionId, "running");
    await expect(steerTask(caller, item(task.id), { message: "Skip the coupon test" }, cid, deps)).resolves.toMatchObject({ delivered: "guidance" });
    expect(steered).toEqual([{ runId: `hr-${sessionId}-running`, input: "Skip the coupon test" }]);
    getDb().update(schema.runs).set({ status: "waiting_for_approval" }).where(eq(schema.runs.sessionId, sessionId)).run();
    await expect(steerTask(caller, item(task.id), { message: "Hurry" }, cid, deps)).rejects.toMatchObject({ code: "waiting" });
    expect(store.getDetail(owner.id, task.id).events.filter((e) => e.reason?.startsWith("Steered: "))).toHaveLength(2);
  });

  it("a bot's own steer is never sent: the tool refuses unless the owner asked", async () => {
    const { task } = tree();
    chat(task.id, "momentumchief");
    const token = mintAgentToken(owner, { name: "CoS 2", profile: "chiefofstaff", scopes: WITH_TASKS }, cid).token;
    const own = await call(token, "jarvis_steer_task", { itemId: task.id, message: "Use last month's list", ownerAsked: false });
    expect(own).toMatchObject({ isError: true, value: { error: "owner_only" } });
    expect(store.getDetail(owner.id, task.id).events.some((e) => e.reason?.startsWith("Steered"))).toBe(false);
  });
});
