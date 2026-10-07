/**
 * Swappable assistant: Claude-direct conversations next to Hermes, through
 * the same routes, SSE format and access rules. Uses the mock Anthropic API.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, userById } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import { assistantStatus, saveAssistantSettings } from "@/server/assistant/settings";
import { createSession as newConversation, forkSession, getRun, getSessionDetail, listSessions, startRun, stopRun, updateSession } from "@/server/assistant";
import { SseParser } from "@/lib/sse";
import * as eventsRoute from "@/app/api/hermes/runs/[runId]/events/route";
import * as sessionsRoute from "@/app/api/hermes/sessions/route";
import * as assistantRoute from "@/app/api/assistant/route";

let server: Server;
let base: string;
let owner: string;
let sam: string;
const C = "corr";
const as = (id: string) => userById(id)!;

async function call(handler: unknown, url: string, userId: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method,
    headers: { "content-type": "application/json", "x-jarvis-csrf": "1", cookie: `jarvis_session=${createSession(userId).token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req, { params: Promise.resolve(params) });
}

async function readEvents(runId: string, userId = owner) {
  const res = await call(eventsRoute.GET, `/api/hermes/runs/${runId}/events`, userId, "GET", undefined, { runId });
  const text = await res.text();
  const p = new SseParser();
  return [...p.push(text), ...p.end()].map((f) => JSON.parse(f.data) as { type: string; delta?: string; status?: string; text?: string; error?: string });
}

async function waitDone(runId: string, userId = owner) {
  for (let i = 0; i < 100; i++) {
    const r = await getRun(as(userId), runId);
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
  process.env.JARVIS_ANTHROPIC_BASE_URL = `${base}/anthropic`;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  const h = demoPresets()!.hermes!;
  saveIntegration("hermes", { enabled: true, config: h.config, secrets: h.secrets });
  sam = createPerson({ name: "Sam", username: "sam", role: "adult", passcode: "sam-secret" }, owner).id;
});
afterAll(() => {
  delete process.env.JARVIS_ANTHROPIC_BASE_URL;
  server?.close();
});

describe("assistant backends", () => {
  it("Claude is unavailable until a key is set; the key is never returned", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(assistantStatus().backends.find((b) => b.id === "claude")!.available).toBe(false);
    await expect(newConversation(as(owner), "x", "claude")).rejects.toThrow(/isn't set up/);
    saveAssistantSettings({ apiKey: "mock-anthropic-key", defaultBackend: "claude" });
    const r = await call(assistantRoute.GET, "/api/assistant", owner);
    const text = await r.text();
    expect(text).not.toContain("mock-anthropic-key");
    expect(JSON.parse(text)).toMatchObject({ defaultBackend: "claude", claude: { model: "claude-opus-5-5", keySet: true } });
    // Only admins change it.
    expect((await call(assistantRoute.PUT, "/api/assistant", sam, "PUT", { defaultBackend: "hermes" })).status).toBe(403);
    if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
  });

  it("streams a Claude reply in the normal run-event format and keeps the transcript", async () => {
    const s = await newConversation(as(owner), undefined, "claude");
    expect(s.id).toMatch(/^loc_/);
    const run = await startRun(as(owner), { sessionId: s.id, input: "What's for dinner?", idempotencyKey: "claude-run-1" }, C);
    expect(run.runId).toMatch(/^lrn_/);
    const events = await readEvents(run.runId);
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    const text = events
      .filter((e) => e.type === "text.delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain('You asked: "What\'s for dinner?"');
    expect(events.at(-1)).toMatchObject({ type: "run.terminal", status: "completed" });
    const detail = await getSessionDetail(as(owner), s.id);
    expect(detail.timeline.map((t) => t.kind)).toEqual(["user", "assistant"]);
    expect(detail.session.title).toBe("What's for dinner?");
    // Second turn sends the whole conversation.
    const run2 = await startRun(as(owner), { sessionId: s.id, input: "And dessert?", idempotencyKey: "claude-run-2" }, C);
    await waitDone(run2.runId);
    const after = await getSessionDetail(as(owner), s.id);
    expect(after.timeline.at(-1)).toMatchObject({ kind: "assistant" });
    expect((after.timeline.at(-1) as { text: string }).text).toContain("3 messages");
    // Same idempotency key: same run, no new message.
    expect((await startRun(as(owner), { sessionId: s.id, input: "And dessert?", idempotencyKey: "claude-run-2" }, C)).runId).toBe(run2.runId);
    const mock = (await (await fetch(`${base}/__mock/state`)).json()) as { anthropicRequests: { model: string; beta: string | null; effort: string | null }[] };
    expect(mock.anthropicRequests.at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(mock.anthropicRequests.at(-1)!.beta).toContain("server-side-fallback-2026-07-01");
  });

  it("a refusal fails the run with a plain message", async () => {
    const s = await newConversation(as(owner), undefined, "claude");
    const run = await startRun(as(owner), { sessionId: s.id, input: "decline-me", idempotencyKey: "claude-refuse" }, C);
    const r = await waitDone(run.runId);
    expect(r).toMatchObject({ status: "failed", error: "Claude declined to answer this." });
  });

  it("stop cancels mid-answer and keeps what was said", async () => {
    await fetch(`${base}/__mock/speed`, { method: "POST", body: JSON.stringify({ ms: 400 }), headers: { "content-type": "application/json" } });
    const s = await newConversation(as(owner), undefined, "claude");
    const run = await startRun(as(owner), { sessionId: s.id, input: "Tell me a long story about the garage door", idempotencyKey: "claude-stop" }, C);
    await new Promise((r) => setTimeout(r, 150));
    stopRun(as(owner), run.runId, C);
    expect((await waitDone(run.runId)).status).toBe("cancelled");
    await fetch(`${base}/__mock/speed`, { method: "POST", body: JSON.stringify({ ms: 80 }), headers: { "content-type": "application/json" } });
  });

  it("lists Hermes and Claude conversations together; privacy and sharing apply to both", async () => {
    const mine = await listSessions(as(owner));
    expect(mine.sessions.some((s) => s.source === "claude")).toBe(true);
    expect(mine.sessions.some((s) => s.source !== "claude")).toBe(true);
    const samList = await listSessions(as(sam));
    expect(samList.sessions.some((s) => s.id.startsWith("loc_"))).toBe(false);
    const s = mine.sessions.find((x) => x.source === "claude")!;
    await updateSession(as(owner), s.id, { shared: true }, C);
    const shared = (await listSessions(as(sam))).sessions.find((x) => x.id === s.id)!;
    expect(shared.readOnly).toBe(true);
    await expect(startRun(as(sam), { sessionId: s.id, input: "hi", idempotencyKey: "sam-try" }, C)).rejects.toThrow(/read-only/);
    // Sam can fork it and continue there.
    const fork = await forkSession(as(sam), s.id, { prompt: "Continue for me" }, C);
    expect(fork.session.readOnly).toBe(false);
    await waitDone(fork.run!.runId, sam);
    expect((await getSessionDetail(as(sam), fork.session.id)).timeline.length).toBeGreaterThan(2);
  });

  it("new conversations go to the chosen backend through the route", async () => {
    const r = await call(sessionsRoute.POST, "/api/hermes/sessions", owner, "POST", { backend: "hermes" });
    expect(((await r.json()) as { id: string }).id).not.toMatch(/^loc_/);
    const d = await call(sessionsRoute.POST, "/api/hermes/sessions", owner, "POST", {});
    expect(((await d.json()) as { id: string }).id).toMatch(/^loc_/);
  });
});
