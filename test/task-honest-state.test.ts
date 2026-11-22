/**
 * Task threads, step 4: honest state and the timeline. Working is checked against the chat; a run whose chat ended
 * is ready for review; agents report key moments by name; the owner can check in on a silent task.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { registerAgentRun } from "@/server/work/registered-runs";
import { recordRunEvent } from "@/server/work/run-events";
import { __resetSessionEnd, markEndedSessionRuns } from "@/server/work/session-end";
import { taskList, taskTimeline } from "@/server/work/tasks";
import { CHECK_IN_TEXT, checkInTask, type TaskRunDeps } from "@/server/work/task-runs";
import { __resetAgentRate, mintAgentToken } from "@/server/agent-access/tokens";
import * as mcpRoute from "@/app/api/mcp/route";
import { isStalled } from "@/lib/agent-runs";
import { momentOf } from "@/lib/task-list";
import type { RunEvent } from "@/lib/cw-runs";
import type { WorkItem } from "@/lib/work";

const cid = "test";
let owner: CurrentUser;
let area: WorkItem;
let task: WorkItem;

beforeEach(() => {
  __setTestDatabase();
  __resetSessionEnd();
  __resetAgentRate();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  area = store.createItem(owner, { kind: "area", title: "Portfolio", parentId: null }, cid);
  task = store.createItem(owner, { kind: "thread", title: "Reconcile inventory export", parentId: area.id }, cid);
});

const runRow = (id: string) => getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get()!;
const rowOf = (id: string) =>
  taskList(owner, { scope: "all", view: "all" })
    .groups.flatMap((g) => g.rows)
    .find((r) => r.id === id)!;
const silence = (runId: string, minutes: number) =>
  getDb()
    .update(schema.agentRuns)
    .set({ updatedAt: new Date(Date.now() - minutes * 60_000).toISOString() })
    .where(eq(schema.agentRuns.id, runId))
    .run();

describe("working is checked against the chat", () => {
  it("a run that has not reported for an hour is still Working while its chat is active, and Stalled once the chat is quiet too", async () => {
    const { runId } = registerAgentRun(owner, "devchief", { itemId: task.id, title: "Reconcile", hermesSessionId: "sess-busy" }, cid);
    silence(runId, 60);
    expect(rowOf(task.id).state).toBe("stalled");
    // The ended-chat check reads the session: still going, active two minutes ago.
    const lookup = vi.fn(async () => ({ endReason: null, lastActiveAt: new Date(Date.now() - 2 * 60_000).toISOString() }));
    expect(await markEndedSessionRuns(new Date(), lookup)).toEqual({ checked: 1, marked: 0 });
    expect(runRow(runId).chatActiveAt).toBeTruthy();
    // Recording chat activity is not a report from the run: its own clock is untouched.
    expect(Date.now() - Date.parse(runRow(runId).updatedAt)).toBeGreaterThan(50 * 60_000);
    expect(rowOf(task.id)).toMatchObject({ state: "working", can: { stop: true, checkIn: false } });
    // The same rule, as a pure check: the chat's activity ages out after the threshold.
    const base = { state: "running" as const, updatedAt: new Date(Date.now() - 60 * 60_000).toISOString() };
    expect(isStalled({ ...base, chatActiveAt: new Date(Date.now() - 5 * 60_000).toISOString() })).toBe(false);
    expect(isStalled({ ...base, chatActiveAt: new Date(Date.now() - 45 * 60_000).toISOString() })).toBe(true);
    expect(isStalled(base)).toBe(true);
  });

  it("a run whose chat has ended is Ready for review: never Working, never Stalled, and never Done", async () => {
    const { runId } = registerAgentRun(
      owner,
      "devchief",
      { itemId: task.id, title: "Reconcile", hermesSessionId: "sess-gone" },
      cid,
      null,
      new Date(Date.now() - 3 * 3_600_000),
    );
    recordRunEvent(getDb(), {
      userId: owner.id,
      runId,
      type: "progress",
      summary: "Matched 172 of 212 rows",
      payload: { moment: "found" },
      via: "agent:devchief",
    });
    silence(runId, 120);
    const lookup = vi.fn(async () => ({ endReason: "agent_close", lastActiveAt: new Date(Date.now() - 90 * 60_000).toISOString() }));
    expect(await markEndedSessionRuns(new Date(), lookup)).toEqual({ checked: 1, marked: 1 });
    const row = rowOf(task.id);
    expect(row).toMatchObject({ state: "review", can: { steer: false, stop: false, retry: false, checkIn: false } });
    expect(row.line).toBe("Its chat ended");
    // The timeline says so in its own words, after what the agent found.
    const lines = taskTimeline(owner, task.id).moments.map((m) => [m.label, m.text]);
    expect(lines[0]).toEqual(["Chat ended", ""]);
    expect(lines).toContainEqual(["Found", "Matched 172 of 212 rows"]);
    // It is finished work to look at: it sits in the review queue, and only the owner closing it makes it Done.
    expect(taskList(owner, { scope: "all", view: "review" }).groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual([task.id]);
    expect(store.getDetail(owner.id, task.id).item.status).not.toBe("settled");
  });
});

describe("key moments", () => {
  const event = (over: Partial<RunEvent>): RunEvent => ({
    id: "e1",
    runId: "r1",
    runRef: "R-1",
    type: "progress",
    summary: "x",
    payload: {},
    via: null,
    at: new Date().toISOString(),
    ...over,
  });

  it("each line carries its kind: what the agent named, and what Jarvis saw happen", () => {
    const label = (over: Partial<RunEvent>) => momentOf(event(over), "Run title")?.label;
    expect(label({ payload: { moment: "found" } })).toBe("Found");
    expect(label({ payload: { moment: "made" } })).toBe("Made");
    expect(label({ payload: { moment: "blocked" } })).toBe("Blocked");
    expect(label({ payload: { moment: "handed_off" } })).toBe("Handed off");
    // An unknown or missing kind is a plain progress line; a kind on another type is ignored.
    expect(label({ payload: { moment: "celebrated" } })).toBe("Progress");
    expect(label({ type: "notice", payload: { moment: "found" } })).toBe("Step done");
    expect(label({ type: "started", summary: "From your message" })).toBe("Started");
    expect(label({ type: "resumed" })).toBe("Resumed");
    expect(label({ type: "failed" })).toBe("Failed");
    expect(label({ type: "done" })).toBe("Done");
    expect(momentOf(event({ type: "interrupted", summary: "Stopped by you" }), "Run title")).toMatchObject({ label: "Stopped", text: "By you" });
    expect(momentOf(event({ type: "interrupted", summary: "Session ended (cli_close)" }), "Run title")).toMatchObject({ label: "Chat ended", text: "" });
  });

  it("an agent reports a moment through jarvis_run_event: one line of at most 140 characters, on a progress event", async () => {
    const { token } = mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ["work.read", "runs.write"] }, cid);
    let n = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpRoute.POST(
        new NextRequest("http://localhost/api/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      const json = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      return { isError: !!json.result.isError, text: json.result.content[0]!.text };
    };
    const started = JSON.parse((await call("jarvis_run_start", { itemId: task.id, title: "Reconcile" })).text) as { runId: string };
    await call("jarvis_run_event", { runId: started.runId, type: "progress", moment: "found", summary: "40 mismatches, all in one category" });
    await call("jarvis_run_event", { runId: started.runId, type: "progress", moment: "made", summary: "A corrected export, attached to the task" });
    const row = rowOf(task.id);
    expect(row.activity.map((m) => [m.label, m.text]).slice(0, 2)).toEqual([
      ["Made", "A corrected export, attached to the task"],
      ["Found", "40 mismatches, all in one category"],
    ]);
    // Refused: too long, more than one line, or on an event that is not progress.
    const refused = [
      await call("jarvis_run_event", { runId: started.runId, type: "progress", moment: "found", summary: "x".repeat(141) }),
      await call("jarvis_run_event", { runId: started.runId, type: "progress", moment: "found", summary: ["one", "two"].join("\n") }),
      await call("jarvis_run_event", { runId: started.runId, type: "notice", moment: "found", summary: "A step" }),
    ];
    expect(refused.map((r) => r.isError)).toEqual([true, true, true]);
    expect(refused[0]!.text).toContain("140");
    expect(taskTimeline(owner, task.id).moments.filter((m) => m.label === "Found")).toHaveLength(1);
  });
});

describe("check in", () => {
  const deps = () => {
    const startRun = vi.fn(async () => ({ runId: "run_h1" }) as never);
    const steerRun = vi.fn(async () => ({}) as never);
    return { deps: { startRun, steerRun } as unknown as TaskRunDeps, startRun, steerRun };
  };
  const chatUser = () => ({ ...owner, capabilities: ["work.use", "hermes.chat"] }) as never;

  it("asks the task's agent for a status in the task's chat: the owner's message, logged on the task", async () => {
    getDb().update(schema.workItems).set({ primarySessionId: "sess-task" }).where(eq(schema.workItems.id, task.id)).run();
    const d = deps();
    const fresh = store.listItems(owner.id).find((i) => i.id === task.id)!;
    expect(await checkInTask(chatUser(), fresh, cid, d.deps)).toMatchObject({ sessionId: "sess-task", delivered: "message" });
    expect(d.startRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ sessionId: "sess-task", input: CHECK_IN_TEXT }), cid);
    expect(d.steerRun).not.toHaveBeenCalled();
    expect(store.getDetail(owner.id, task.id).events.some((e) => e.reason === "Checked in")).toBe(true);
  });

  it("a task with no chat has nobody to ask, and a closed task is not asked", async () => {
    const d = deps();
    await expect(checkInTask(chatUser(), task, cid, d.deps)).rejects.toMatchObject({ code: "no_chat" });
    store.updateItem(owner, task.id, { status: "abandoned", reason: "Not needed" }, cid);
    const closed = store.listItems(owner.id).find((i) => i.id === task.id)!;
    await expect(checkInTask(chatUser(), closed, cid, d.deps)).rejects.toMatchObject({ code: "closed" });
    expect(d.startRun).not.toHaveBeenCalled();
  });

  it("only a stalled task with a chat offers it", () => {
    const { runId } = registerAgentRun(owner, "devchief", { itemId: task.id, title: "Reconcile" }, cid);
    silence(runId, 90);
    expect(rowOf(task.id)).toMatchObject({ state: "stalled", can: { checkIn: false } });
    getDb().update(schema.workItems).set({ primarySessionId: "sess-task" }).where(eq(schema.workItems.id, task.id)).run();
    expect(rowOf(task.id)).toMatchObject({ state: "stalled", can: { checkIn: true } });
  });
});
