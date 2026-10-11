import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, userById } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { HermesSessionClient } from "@/integrations/hermes/client";
import { listSessionPage } from "@/integrations/hermes/service";
import { createLocalSession } from "@/server/assistant/local";
import { saveAssistantSettings } from "@/server/assistant/settings";
import { SYNC_SESSION_SOURCE } from "@/integrations/hermes/structured";
import { mergeSessionPages, type SessionPage } from "@/lib/session-pages";
import { GET } from "@/app/api/hermes/sessions/route";

let owner: string;
let adult: string;
let kid: string;
beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "secret123" });
  adult = createPerson({ name: "Adult", username: "adult", role: "adult", passcode: "secret123" }, owner).id;
  kid = createPerson({ name: "Kid", username: "kid", role: "kid", passcode: "secret123" }, owner).id;
  saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.test" }, secrets: { apiKey: "test-key" } });
});
afterEach(() => vi.restoreAllMocks());
const row = (n: number) => ({ id: `s${n}`, title: `Chat ${n}`, source: "api_server" });
async function request(query = "", id = owner) {
  return GET(new NextRequest(`http://jarvis.test/api/hermes/sessions${query}`, { headers: { cookie: `jarvis_session=${createSession(id).token}` } }), {
    params: Promise.resolve({}),
  });
}

describe("bounded chat windows", () => {
  it("uses a list-specific 20s budget and forwards cancellation through the HTTP boundary", async () => {
    const budget = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeDefined();
      controller.abort();
      init!.signal!.throwIfAborted();
      return Response.json({ data: [] });
    });
    await expect(HermesSessionClient.list({ baseUrl: "http://hermes.test" }, { limit: 20, offset: 40, signal: controller.signal })).rejects.toThrow();
    expect(budget).toHaveBeenCalledWith(20_000);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("limit=20&offset=40&include_children=true");
  });
  it("reaches >100 sessions, including a sparse owned row after five empty pages", async () => {
    const rows = Array.from({ length: 123 }, (_, n) => row(n));
    getDb().insert(schema.sessionMeta).values({ sessionId: "s119", userId: adult }).run();
    const upstream = vi.spyOn(HermesSessionClient, "list").mockImplementation(async (_c, q = {}) => ({
      data: rows.slice(q.offset, (q.offset ?? 0) + q.limit!),
      limit: q.limit,
      offset: q.offset,
      has_more: (q.offset ?? 0) + q.limit! < rows.length,
    }));
    const pages: SessionPage[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await listSessionPage(userById(adult)!, { offset });
      pages.push(page);
      offset = page.nextOffset;
      expect(pages.length).toBeLessThan(10);
    }
    expect(pages.slice(0, 5).every((p) => p.sessions.length === 0 && p.nextOffset !== null)).toBe(true);
    expect(mergeSessionPages(pages).map((s) => s.id)).toEqual(["s119"]);
    expect(upstream.mock.calls.map((c) => c[1]?.offset)).toEqual([0, 20, 40, 60, 80, 100, 120]);
    const ownedPages = await Promise.all([0, 20, 40, 60, 80, 100, 120].map((offset) => listSessionPage(userById(owner)!, { offset })));
    expect(mergeSessionPages(ownedPages)).toHaveLength(122);
  });

  it("does not trust filtered lengths or pin-underreported has_more; advances SQL windows, deduplicates pins", async () => {
    const pin = { ...row(900), pinned: true };
    vi.spyOn(HermesSessionClient, "list")
      .mockResolvedValueOnce({ data: [pin, ...Array.from({ length: 19 }, (_, n) => row(n))], has_more: false })
      .mockResolvedValueOnce({ data: [row(20), pin, pin], has_more: false });
    const first = await listSessionPage(userById(owner)!, { offset: 0 });
    expect(first.nextOffset).toBe(20);
    const last = await listSessionPage(userById(owner)!, { offset: first.nextOffset! });
    expect(last.nextOffset).toBeNull();
    expect(mergeSessionPages([first, last])).toHaveLength(21);
  });

  it("preserves hidden/sync/archive/shared ownership filtering on each continuation", async () => {
    getDb().insert(schema.sessionMeta).values({ sessionId: "s4", userId: owner, shared: true }).run();
    vi.spyOn(HermesSessionClient, "list").mockResolvedValue({
      data: [{ ...row(1), hidden: true }, { ...row(2), source: SYNC_SESSION_SOURCE }, { ...row(3), archived: true }, row(4)],
    });
    expect((await listSessionPage(userById(owner)!, { offset: 20 })).sessions.map((s) => s.id)).toEqual(["s4"]);
    expect((await listSessionPage(userById(owner)!, { offset: 20, includeArchived: true })).sessions.map((s) => s.id)).toEqual(["s3", "s4"]);
    expect((await listSessionPage(userById(adult)!, { offset: 20, includeArchived: true })).sessions).toMatchObject([{ id: "s4", readOnly: true }]);
  });

  it("keeps legacy/native fields, uses 100 without offset, and adds continuation for updated clients", async () => {
    const spy = vi.spyOn(HermesSessionClient, "list").mockResolvedValue({ data: [row(1)], has_more: true });
    expect(await (await request()).json()).toMatchObject({ sessions: [{ id: "s1" }], unavailable: [], nextOffset: 100 });
    expect(spy.mock.calls[0]?.[1]?.limit).toBe(100);
    expect(await (await request("?offset=0")).json()).toMatchObject({ sessions: [{ id: "s1" }], unavailable: [], nextOffset: 20 });
    expect(spy.mock.calls[1]?.[1]?.limit).toBe(20);
  });

  it("validates offsets and capabilities before upstream work", async () => {
    const spy = vi.spyOn(HermesSessionClient, "list").mockResolvedValue({ data: [] });
    for (const raw of ["-1", "1.5", "abc", "1000001", ""]) expect((await request(`?offset=${raw}`)).status).toBe(400);
    expect((await request("?offset=20", kid)).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates cancellation and rejects mismatched pagination", async () => {
    const signal = AbortSignal.abort();
    const spy = vi.spyOn(HermesSessionClient, "list").mockResolvedValue({ data: [], offset: 0 });
    await expect(listSessionPage(userById(owner)!, { offset: 20, signal })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    await expect(listSessionPage(userById(owner)!, { offset: 20 })).rejects.toThrow(/different conversation window/);
  });

  it("makes local-only fallback explicitly incomplete and retries the same remote offset", async () => {
    saveAssistantSettings({ apiKey: "mock-test-key", defaultBackend: "claude" });
    createLocalSession(userById(owner)!, "Local");
    vi.spyOn(HermesSessionClient, "list").mockRejectedValue(new Error("timeout"));
    expect(await (await request("?offset=0")).json()).toMatchObject({ unavailable: ["Hermes"], nextOffset: 0 });
  });
});
