/**
 * New chat speed + the area-contextual global composer.
 *  - opening a conversation does not scan Hermes' (slow) session list
 *  - a duplicate title doesn't fail "Ask" (Hermes rejects reused titles)
 *  - the global composer resolves the owning agent from the route/node, files the chat there
 *    and attaches the node's context (your own items only)
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { MOCK_PROFILE_KEYS } from "../mock-upstreams/hermes.mjs";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import { HermesSessionClient } from "@/integrations/hermes/client";
import { UpstreamError } from "@/server/http/errors";
import * as store from "@/server/work/store";
import { startConversation } from "@/server/areas";
import { getSessionDetail } from "@/server/assistant";
import { saveAgentSettings } from "@/server/agents/routing";
import { composerTarget, nodeContextBlock } from "@/server/agents/composer";
import { resolveContextRefs } from "@/server/smart/context";
import { suggestedKeyEnv } from "@/lib/agents";
import { composerLabel, composerTargetFor, JARVIS_TARGET, NODE_CTX_PREFIX, nodeIdFromRoute, sessionIdFromRoute } from "@/lib/composer-target";
import * as composerRoute from "@/app/api/agents/composer/route";

let server: Server;
let owner: string;
let sam: string;
const cid = "corr";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const KEY_ENV = suggestedKeyEnv("momentumchief");

async function get(url: string, userId = owner) {
  const req = new NextRequest(new URL(url, "http://jarvis.test"), { headers: { cookie: `jarvis_session=${createSession(userId).token}` } });
  return (composerRoute.GET as unknown as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req, {
    params: Promise.resolve({}),
  });
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  process.env.JARVIS_MOCK_UPSTREAM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  const h = demoPresets()!.hermes!;
  saveIntegration("hermes", { enabled: true, config: h.config, secrets: h.secrets });
  sam = createPerson({ name: "Sam", username: "sam", role: "adult", passcode: "sam-secret" }, owner).id;
});
afterAll(() => {
  delete process.env[KEY_ENV];
  server?.close();
});
beforeEach(() => {
  process.env[KEY_ENV] = MOCK_PROFILE_KEYS.momentumchief;
  saveAgentSettings({ routing: true, aguiStream: false, routes: [{ profile: "momentumchief", keyEnv: KEY_ENV, baseUrl: null }] });
});
afterEach(() => vi.restoreAllMocks());

describe("new chat speed", () => {
  it("opening a conversation never lists Hermes sessions (that list takes ~9 s on prod)", async () => {
    const u = me();
    const s = await startConversation(u, { title: "Fast open", backend: "hermes" }, cid);
    const list = vi.spyOn(HermesSessionClient, "list");
    const detail = await getSessionDetail(u, s.id);
    expect(detail.session.id).toBe(s.id);
    expect(detail.children).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("a title Hermes already uses is retried with a number instead of failing", async () => {
    const real = HermesSessionClient.create.bind(HermesSessionClient);
    const titles: (string | undefined)[] = [];
    vi.spyOn(HermesSessionClient, "create").mockImplementation(async (conn, body) => {
      titles.push(body.title);
      if (body.title === "Same question") throw new UpstreamError("Hermes", "bad_response", `Hermes returned 400: {"error": {"code": "invalid_title"}}`, 502);
      return real(conn, body);
    });
    const s = await startConversation(me(), { title: "Same question", backend: "hermes" }, cid);
    expect(s.id).toBeTruthy();
    expect(titles).toEqual(["Same question", "Same question (2)"]);
  });

  it("other Hermes errors still fail", async () => {
    vi.spyOn(HermesSessionClient, "create").mockRejectedValue(new UpstreamError("Hermes", "unreachable", "Hermes is down"));
    await expect(startConversation(me(), { title: "x", backend: "hermes" }, cid)).rejects.toThrow(/down/);
  });
});

describe("composer target by route (pure)", () => {
  it("reads the node from Areas URLs and the session from conversation URLs", () => {
    expect(nodeIdFromRoute("/areas", "?item=abc_123")).toBe("abc_123");
    expect(nodeIdFromRoute("/areas/timeline", new URLSearchParams("node=n1"))).toBe("n1");
    expect(nodeIdFromRoute("/areas", "")).toBeNull();
    expect(nodeIdFromRoute("/home", "?item=abc")).toBeNull();
    expect(nodeIdFromRoute("/areas", "?item=../../etc")).toBeNull();
    expect(sessionIdFromRoute("/chat/api_1_abc")).toBe("api_1_abc");
    expect(sessionIdFromRoute("/chat")).toBeNull();
  });

  it("routed area → its profile; routing off / no agent → Jarvis (still filed there); chip switch → plain Jarvis", () => {
    const node = { id: "n1", title: "Momentum bets", kind: "area", path: ["Momentum bets"], areaId: "n1", areaTitle: "Momentum bets" };
    const routed = { requested: "momentumchief", profile: "momentumchief", routed: true, reason: "routed" as const };
    const t = composerTargetFor(node, routed);
    expect(t).toMatchObject({ agent: "momentumchief", routed: true, areaId: "n1", context: `${NODE_CTX_PREFIX}n1` });
    expect(composerLabel(t)).toBe("Ask momentumchief · Momentum bets");
    const off = composerTargetFor(node, { requested: "momentumchief", profile: null, routed: false, reason: "routing_off" });
    expect(off).toMatchObject({ agent: "Jarvis", routed: false, areaId: "n1" });
    expect(composerTargetFor(node, routed, true)).toBe(JARVIS_TARGET);
    expect(composerTargetFor(null, routed)).toBe(JARVIS_TARGET);
    expect(composerLabel(JARVIS_TARGET)).toBe("Ask Jarvis");
  });
});

describe("composer target and context (server)", () => {
  it("a project inside a routed area answers as the area's agent, with path and open items as context", async () => {
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum bets" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const project = store.createItem(u, { kind: "project", title: "Caskfolk", parentId: area.id }, cid);
    store.createItem(u, { kind: "thread", title: "Trademark search", parentId: project.id }, cid);
    const t = composerTarget(owner, project.id);
    expect(t.node).toMatchObject({ id: project.id, title: "Caskfolk", path: ["Momentum bets", "Caskfolk"], areaTitle: "Momentum bets" });
    expect(t.agent).toMatchObject({ profile: "momentumchief", routed: true });
    const res = await (await get(`/api/agents/composer?nodeId=${project.id}`)).json();
    expect(res).toMatchObject({ node: { title: "Caskfolk" }, agent: { profile: "momentumchief" } });

    const block = nodeContextBlock(owner, project.id);
    expect(block).toContain("Momentum bets › Caskfolk");
    expect(block).toContain("Trademark search");
    const resolved = resolveContextRefs(u, `${NODE_CTX_PREFIX}${project.id}`);
    expect(resolved.context).toBeUndefined();
    expect(resolved.blocks.join("\n")).toContain("Trademark search");

    // Conversation pages follow the node the chat is filed under.
    const s = await startConversation(u, { title: "Composer filed", backend: "hermes", areaId: project.id }, cid);
    expect(s.placedIn).toBe(project.id);
    expect(s.agentProfile).toBe("momentumchief");
    const bySession = await (await get(`/api/agents/composer?sessionId=${encodeURIComponent(s.id)}`)).json();
    expect(bySession.node?.id).toBe(project.id);
  });

  it("someone else's node is never resolved or expanded", async () => {
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Private area" }, cid);
    expect(composerTarget(sam, area.id).node).toBeNull();
    expect(nodeContextBlock(sam, area.id)).toBe("");
    const res = await (await get(`/api/agents/composer?nodeId=${area.id}`, sam)).json();
    expect(res.node).toBeNull();
  });
});
