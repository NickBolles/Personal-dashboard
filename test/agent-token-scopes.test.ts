/** Editing an existing agent token's scopes (same secret): validation, audit, immediate effect on MCP, guards. */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { __resetAgentRate, agentFromToken, mintAgentToken, revokeAgentToken, updateAgentTokenScopes } from "@/server/agent-access/tokens";
import { withVia } from "@/server/work/actor";
import * as mcpRoute from "@/app/api/mcp/route";
import * as tokenRoute from "@/app/api/settings/agents/tokens/[id]/route";
import { RISKY_AGENT_SCOPES, groupByProfile, normaliseScopes, scopeDiff, type AgentTokenView } from "@/lib/agent-access";

const cid = "test";
let owner: CurrentUser;
let n = 0;

async function toolNames(token: string): Promise<string[]> {
  const res = await mcpRoute.POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/list" }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

function patch(id: string, body: unknown, opts: { session?: string; csrf?: boolean } = {}) {
  return tokenRoute.PATCH(
    new NextRequest(`http://localhost/api/settings/agents/tokens/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(opts.csrf === false ? {} : { "x-jarvis-csrf": "1" }),
        ...(opts.session ? { cookie: `jarvis_session=${opts.session}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("scope helpers", () => {
  it("normalises, diffs and flags tasks.run as risky", () => {
    expect(normaliseScopes(["tasks.run", "work.read", "work.read", "finance.view"])).toEqual(["work.read", "tasks.run"]);
    expect(scopeDiff(["work.read", "work.write"], ["work.read", "tasks.run"])).toEqual({ added: ["tasks.run"], removed: ["work.write"] });
    expect(scopeDiff(["work.read"], ["work.read"])).toEqual({ added: [], removed: [] });
    expect(RISKY_AGENT_SCOPES["tasks.run"]).toBeTruthy();
    expect(RISKY_AGENT_SCOPES["work.read"]).toBeUndefined();
  });

  it("groups tokens by profile, active first then newest", () => {
    const t = (id: string, profile: string, createdAt: string, revokedAt: string | null = null): AgentTokenView => ({
      id,
      name: id,
      profile,
      scopes: ["work.read"],
      hint: "abcd",
      createdAt,
      lastUsedAt: null,
      revokedAt,
    });
    const groups = groupByProfile([
      t("a", "devchief", "2026-11-01"),
      t("b", "chiefofstaff", "2026-11-01", "2026-11-02"),
      t("c", "chiefofstaff", "2026-10-01"),
      t("d", "chiefofstaff", "2026-11-03"),
    ]);
    expect(groups.map(([p, rows]) => [p, rows.map((r) => r.id)])).toEqual([
      ["chiefofstaff", ["d", "c", "b"]],
      ["devchief", ["a"]],
    ]);
  });
});

describe("edit agent token scopes", () => {
  let session: string;
  beforeEach(() => {
    __setTestDatabase();
    __resetAgentRate();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    session = createSession(id).token;
    owner = resolveUser(new Headers(), session)!;
  });

  it("adds tasks.run to the SAME token: hash unchanged, next tools/list and caps reflect it, audited with the diff", async () => {
    const { token, view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read", "work.write"] }, cid);
    const hashBefore = getDb().select().from(schema.agentTokens).where(eq(schema.agentTokens.id, view.id)).get()!.tokenHash;
    expect(await toolNames(token)).not.toContain("jarvis_start_task");
    expect(agentFromToken(token)!.user.capabilities.has("hermes.chat")).toBe(false);

    const res = await patch(view.id, { scopes: ["work.read", "work.write", "tasks.run"] }, { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: AgentTokenView };
    expect(body.token.scopes).toEqual(["work.read", "work.write", "tasks.run"]);
    expect(JSON.stringify(body)).not.toContain(token);
    const row = getDb().select().from(schema.agentTokens).where(eq(schema.agentTokens.id, view.id)).get()!;
    expect(row.tokenHash).toBe(hashBefore);
    expect(row.hint).toBe(view.hint);

    // No cache: the very next MCP request sees the new scopes.
    const names = await toolNames(token);
    expect(names).toContain("jarvis_start_task");
    expect(names).toContain("jarvis_steer_task");
    expect(names).toContain("jarvis_hand_off");
    expect(agentFromToken(token)!.user.capabilities.has("hermes.chat")).toBe(owner.capabilities.has("hermes.chat"));

    const audits = getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent_token.scopes")).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.sourceRecord).toBe(view.id);
    const detail = JSON.parse(audits[0]!.detail ?? "{}") as Record<string, unknown>;
    expect(detail).toMatchObject({ profile: "chiefofstaff", added: ["tasks.run"], removed: [] });
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("removing a scope takes effect on the next call", async () => {
    const { token, view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read", "work.write"] }, cid);
    expect(await toolNames(token)).toContain("jarvis_create_item");
    updateAgentTokenScopes(owner, view.id, ["work.read"], cid);
    expect(await toolNames(token)).not.toContain("jarvis_create_item");
    expect(agentFromToken(token)!.scopes).toEqual(["work.read"]);
  });

  it("an unchanged list is a no-op without an audit row", () => {
    const { view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read"] }, cid);
    expect(updateAgentTokenScopes(owner, view.id, ["work.read", "work.read"], cid).scopes).toEqual(["work.read"]);
    expect(getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent_token.scopes")).all()).toHaveLength(0);
  });

  it("validates: unknown scopes and empty lists 400, unknown token 404, revoked token 409", async () => {
    const { view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read"] }, cid);
    expect((await patch(view.id, { scopes: ["finance.view"] }, { session })).status).toBe(400);
    expect((await patch(view.id, { scopes: ["admin"] }, { session })).status).toBe(400);
    expect((await patch(view.id, { scopes: [] }, { session })).status).toBe(400);
    expect((await patch(view.id, { scopes: ["work.read"], extra: 1 }, { session })).status).toBe(400);
    expect((await patch("agt_missing", { scopes: ["work.read"] }, { session })).status).toBe(404);
    revokeAgentToken(owner, view.id, cid);
    expect((await patch(view.id, { scopes: ["work.read", "tasks.run"] }, { session })).status).toBe(409);
    expect(getDb().select().from(schema.agentTokens).where(eq(schema.agentTokens.id, view.id)).get()!.scopes).toBe(JSON.stringify(["work.read"]));
  });

  it("needs a signed-in owner session with CSRF, and never runs inside an agent call", async () => {
    const { token, view } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read"] }, cid);
    expect((await patch(view.id, { scopes: ["work.read", "tasks.run"] })).status).toBe(401);
    expect((await patch(view.id, { scopes: ["work.read", "tasks.run"] }, { session, csrf: false })).status).toBe(403);
    // An agent token is not a session: refused like any other unauthenticated call.
    const asAgent = await tokenRoute.PATCH(
      new NextRequest(`http://localhost/api/settings/agents/tokens/${view.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-jarvis-csrf": "1", authorization: `Bearer ${token}` },
        body: JSON.stringify({ scopes: ["work.read", "tasks.run"] }),
      }),
      { params: Promise.resolve({ id: view.id }) },
    );
    expect(asAgent.status).toBe(401);
    expect(() => withVia("agent:chiefofstaff", () => updateAgentTokenScopes(owner, view.id, ["work.read", "tasks.run"], cid))).toThrow(/Agents can't/);
    expect(agentFromToken(token)!.scopes).toEqual(["work.read"]);
  });
});
