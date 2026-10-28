/**
 * Coordinators C1: per-area Hermes profile routing (Settings → Agents).
 * Uses the mock Hermes, which (like the real gateway with multiplex_profiles)
 * serves named profiles under /p/<profile>/ with their own key and keeps each
 * profile's sessions and runs in a separate store, so a request sent to the
 * wrong profile 404s.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq, like } from "drizzle-orm";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { MOCK_PROFILE_KEYS } from "../mock-upstreams/hermes.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, userById } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { hermesConn } from "@/integrations/hermes/client";
import { demoPresets } from "@/integrations/demo";
import * as store from "@/server/work/store";
import { conversationAreaContext, startConversation } from "@/server/areas";
import { getRun, getSessionDetail, listSessions, startRun } from "@/server/assistant";
import { connForProfile, resolveAgent, resolveAgentForNode, saveAgentSettings } from "@/server/agents/routing";
import { agentSettingsSchema, suggestedKeyEnv } from "@/lib/agents";
import { saveAiSettings } from "@/server/ai/settings";
import { enqueue } from "@/server/ai/jobs";
import { SseParser } from "@/lib/sse";
import * as eventsRoute from "@/app/api/hermes/runs/[runId]/events/route";
import * as agentsRoute from "@/app/api/settings/agents/route";
import * as agentsTestRoute from "@/app/api/settings/agents/test/route";
import * as resolveRoute from "@/app/api/agents/resolve/route";

let server: Server;
let base: string;
let owner: string;
let sam: string;
const cid = "corr";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const KEY_ENV = suggestedKeyEnv("momentumchief");

async function call(handler: unknown, url: string, userId = owner, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method,
    headers: {
      "content-type": "application/json",
      "x-jarvis-csrf": "1",
      origin: "http://jarvis.test",
      cookie: `jarvis_session=${createSession(userId).token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req, { params: Promise.resolve(params) });
}

const mockState = async () => (await (await fetch(`${base}/__mock/state`)).json()) as { hermesProfileRequests: Record<string, number> };
const profileHits = async (p: string) => (await mockState()).hermesProfileRequests[p] ?? 0;

async function readSse(runId: string, query = "") {
  const res = await call(eventsRoute.GET, `/api/hermes/runs/${runId}/events${query}`, owner, "GET", undefined, { runId });
  const p = new SseParser();
  const text = await res.text();
  return [...p.push(text), ...p.end()].filter((f) => f.data).map((f) => JSON.parse(f.data) as { type: string });
}

async function waitDone(runId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await getRun(userById(owner)!, runId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(r.status)) return r;
    await new Promise((x) => setTimeout(x, 30));
  }
  throw new Error("run did not finish");
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
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

describe("agent settings", () => {
  it("only accepts JARVIS_HERMES_KEY_* key refs and Hermes profile ids", () => {
    const ok = { routing: true, aguiStream: false, routes: [{ profile: "momentumchief", keyEnv: KEY_ENV, baseUrl: null }] };
    expect(agentSettingsSchema.safeParse(ok).success).toBe(true);
    expect(agentSettingsSchema.safeParse({ ...ok, routes: [{ ...ok.routes[0], keyEnv: "GOOGLE_CLIENT_SECRET" }] }).success).toBe(false);
    expect(agentSettingsSchema.safeParse({ ...ok, routes: [{ ...ok.routes[0], profile: "../default" }] }).success).toBe(false);
    expect(agentSettingsSchema.safeParse({ ...ok, routes: [ok.routes[0], ok.routes[0]] }).success).toBe(false);
    expect(agentSettingsSchema.safeParse({ ...ok, routes: [{ ...ok.routes[0], baseUrl: "javascript:alert(1)" }] }).success).toBe(false);
  });

  it("a route without a key env reuses the main Hermes key, but only on the main Hermes server", () => {
    saveAgentSettings({ routes: [{ profile: "devchief", keyEnv: null, baseUrl: null }] });
    expect(agentSettingsSchema.safeParse({ routing: true, aguiStream: false, routes: [{ profile: "devchief", keyEnv: "", baseUrl: null }] }).success).toBe(
      true,
    );
    expect(resolveAgent("devchief")).toMatchObject({ profile: "devchief", routed: true, reason: "routed" });
    const main = hermesConn();
    const conn = connForProfile("devchief");
    expect(conn.apiKey).toBe(main.apiKey);
    expect(conn.baseUrl).toMatch(/\/p\/devchief$/);
    // A custom host never receives the main key.
    saveAgentSettings({ routes: [{ profile: "devchief", keyEnv: null, baseUrl: "https://elsewhere.example" }] });
    expect(resolveAgent("devchief")).toMatchObject({ routed: false, reason: "missing_key" });
    expect(() => connForProfile("devchief")).toThrow(/key isn't configured/);
  });

  it("resolution explains why a requested profile does or doesn't answer", () => {
    expect(resolveAgent(null)).toMatchObject({ profile: null, routed: false, reason: "default" });
    expect(resolveAgent("momentumchief")).toMatchObject({ profile: "momentumchief", routed: true, reason: "routed" });
    expect(resolveAgent("devchief")).toMatchObject({ profile: null, routed: false, reason: "not_configured" });
    delete process.env[KEY_ENV];
    expect(resolveAgent("momentumchief")).toMatchObject({ routed: false, reason: "missing_key" });
    process.env[KEY_ENV] = MOCK_PROFILE_KEYS.momentumchief;
    saveAgentSettings({ routing: false });
    expect(resolveAgent("momentumchief")).toMatchObject({ routed: false, reason: "routing_off" });
  });

  it("the settings API is admin-only and never returns a key", async () => {
    const r = await call(agentsRoute.GET, "/api/settings/agents");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(MOCK_PROFILE_KEYS.momentumchief);
    expect(JSON.parse(text).routes[0]).toMatchObject({
      profile: "momentumchief",
      keyEnv: KEY_ENV,
      keyPresent: true,
      effectiveBaseUrl: expect.stringMatching(/\/p\/momentumchief$/),
    });
    expect((await call(agentsRoute.GET, "/api/settings/agents", sam)).status).toBe(403);
    expect((await call(agentsRoute.PUT, "/api/settings/agents", sam, "PUT", { routing: false })).status).toBe(403);
  });

  it("Test probes the profile with its own key; a wrong key is reported, not hidden", async () => {
    const ok = await (await call(agentsTestRoute.POST, "/api/settings/agents/test", owner, "POST", { profile: "momentumchief" })).json();
    expect(ok).toMatchObject({ served: true, authorized: true });
    process.env[KEY_ENV] = "wrong-key-but-long-enough-0123";
    const bad = await (await call(agentsTestRoute.POST, "/api/settings/agents/test", owner, "POST", { profile: "momentumchief" })).json();
    expect(bad).toMatchObject({ served: true, authorized: false });
    expect(JSON.stringify(bad)).not.toContain("wrong-key");
  });
});

describe("routing chats, runs and AI jobs to the area's profile", () => {
  it("a chat started under a Momentum project runs on momentumchief end to end", async () => {
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum bets" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const project = store.createItem(u, { kind: "project", title: "Caskfolk", parentId: area.id }, cid);
    expect(resolveAgentForNode(owner, project.id)).toMatchObject({ requested: "momentumchief", routed: true, from: { id: area.id } });
    const resolved = await (await call(resolveRoute.GET, `/api/agents/resolve?nodeId=${project.id}`)).json();
    expect(resolved).toMatchObject({ profile: "momentumchief", routed: true });

    const before = await profileHits("momentumchief");
    const s = await startConversation(u, { title: "Trademark check", backend: "hermes", areaId: project.id }, cid);
    expect(s.agentProfile).toBe("momentumchief");
    expect(getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, s.id)).get()?.hermesProfile).toBe("momentumchief");
    // The mock keeps profile stores apart: this read 404s unless it is routed to momentumchief.
    const detail = await getSessionDetail(u, s.id);
    expect(detail.session.agentProfile).toBe("momentumchief");
    expect(conversationAreaContext(u, s.id, "Trademark check")).toMatchObject({ agent: { profile: "momentumchief", routed: true } });

    const run = await startRun(u, { sessionId: s.id, input: "hello there", idempotencyKey: `route-${s.id}` }, cid);
    expect(getDb().select().from(schema.runs).where(eq(schema.runs.runId, run.runId)).get()?.hermesProfile).toBe("momentumchief");
    const events = await readSse(run.runId, "?format=agui");
    // AG-UI flag is off: Jarvis events even when the client asks.
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    expect((await waitDone(run.runId)).status).toBe("completed");
    expect(await profileHits("momentumchief")).toBeGreaterThan(before);

    // It shows in the conversation list even though the default profile doesn't know it.
    const list = await listSessions(u, {});
    expect(list.sessions.find((x) => x.id === s.id)?.agentProfile).toBe("momentumchief");
  });

  it("routed conversations page with the list and an unreachable profile flags a partial list", async () => {
    const u = me();
    const rows = Array.from({ length: 31 }, (_, i) => ({
      sessionId: `routed-page-${String(i).padStart(2, "0")}`,
      userId: owner,
      hermesProfile: "momentumchief",
      lastSeenAt: `2020-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    getDb().insert(schema.sessionMeta).values(rows).run();
    // 31 rows (deleted upstream, so 404 = gone, not unavailable) overflow one routed page.
    const first = await listSessions(u, { offset: 0 });
    expect(first.unavailable).toEqual([]);
    expect(first.nextOffset).not.toBeNull();
    getDb().delete(schema.sessionMeta).where(like(schema.sessionMeta.sessionId, "routed-page-%")).run();

    getDb().insert(schema.sessionMeta).values({ sessionId: "routed-down-1", userId: owner, hermesProfile: "devchief" }).run();
    const partial = await listSessions(u, { offset: 0 });
    expect(partial.unavailable).toContain("Hermes (devchief)");
    getDb().delete(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, "routed-down-1")).run();
  });

  it("with the AG-UI flag on, the same relay streams AG-UI events (only when asked)", async () => {
    saveAgentSettings({ aguiStream: true });
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum two" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const s = await startConversation(u, { title: "AG-UI", backend: "hermes", areaId: area.id }, cid);
    const run = await startRun(u, { sessionId: s.id, input: "hello again", idempotencyKey: `agui-${s.id}` }, cid);
    const agui = await readSse(run.runId, "?format=agui");
    expect(agui[0]?.type).toBe("RUN_STARTED");
    expect(agui.some((e) => e.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(agui.at(-1)?.type).toBe("RUN_FINISHED");
    // Old clients and the phone app never ask, so they keep Jarvis events.
    const jarvis = await readSse(run.runId);
    expect(jarvis.some((e) => e.type === "text.delta")).toBe(true);
  });

  it("areas without an agent, and routing off, stay on the default profile", async () => {
    const u = me();
    const plain = store.createItem(u, { kind: "area", title: "Homelab plain" }, cid);
    const a = await startConversation(u, { title: "plain", backend: "hermes", areaId: plain.id }, cid);
    expect(a.agentProfile).toBeUndefined();
    saveAgentSettings({ routing: false });
    const area = store.createItem(u, { kind: "area", title: "Momentum off" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const b = await startConversation(u, { title: "off", backend: "hermes", areaId: area.id }, cid);
    expect(b.agentProfile).toBeUndefined();
    // Started on default; the chip says so once routing turns on.
    saveAgentSettings({ routing: true });
    expect(conversationAreaContext(u, b.id, "off")).toMatchObject({ agent: { requested: "momentumchief", routed: false, reason: "started_on_default" } });
  });

  it("a conversation keeps its profile: removing the route fails clearly instead of asking the default", async () => {
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum three" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const s = await startConversation(u, { title: "keeps", backend: "hermes", areaId: area.id }, cid);
    saveAgentSettings({ routes: [] });
    await expect(getSessionDetail(u, s.id)).rejects.toThrow(/isn't set up in Settings → Agents/);
    expect(() => connForProfile("momentumchief")).toThrow(/Settings → Agents/);
  });

  it("AI jobs record the profile they run on (inherited from the area)", () => {
    saveAiSettings({ enabled: true });
    const u = me();
    const area = store.createItem(u, { kind: "area", title: "Momentum jobs" }, cid);
    store.updateItem(u, area.id, { settings: { agentMode: "momentumchief" } } as never, cid);
    const item = store.createItem(u, { kind: "thread", title: "Research odds feeds", parentId: area.id }, cid);
    const { job } = enqueue({ userId: owner, kind: "research", subjectType: "work_item", subjectId: item.id, clientKey: "route0001", correlationId: cid });
    expect(getDb().select().from(schema.aiJobs).where(eq(schema.aiJobs.id, job.id)).get()?.hermesProfile).toBe("momentumchief");
    saveAgentSettings({ routing: false });
    const other = store.createItem(u, { kind: "thread", title: "Research hint only", parentId: area.id }, cid);
    const j2 = enqueue({ userId: owner, kind: "research", subjectType: "work_item", subjectId: other.id, clientKey: "route0002", correlationId: cid }).job;
    expect(getDb().select().from(schema.aiJobs).where(eq(schema.aiJobs.id, j2.id)).get()?.hermesProfile).toBeNull();
    saveAiSettings({ enabled: false });
  });
});
