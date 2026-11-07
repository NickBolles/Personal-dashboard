import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as qa from "@/server/quick-actions";
import { createItem } from "@/server/work/store";
import { agentFromToken, mintAgentToken, __resetAgentRate } from "@/server/agent-access/tokens";
import { handleMcp } from "@/server/agent-access/mcp";
import { contextualActions, fillQuickAction } from "@/lib/quick-actions";
import * as collection from "@/app/api/quick-actions/route";
import * as rowRoute from "@/app/api/quick-actions/[id]/route";
import * as acceptRoute from "@/app/api/quick-actions/[id]/accept/route";
import * as dismissRoute from "@/app/api/quick-actions/[id]/dismiss/route";
import * as reorderRoute from "@/app/api/quick-actions/reorder/route";
import * as undoRoute from "@/app/api/quick-actions/undo/route";
import * as exportRoute from "@/app/api/quick-actions/export/route";

let owner: CurrentUser;
let cookie: string;
const input = { label: "Kestrel constellation", prompt: "Review the constellation" };
const raw = (id: string) => getDb().select().from(schema.quickActions).where(eq(schema.quickActions.id, id)).get()!;
function req(path: string, method = "GET", body?: unknown, csrf = true) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie, ...(csrf ? { "x-jarvis-csrf": "1" } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id = "") => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  __setTestDatabase();
  __resetAgentRate();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  const token = createSession(id).token;
  cookie = `jarvis_session=${token}`;
  owner = resolveUser(new Headers(), token)!;
});

describe("quick actions", () => {
  it("seeds exactly seven once, even after seed deletion", () => {
    const first = qa.list(owner.id);
    expect(first).toHaveLength(7);
    expect(first.map((a) => a.label)).toEqual([
      "What needs me?",
      "Walk me through decisions",
      "What changed since I last looked",
      "What's running / stalled",
      "Plan my day",
      "Catch me up on {area}",
      "Summarize this page",
    ]);
    expect(qa.list(owner.id).map((a) => a.id)).toEqual(first.map((a) => a.id));
    first.forEach((a) => qa.remove(owner.id, a.id));
    expect(qa.list(owner.id)).toEqual([]);
    expect(qa.list(owner.id)).toEqual([]);
  });
  it("creates, updates, scopes, pins, soft deletes and exports only active fields", () => {
    const { action } = qa.create(owner.id, input);
    expect(raw(action.id)).toMatchObject({ ...input, scope: "global", source: "owner", status: "active", pinned: false });
    qa.update(owner.id, action.id, { label: "Kestrel revised", prompt: "Revised prompt", scope: "page:/areas", pinned: true });
    expect(qa.list(owner.id, { scope: "page:/areas" })).toContainEqual(expect.objectContaining({ id: action.id, pinned: true }));
    expect(qa.list(owner.id, { scope: "area:other" }).some((a) => a.id === action.id)).toBe(false);
    expect(qa.exportJson(owner.id).at(-1)).toEqual({ label: "Kestrel revised", prompt: "Revised prompt", scope: "page:/areas", pinned: true });
    qa.propose(owner.id, "chief", { label: "Not exported", prompt: "Wait" });
    expect(qa.exportJson(owner.id).some((a) => a.label === "Not exported")).toBe(false);
    qa.remove(owner.id, action.id);
    expect(raw(action.id).status).toBe("deleted");
    expect(qa.list(owner.id).some((a) => a.id === action.id)).toBe(false);
  });
  it("reorders atomically and refuses duplicate, foreign and proposed ids", () => {
    const actions = qa.list(owner.id);
    const ids = actions.map((a) => a.id).reverse();
    qa.reorder(owner.id, ids);
    expect(qa.list(owner.id).map((a) => a.id)).toEqual(ids);
    expect(() => qa.reorder(owner.id, [ids[0]!, ids[0]!])).toThrow();
    expect(() => qa.reorder(owner.id, [ids[0]!, "foreign"])).toThrow();
    const p = qa.propose(owner.id, "chief", input).action;
    expect(() => qa.reorder(owner.id, [p.id])).toThrow();
    expect(
      qa
        .list(owner.id)
        .filter((a) => a.status === "active")
        .map((a) => a.id),
    ).toEqual(ids);
  });
  it("accepts with edits, dismisses, refuses repeat review", () => {
    const p = qa.propose(owner.id, "chief", input).action;
    const accepted = qa.accept(owner.id, p.id, { label: "Edited", prompt: "Owner words", pinned: true }).action;
    expect(accepted).toMatchObject({ status: "active", label: "Edited", prompt: "Owner words", pinned: true, source: "agent:chief" });
    expect(() => qa.accept(owner.id, p.id)).toThrow();
    const other = qa.propose(owner.id, "chief", input).action;
    qa.dismiss(owner.id, other.id);
    expect(raw(other.id).status).toBe("deleted");
  });
  it("undoes create, accept, edit, reorder and delete through work ops; rejects stale/repeated undo", () => {
    const created = qa.create(owner.id, input);
    qa.undo(owner, created.opId);
    expect(raw(created.action.id).status).toBe("deleted");
    expect(() => qa.undo(owner, created.opId)).toThrow();
    const proposed = qa.propose(owner.id, "chief", input);
    const accepted = qa.accept(owner.id, proposed.action.id, { prompt: "Owner edit" });
    qa.undo(owner, accepted.opId);
    expect(raw(proposed.action.id)).toMatchObject({ status: "proposed", prompt: input.prompt });
    const next = qa.create(owner.id, input);
    const edit = qa.update(owner.id, next.action.id, { label: "Edited" });
    expect(() => qa.undo(owner, next.opId)).toThrow();
    qa.undo(owner, edit.opId);
    expect(raw(next.action.id).label).toBe(input.label);
    const before = qa
      .list(owner.id)
      .filter((a) => a.status === "active")
      .map((a) => a.id);
    const reordered = qa.reorder(owner.id, [...before].reverse());
    qa.undo(owner, reordered.opId);
    expect(
      qa
        .list(owner.id)
        .filter((a) => a.status === "active")
        .map((a) => a.id),
    ).toEqual(before);
    const deleted = qa.remove(owner.id, next.action.id);
    qa.undo(owner, deleted.opId);
    expect(raw(next.action.id).status).toBe("active");
  });
  it("isolates owners across every write, list, export and undo", () => {
    getDb().insert(schema.users).values({ id: "other", name: "Other", role: "adult" }).run();
    const other = { ...owner, id: "other" };
    const made = qa.create(owner.id, input);
    expect(qa.list(other.id).some((a) => a.id === made.action.id)).toBe(false);
    for (const fn of [
      () => qa.update(other.id, made.action.id, { label: "No" }),
      () => qa.remove(other.id, made.action.id),
      () => qa.accept(other.id, made.action.id),
      () => qa.dismiss(other.id, made.action.id),
      () => qa.reorder(other.id, [made.action.id]),
      () => qa.undo(other, made.opId),
    ])
      expect(fn).toThrow();
    expect(qa.exportJson(other.id).some((a) => a.label === input.label)).toBe(false);
    expect(raw(made.action.id).userId).toBe(owner.id);
  });
  it("validates sizes, status/source injection and scopes", async () => {
    for (const data of [
      { ...input, label: "x".repeat(61) },
      { ...input, prompt: "x".repeat(2001) },
      { ...input, label: " " },
      { ...input, scope: "page:https://example.com" },
      { ...input, status: "proposed" },
      { ...input, source: "agent:chief" },
    ]) {
      expect((await collection.POST(req("/api/quick-actions", "POST", data), ctx())).status).toBe(400);
    }
  });
  it("MCP lists the scoped tool and only proposes; Finance allowed; attributed to the agent", async () => {
    const { token } = mintAgentToken(owner, { name: "Test", profile: "chief", scopes: ["work.write"] }, "qa");
    const agent = agentFromToken(token)!;
    const listed = await handleMcp(agent, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "qa");
    expect(JSON.stringify(listed)).toContain("jarvis_add_quick_action");
    const call = async (args: unknown) => {
      const res = await handleMcp(agent, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jarvis_add_quick_action", arguments: args } }, "qa");
      return res?.result as { isError?: boolean; structuredContent?: { proposed: boolean; id: string; note: string } };
    };
    const result = await call(input);
    expect(result.structuredContent).toMatchObject({ proposed: true, note: "The owner must tap Add" });
    const id = result.structuredContent!.id;
    expect(raw(id)).toMatchObject({ status: "proposed", source: "agent:chief" });
    expect(
      getDb()
        .select()
        .from(schema.quickActions)
        .all()
        .every((a) => a.status === "proposed"),
    ).toBe(true);
    expect(getDb().select().from(schema.workOps).all().at(-1)?.via).toBe("agent:chief");
    expect(qa.list(owner.id).find((a) => a.id === id)?.status).toBe("proposed");
    expect((await call({ ...input, status: "active" })).isError).toBe(true);
    const finance = createItem(owner, { kind: "area", title: "Finance" }, "qa");
    expect((await call({ ...input, scope: `area:${finance.id}` })).isError).not.toBe(true);
    expect((await call({ ...input, scope: "area:finance" })).isError).toBe(true);
    expect((await call({ ...input, scope: "page:/finance/accounts" })).isError).not.toBe(true);
    qa.accept(owner.id, id);
    expect(raw(id).status).toBe("active");
    const reader = { ...agent, scopes: ["work.read" as const] };
    expect(JSON.stringify(await handleMcp(reader, { jsonrpc: "2.0", id: 3, method: "tools/list" }, "qa"))).not.toContain("jarvis_add_quick_action");
  });
  it("API has CSRF/auth/capability protection and exercises CRUD/review/undo/export", async () => {
    expect((await collection.POST(req("/api/quick-actions", "POST", input, false), ctx())).status).toBe(403);
    const anonymous = new NextRequest("http://localhost/api/quick-actions");
    expect((await collection.GET(anonymous, ctx())).status).toBe(401);
    getDb().insert(schema.users).values({ id: "kid", name: "Kid", role: "kid" }).run();
    const kid = createSession("kid").token;
    expect((await collection.GET(new NextRequest("http://localhost/api/quick-actions", { headers: { cookie: `jarvis_session=${kid}` } }), ctx())).status).toBe(
      403,
    );
    const made = await (await collection.POST(req("/api/quick-actions", "POST", input), ctx())).json();
    const id = made.action.id;
    expect((await rowRoute.PATCH(req(`/api/quick-actions/${id}`, "PATCH", { pinned: true }), ctx(id))).status).toBe(200);
    const all = await (await collection.GET(req("/api/quick-actions"), ctx())).json();
    expect(
      (await reorderRoute.POST(req("/api/quick-actions/reorder", "POST", { ids: all.actions.map((a: { id: string }) => a.id).reverse() }), ctx())).status,
    ).toBe(200);
    const removed = await (await rowRoute.DELETE(req(`/api/quick-actions/${id}`, "DELETE"), ctx(id))).json();
    expect((await undoRoute.POST(req("/api/quick-actions/undo", "POST", { opId: removed.opId }), ctx())).status).toBe(200);
    const proposed = qa.propose(owner.id, "chief", input).action;
    expect((await acceptRoute.POST(req(`/api/quick-actions/${proposed.id}/accept`, "POST", { label: "Owner accepted" }), ctx(proposed.id))).status).toBe(200);
    const dismissed = qa.propose(owner.id, "chief", input).action;
    expect((await dismissRoute.POST(req(`/api/quick-actions/${dismissed.id}/dismiss`, "POST", {}), ctx(dismissed.id))).status).toBe(200);
    const exported = await exportRoute.GET(req("/api/quick-actions/export"), ctx());
    expect(exported.headers.get("content-disposition")).toContain("quick-actions.json");
    expect(await exported.json()).toContainEqual({ ...input, scope: "global", pinned: true });
  });
  it("client selector filters scopes/templates, pins first and substitutes context without sending", () => {
    const rows = qa.list(owner.id);
    const pinned = qa.create(owner.id, { ...input, pinned: true, scope: "area:scope-test" }).action;
    const proposed = qa.propose(owner.id, "chief", input).action;
    expect(contextualActions([...rows, pinned, proposed], {}).some((a) => a.prompt.includes("{area}"))).toBe(false);
    expect(contextualActions([...rows, pinned, proposed], { areaId: "scope-test", areaTitle: "Workshop" })[0]?.id).toBe(pinned.id);
    expect(fillQuickAction("Catch {area} on {page}", { areaTitle: "Workshop", pageLabel: "Today" })).toBe("Catch Workshop on Today");
  });
});
