/** Coordinator parity server side: coordinator brief in filed context + sub-agents mirrored as agent runs. */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { mintAgentToken } from "@/server/agent-access/tokens";
import { filedChatContext } from "@/server/work/chat-context";
import { syncDelegatedRuns } from "@/server/work/delegated-runs";
import { registerAgentRun } from "@/server/work/registered-runs";
import { executionState } from "@/server/chat/execution-store";
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
});
