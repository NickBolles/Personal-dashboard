/** Scoped agent tokens + Jarvis MCP (docs/agent-tools.md): auth, scopes, Finance denial, never-settle, attribution, undo, runs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { sha256 } from "@/server/crypto";
import * as store from "@/server/work/store";
import { listActivity } from "@/server/work/activity";
import { agentRuns } from "@/server/work/agent-runs";
import { listDecisions } from "@/server/work/decisions";
import { STALL_AFTER_MIN, isStalled, liveLabel } from "@/lib/agent-runs";
import {
  __resetAgentRate,
  agentFromToken,
  capabilitiesForScopes,
  listAgentTokens,
  mintAgentToken,
  rateLimited,
  revokeAgentToken,
} from "@/server/agent-access/tokens";
import * as mcpRoute from "@/app/api/mcp/route";
import * as tokensRoute from "@/app/api/settings/agents/tokens/route";
import type { AgentScope } from "@/lib/agent-access";

const cid = "test";
const ALL: AgentScope[] = ["work.read", "work.write", "decisions.write", "runs.write"];

let owner: CurrentUser;
let n = 0;

function mcp(token: string | null, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return mcpRoute.POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw,
    }),
  );
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp(token, { jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary tool JSON
  const value = JSON.parse(j.result.content[0]!.text) as Record<string, any>;
  return { isError: !!j.result.isError, value };
}

describe("agent tokens", () => {
  beforeEach(() => {
    __setTestDatabase();
    __resetAgentRate();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    owner = resolveUser(new Headers(), createSession(id).token)!;
  });

  it("stores only the hash, verifies, and stops working once revoked", () => {
    const { token, view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ALL }, cid);
    expect(token.startsWith("jva_")).toBe(true);
    const row = getDb().select().from(schema.agentTokens).where(eq(schema.agentTokens.id, view.id)).get()!;
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(listAgentTokens(owner.id))).not.toContain(token);
    const a = agentFromToken(token)!;
    expect(a.profile).toBe("chiefofstaff");
    expect(a.via).toBe("agent:chiefofstaff");
    expect(agentFromToken(token + "x")).toBeNull();
    revokeAgentToken(owner, view.id, cid);
    expect(agentFromToken(token)).toBeNull();
  });

  it("never grants finance or admin, and agent tokens are refused outside /api/mcp", () => {
    const caps = capabilitiesForScopes([...ALL, "conversations.file"], owner.capabilities);
    expect([...caps].some((c) => c.startsWith("finance"))).toBe(false);
    expect(caps.has("admin")).toBe(false);
    const { token } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ALL }, cid);
    expect(resolveUser(new Headers({ authorization: `Bearer ${token}` }), undefined)).toBeNull();
  });

  it("mint route rejects unknown scopes (finance) and audits the mint without the token", async () => {
    const session = createSession(owner.id).token;
    const post = (scopes: string[]) =>
      tokensRoute.POST(
        new NextRequest("http://localhost/api/settings/agents/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "x-jarvis-csrf": "1", cookie: `jarvis_session=${session}` },
          body: JSON.stringify({ name: "x", profile: "chiefofstaff", scopes }),
        }),
        { params: Promise.resolve({}) },
      );
    expect((await post(["finance.view"])).status).toBe(400);
    const ok = await post(["work.read"]);
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    const audits = getDb().select().from(schema.auditLog).all();
    expect(audits.some((a) => a.action === "agent_token.mint")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("rate-limits per token", () => {
    for (let i = 0; i < 3; i++) expect(rateLimited("t1", 1000, 3)).toBe(false);
    expect(rateLimited("t1", 1000, 3)).toBe(true);
    expect(rateLimited("t2", 1000, 3)).toBe(false);
    expect(rateLimited("t1", 70_000, 3)).toBe(false);
  });
});

describe("Jarvis MCP", () => {
  let token: string;
  let area: { id: string };
  let finance: { id: string };
  let secret: { id: string };
  beforeEach(() => {
    __setTestDatabase();
    __resetAgentRate();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    owner = resolveUser(new Headers(), createSession(id).token)!;
    token = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ALL }, cid).token;
    area = store.createItem(owner, { kind: "area", title: "Workshop" }, cid);
    finance = store.createItem(owner, { kind: "area", title: "Finance" }, cid);
    secret = store.createItem(owner, { kind: "thread", title: "Tax return", parentId: finance.id }, cid);
  });

  it("401 without or with a wrong token; GET is 405; oversize body 413", async () => {
    expect((await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await mcp("jva_nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const session = createSession(owner.id).token;
    expect((await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" }, { cookie: `jarvis_session=${session}` })).status).toBe(401);
    expect(mcpRoute.GET().status).toBe(405);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } });
    expect((await mcp(token, big)).status).toBe(413);
    expect((await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("initialize + tools/list filtered by scope", async () => {
    const init = await (await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeTruthy();
    const list = await (await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("jarvis_create_item");
    expect(names).not.toContain("jarvis_file_conversation");
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
    const ro = mintAgentToken(owner, { name: "RO", profile: "reader", scopes: ["work.read"] }, cid).token;
    const roNames = (await (await mcp(ro, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()).result.tools.map((t: { name: string }) => t.name);
    expect(roNames).not.toContain("jarvis_create_item");
    const denied = await call(ro, "jarvis_create_item", { parentId: area.id, title: "Nope" });
    expect(denied).toMatchObject({ isError: true, value: { error: "forbidden" } });
  });

  it("Finance is visible; AI-excluded subtrees are never visible or writable", async () => {
    expect(JSON.stringify((await call(token, "jarvis_tree")).value)).toContain("Finance");
    expect((await call(token, "jarvis_get_item", { id: secret.id })).isError).toBe(false);
    store.updateItem(owner, finance.id, { settings: { aiPolicy: "excluded" } }, cid);
    const tree = await call(token, "jarvis_tree");
    expect(JSON.stringify(tree.value)).not.toContain("Finance");
    expect(JSON.stringify(tree.value)).toContain("Workshop");
    expect((await call(token, "jarvis_get_item", { id: secret.id })).value.error).toBe("not_found");
    expect((await call(token, "jarvis_get_item", { id: finance.id })).value.error).toBe("not_found");
    expect((await call(token, "jarvis_create_item", { parentId: finance.id, title: "Sneaky" })).value.error).toBe("not_found");
    expect((await call(token, "jarvis_update_item", { id: secret.id, title: "Sneaky" })).value.error).toBe("not_found");
    expect((await call(token, "jarvis_search", { q: "tax" })).value.items).toEqual([]);
    expect(store.listItems(owner.id).find((i) => i.id === secret.id)!.title).toBe("Tax return");
  });

  it("can't file a conversation out of an AI-excluded area, and a rejected assignee leaves no item behind", async () => {
    store.updateItem(owner, finance.id, { settings: { aiPolicy: "excluded" } }, cid);
    const chat = store.placeConversation(owner, { sessionId: "s-budget", parentId: finance.id, title: "Budget chat" }, cid);
    const filer = mintAgentToken(owner, { name: "Filer", profile: "chiefofstaff", scopes: [...ALL, "conversations.file"] }, cid).token;
    expect((await call(filer, "jarvis_file_conversation", { sessionId: "s-budget", itemId: area.id })).value.error).toBe("not_found");
    expect(store.listItems(owner.id).find((i) => i.id === chat.id)!.parentId).toBe(finance.id);
    const before = store.listItems(owner.id).length;
    const bad = await call(token, "jarvis_create_item", { parentId: area.id, title: "Plane the door", assignee: "agent:nosuchagent" });
    expect(bad.value.error).toBe("assignee");
    expect(store.listItems(owner.id).length).toBe(before);
  });

  it("create is attributed to the agent, shows in Activity with via, and the owner can undo it", async () => {
    const r = await call(token, "jarvis_create_item", { parentId: area.id, title: "Sharpen chisels", nextAction: "Find the stone" });
    expect(r.isError).toBe(false);
    const created = store.listItems(owner.id).find((i) => i.title === "Sharpen chisels")!;
    expect(created.createdVia).toBe("agent:chiefofstaff");
    const act = listActivity(owner, { item: created.id });
    const row = act.items.find((a) => a.type === "created")!;
    expect(row.via).toBe("chiefofstaff");
    expect(row.undoOpId).toBe(r.value.undoOpId);
    const audits = getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.mcp")).all();
    expect(audits.at(-1)).toMatchObject({ actor: "agent:chiefofstaff", sourceRecord: "jarvis_create_item", result: "ok" });
    expect(JSON.stringify(audits)).not.toContain(token);
    const undo = store.undoOp(owner, row.undoOpId!, cid);
    expect(undo.outcome).toBe("deleted");
    expect(store.listItems(owner.id).some((i) => i.id === created.id)).toBe(false);
  });

  it("update is attributed and undoable; an owner edit clears the chip", async () => {
    const item = store.createItem(owner, { kind: "thread", title: "Plane the door", parentId: area.id }, cid);
    const r = await call(token, "jarvis_update_item", { id: item.id, nextAction: "Measure the gap", status: "ready" });
    expect(r.isError).toBe(false);
    let cur = store.listItems(owner.id).find((i) => i.id === item.id)!;
    expect(cur).toMatchObject({ updatedVia: "agent:chiefofstaff", status: "ready", nextAction: "Measure the gap" });
    store.undoOp(owner, r.value.undoOpId, cid);
    cur = store.listItems(owner.id).find((i) => i.id === item.id)!;
    expect(cur.status).toBe("captured");
    store.updateItem(owner, item.id, { title: "Plane the shed door" }, cid);
    expect(store.listItems(owner.id).find((i) => i.id === item.id)!.updatedVia).toBeNull();
  });

  it("never settles: settled/abandoned/superseded refused; destructive ops become a decision", async () => {
    const item = store.createItem(owner, { kind: "thread", title: "Oil the hinges", parentId: area.id }, cid);
    for (const status of ["settled", "abandoned", "superseded"]) {
      const r = await call(token, "jarvis_update_item", { id: item.id, status });
      expect(r).toMatchObject({ isError: true, value: { error: "owner_only" } });
    }
    expect((await call(token, "jarvis_update_item", { id: item.id, archived: true })).value.error).toBe("validation");
    expect((await call(token, "jarvis_settle", { id: item.id })).value.error).toBe("unknown_tool");
    const p = await call(token, "jarvis_request_change", { itemId: item.id, op: "archive", reason: "Duplicate of the door item" });
    expect(p.isError).toBe(false);
    const cur = store.listItems(owner.id).find((i) => i.id === item.id)!;
    expect(cur.archived).toBe(false);
    expect(cur.status).toBe("captured");
    expect(cur.decision?.question).toMatch(/@chiefofstaff proposes: archive/);
    const decisions = await call(token, "jarvis_list_decisions");
    expect(decisions.value.decisions[0].itemId).toBe(item.id);
    expect(listDecisions(owner).entries.find((e) => e.itemId === item.id)?.askedBy).toBe("chiefofstaff");
    // Editing another field must not erase who raised the still-open question.
    store.updateItem(owner, item.id, { nextAction: "Review the proposed archive" }, cid);
    expect(listDecisions(owner).entries.find((e) => e.itemId === item.id)?.askedBy).toBe("chiefofstaff");
    // CW-2: several decisions can be open on one item; each gets its own stable D-n.
    const again = await call(token, "jarvis_raise_decision", { itemId: item.id, question: "Again?" });
    expect(again.isError).toBe(false);
    expect(again.value.ref).toMatch(/^D-\d+$/);
    expect(listDecisions(owner).entries.filter((e) => e.itemId === item.id)).toHaveLength(2);
  });

  it("validates input sizes and links only https / GitHub URLs", async () => {
    const item = store.createItem(owner, { kind: "thread", title: "Router table", parentId: area.id }, cid);
    expect((await call(token, "jarvis_create_item", { parentId: area.id, title: "x".repeat(300) })).value.error).toBe("validation");
    expect((await call(token, "jarvis_link", { itemId: item.id, url: "javascript:alert(1)" })).value.error).toBe("url");
    expect((await call(token, "jarvis_link", { itemId: item.id, url: "http://169.254.169.254/" })).value.error).toBe("url");
    const pr = await call(token, "jarvis_link", { itemId: item.id, url: "https://github.com/acme/shop/pull/12" });
    expect(pr.value.link.kind).toBe("github_pr");
    const note = await call(token, "jarvis_add_note", { itemId: item.id, title: "Findings", body: "Fence is square" });
    expect(note.value.item.kind).toBe("note");
  });

  it("records runs on items for the agent runs panel", async () => {
    const item = store.createItem(owner, { kind: "thread", title: "Dust collector", parentId: area.id }, cid);
    const s = await call(token, "jarvis_run_start", { itemId: item.id, title: "Price ducting" });
    expect(s.isError).toBe(false);
    let info = agentRuns(owner).items[item.id]!;
    expect(info.live).toBe("running");
    expect(info.agentRuns![0]).toMatchObject({ title: "Price ducting", profile: "chiefofstaff", state: "running" });
    expect((await call(token, "jarvis_run_update", { runId: s.value.runId, state: "done", prUrl: "https://evil.example/pull/1" })).value.error).toBe("pr_url");
    const u = await call(token, "jarvis_run_update", {
      runId: s.value.runId,
      state: "done",
      summary: "Found 4-inch ducting",
      prUrl: "https://github.com/acme/shop/pull/3",
    });
    expect(u.isError).toBe(false);
    info = agentRuns(owner).items[item.id]!;
    expect(info.live).toBe("finished");
    expect(info.agentRuns![0]).toMatchObject({ state: "done", summary: "Found 4-inch ducting", prUrl: "https://github.com/acme/shop/pull/3" });
    const other = mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ALL }, cid).token;
    expect((await call(other, "jarvis_run_update", { runId: s.value.runId, state: "failed" })).value.error).toBe("not_found");
    expect(listActivity(owner, { item: item.id }).items.filter((a) => a.via === "chiefofstaff").length).toBeGreaterThanOrEqual(2);
  });

  it("links delegations, child summaries and transcript paths; flags stalled runs without changing them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
    const item = store.createItem(owner, { kind: "thread", title: "Bandsaw tune", parentId: area.id }, cid);
    const args = {
      itemId: item.id,
      title: "Blade research",
      delegationId: "deleg_42",
      hermesSessionId: "20261104_150000_ab12cd",
      transcriptPath: "/opt/data/logs/deleg_42.md",
    };
    const s = await call(token, "jarvis_run_start", args);
    expect(s.isError).toBe(false);
    // A retried start with the same delegation returns the same run.
    const again = await call(token, "jarvis_run_start", args);
    expect(again.value).toMatchObject({ runId: s.value.runId, existing: true });
    const elsewhere = store.createItem(owner, { kind: "thread", title: "Planer knives", parentId: area.id }, cid);
    expect((await call(token, "jarvis_run_start", { ...args, itemId: elsewhere.id })).value.error).toBe("delegation_taken");
    expect((await call(token, "jarvis_run_start", { ...args, delegationId: "bad id with spaces" })).value.error).toBe("validation");
    const u = await call(token, "jarvis_run_update", {
      runId: s.value.runId,
      state: "running",
      children: [
        { title: "Blade widths", state: "done", summary: "1/2 inch fits" },
        { title: "TPI", state: "running" },
      ],
    });
    expect(u.isError).toBe(false);
    let run = agentRuns(owner).items[item.id]!.agentRuns![0]!;
    expect(run).toMatchObject({ delegationId: "deleg_42", hermesSessionId: "20261104_150000_ab12cd", transcriptPath: "/opt/data/logs/deleg_42.md" });
    expect(run.children).toEqual([
      { title: "Blade widths", state: "done", summary: "1/2 inch fits" },
      { title: "TPI", state: "running", summary: null },
    ]);
    expect(isStalled(run)).toBe(false);
    expect(listDecisions(owner).entries.some((e) => e.kind === "stalled")).toBe(false);

    vi.setSystemTime(new Date(Date.parse("2026-11-04T15:00:00Z") + (STALL_AFTER_MIN + 1) * 60_000));
    run = agentRuns(owner).items[item.id]!.agentRuns![0]!;
    expect(run.state).toBe("running"); // nothing auto-changes
    expect(isStalled(run)).toBe(true);
    const nudge = listDecisions(owner).entries.find((e) => e.key === `stalled:${s.value.runId}`)!;
    expect(nudge).toMatchObject({ kind: "stalled", itemId: item.id, title: "Bandsaw tune", choices: [] });
    expect(nudge.question).toContain("Blade research");
    // A heartbeat clears it.
    await call(token, "jarvis_run_update", { runId: s.value.runId, state: "running" });
    expect(listDecisions(owner).entries.some((e) => e.kind === "stalled")).toBe(false);
    const got = await call(token, "jarvis_get_item", { id: item.id });
    expect(got.value.agentRuns[0]).toMatchObject({ delegationId: "deleg_42", stalled: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("run wording", () => {
  it("says Waiting, and Waiting for approval only for a real pending approval", () => {
    expect(liveLabel("waiting")).toBe("Waiting");
    expect(liveLabel("waiting", true)).toBe("Waiting for approval");
    expect(liveLabel("running", true)).toBe("Running");
  });
});
