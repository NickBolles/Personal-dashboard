import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/integrations/hermes/client", () => {
  let n = 0;
  const runs = new Map<string, { kind: string; input: string }>();
  return {
    hermesConn: () => ({ baseUrl: "http://fake" }),
    HermesSessionClient: {
      create: vi.fn(async () => ({ session: { id: `s${++n}` } })),
      update: vi.fn(async () => ({ session: {} })),
      remove: vi.fn(async () => ({ deleted: true })),
      get: vi.fn(async (_c: unknown, id: string) => ({ session: { id, estimated_cost_usd: 0.004 } })),
    },
    HermesExecutionClient: {
      start: vi.fn(async (_c: unknown, r: { input: string; instructions: string }) => {
        const id = `r${++n}`;
        runs.set(id, { kind: /kind=(\w+)/.exec(r.instructions)![1]!, input: r.input });
        return { run_id: id, status: "queued" };
      }),
      status: vi.fn(async (_c: unknown, id: string) => {
        const r = runs.get(id)!;
        const output =
          r.kind === "triage"
            ? JSON.stringify({
                title: "Fix the porch light",
                kind: "home_issue",
                destinationKey: (globalThis as { __dest?: string }).__dest ?? null,
                confidence: 0.82,
                reason: "home",
                shouldInvestigate: true,
                brief: "Find bulb type",
                sensitivity: "none",
              })
            : JSON.stringify({
                title: "Porch light notes",
                summary: "LED A19, 2700K",
                body_markdown: "Use LED [1]",
                sources: [{ url: "https://example.com/bulbs", title: "Bulbs" }],
                next_actions: [{ title: "Buy bulb" }],
                confidence: "medium",
              });
        return { run_id: id, status: "completed", output };
      }),
      stop: vi.fn(async () => ({ status: "cancelled" })),
    },
  };
});
vi.mock("@/integrations/store", async (orig) => ({ ...(await orig<typeof import("@/integrations/store")>()), isConfigured: () => true }));

import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { recentAudit } from "@/server/audit";
import { config } from "@/server/config";
import * as store from "@/server/work/store";
import { resolveUser } from "@/server/auth";
import { saveAiSettings } from "@/server/ai/settings";
import { drainRunner, runnerTick } from "@/server/ai/runner";
import { HermesExecutionClient } from "@/integrations/hermes/client";
import { sniffMime, imageSize, declaredMatches } from "@/server/capture/sniff";
import * as captureRoute from "@/app/api/capture/route";
import * as captureStatusRoute from "@/app/api/capture/[id]/route";
import * as attRoute from "@/app/api/capture/attachments/[id]/route";
import * as tokensRoute from "@/app/api/devices/capture-tokens/route";
import * as tokenRoute from "@/app/api/devices/capture-tokens/[id]/route";
import * as acceptRoute from "@/app/api/work/inbox/[id]/accept/route";
import * as inboxRoute from "@/app/api/work/inbox/route";
import * as investigateRoute from "@/app/api/work/inbox/[id]/investigate/route";
import * as homeRoute from "@/app/api/home/route";
import * as itemsRoute from "@/app/api/work/items/route";
import * as sessionsRoute from "@/app/api/hermes/sessions/route";
import * as financeRoute from "@/app/api/finance/overview/route";

// 1×1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

let owner: string, kid: string;
type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function req(
  handler: unknown,
  o: {
    method?: string;
    body?: BodyInit;
    json?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    session?: string | null;
    csrf?: boolean;
  } = {},
) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.session !== null) headers.cookie = `jarvis_session=${createSession(o.session ?? owner).token}`;
  if (o.csrf !== false && o.session !== null) headers["x-jarvis-csrf"] = "1";
  if (o.json !== undefined) headers["content-type"] = "application/json";
  return (handler as H)(
    new NextRequest("http://jarvis.test/api/capture", { method: o.method ?? "POST", headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.body }),
    {
      params: Promise.resolve(o.params ?? {}),
    },
  );
}

function multipart(fields: Record<string, string>, files: { name: string; type: string; data: Uint8Array }[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const f of files) fd.append("files", new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  return fd;
}

async function makeToken(extra: Record<string, unknown> = {}) {
  const r = await req(tokensRoute.POST, { json: { label: "HTTP Shortcuts", ...extra } });
  expect(r.status).toBe(200);
  return (await r.json()) as { token: string; tokenInfo: { id: string } };
}

beforeEach(() => {
  __setTestDatabase();
  process.env.JARVIS_AI_POLL_MS = "1";
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
  delete (globalThis as { __dest?: string }).__dest;
});
afterEach(() => vi.clearAllMocks());

describe("capture files (pure)", () => {
  it("sniffs magic bytes, refuses SVG/HTML, reads dimensions", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(imageSize(PNG, "image/png")).toEqual({ width: 1, height: 1 });
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(sniffMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>"))).toBeNull();
    expect(sniffMime(new TextEncoder().encode("<!doctype html><p>x"))).toBeNull();
    expect(sniffMime(new TextEncoder().encode("plain notes"))).toBe("text/plain");
    expect(declaredMatches("image/jpeg", "image/png")).toBe(false);
    expect(declaredMatches("image/jpg", "image/jpeg")).toBe(true);
  });
});

describe("POST /api/capture", () => {
  it("cookie path needs CSRF; multipart with an image lands in the inbox once (idempotent clientCaptureId)", async () => {
    expect((await req(captureRoute.POST, { json: { text: "x" }, csrf: false })).status).toBe(403);
    expect((await req(captureRoute.POST, { json: { text: "x" }, session: null, headers: { "x-jarvis-csrf": "1" } })).status).toBe(401);
    const body = multipart({ text: "Porch light flickers\nsince Tuesday", clientCaptureId: "offline-0001" }, [
      { name: "shot.png", type: "image/png", data: PNG },
    ]);
    const r = await req(captureRoute.POST, { body });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.entry.title).toBe("Porch light flickers");
    expect(j.entry.capture.attachments).toHaveLength(1);
    expect(j.triage).toBe("skipped"); // AI is off by default
    expect(j.reason).toBe("ai_disabled");
    const again = await req(captureRoute.POST, { body: multipart({ text: "dup", clientCaptureId: "offline-0001" }) });
    expect(again.status).toBe(200);
    expect((await again.json()).entry.id).toBe(j.entry.id);
    expect(getDb().select().from(schema.workInbox).where(eq(schema.workInbox.source, "capture")).all()).toHaveLength(1);
    // File stored outside public/, 0600, served owner-only with safe headers.
    const att = getDb().select().from(schema.captureAttachments).get()!;
    const abs = path.join(config.dataDir, "captures", att.storageKey);
    expect(abs.includes(`${path.sep}public${path.sep}`)).toBe(false);
    expect(fs.statSync(abs).mode & 0o777).toBe(0o600);
    const dl = await req(attRoute.GET, { method: "GET", params: { id: att.id } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("cache-control")).toBe("no-store, private");
    const other = createPerson({ name: "Adult", username: "adult", role: "adult", passcode: "synthetic-pass" }, owner).id;
    expect((await req(attRoute.GET, { method: "GET", params: { id: att.id }, session: other })).status).toBe(404);
  });

  it("offline replays queued by another account are refused (409) and never land in this inbox", async () => {
    const r = await req(captureRoute.POST, { body: multipart({ text: "someone else's", clientCaptureId: "offline-0002", queuedBy: "usr_other" }) });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("wrong_account");
    const ok = await req(captureRoute.POST, { body: multipart({ text: "mine", clientCaptureId: "offline-0003", queuedBy: owner }) });
    expect(ok.status).toBe(201);
    expect(getDb().select().from(schema.workInbox).where(eq(schema.workInbox.source, "capture")).all()).toHaveLength(1);
  });

  it("filing keeps the captured URL and attachments reachable from the item (links)", async () => {
    const r = await req(captureRoute.POST, {
      body: multipart({ text: "Read later", url: "https://example.com/post", clientCaptureId: "offline-0004" }, [
        { name: "shot.png", type: "image/png", data: PNG },
      ]),
    });
    const { entry } = await r.json();
    const acc = await req(acceptRoute.POST, { json: { parentId: null }, params: { id: entry.id } });
    expect(acc.status).toBe(200);
    const { item } = await acc.json();
    const links = getDb().select().from(schema.workLinks).where(eq(schema.workLinks.itemId, item.id)).all();
    const att = getDb().select().from(schema.captureAttachments).get()!;
    expect(links.map((l) => l.url).sort()).toEqual([`/api/capture/attachments/${att.id}`, "https://example.com/post"].sort());
    expect(att.itemId).toBe(item.id);
  });

  it("limits: 415 on type mismatch or SVG, 413 on too many / too large files", async () => {
    const svg = new TextEncoder().encode("<svg onload=alert(1)></svg>");
    expect((await req(captureRoute.POST, { body: multipart({ text: "a" }, [{ name: "x.svg", type: "image/svg+xml", data: svg }]) })).status).toBe(415);
    expect((await req(captureRoute.POST, { body: multipart({ text: "a" }, [{ name: "x.jpg", type: "image/jpeg", data: PNG }]) })).status).toBe(415);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, type: "image/png", data: PNG }));
    expect((await req(captureRoute.POST, { body: multipart({ text: "a" }, five) })).status).toBe(413);
    const big = new Uint8Array(10 * 1024 * 1024 + 10);
    big.set(PNG);
    expect((await req(captureRoute.POST, { body: multipart({ text: "a" }, [{ name: "big.png", type: "image/png", data: big }]) })).status).toBe(413);
    expect((await req(captureRoute.POST, { json: { text: "a", url: "javascript:alert(1)" } })).status).toBe(400);
    expect((await req(captureRoute.POST, { json: { text: "x".repeat(8001) } })).status).toBe(400);
    expect(getDb().select().from(schema.captureAttachments).all()).toHaveLength(0);
  });

  it("people without work.use can't capture", async () => {
    expect((await req(captureRoute.POST, { json: { text: "hi" }, session: kid })).status).toBe(403);
  });
});

describe("capture tokens", () => {
  it("token works only on capture routes; never echoed again or audited; revoke takes effect next request", async () => {
    const { token, tokenInfo } = await makeToken();
    expect(token).toMatch(/^jcap_/);
    const bearer = { authorization: `Bearer ${token}` };
    const r = await req(captureRoute.POST, {
      session: null,
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ text: "from shortcut", clientCaptureId: "uuid-12345678" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.entry.capture.channel).toBe("shortcut");
    const st = await req(captureStatusRoute.GET, { method: "GET", session: null, headers: bearer, params: { id: j.entry.id } });
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ id: j.entry.id, reportReady: false });
    // A capture made in the browser isn't readable with the token.
    const web = await (await req(captureRoute.POST, { json: { text: "web capture" } })).json();
    expect((await req(captureStatusRoute.GET, { method: "GET", session: null, headers: bearer, params: { id: web.entry.id } })).status).toBe(404);
    // 401 everywhere else.
    for (const h of [homeRoute.GET, itemsRoute.GET, sessionsRoute.GET, financeRoute.GET, inboxRoute.GET, tokensRoute.GET])
      expect((await req(h, { method: "GET", session: null, headers: bearer })).status).toBe(401);
    // Never echoed again, never in the audit log.
    const list = await (await req(tokensRoute.GET, { method: "GET" })).json();
    expect(JSON.stringify(list)).not.toContain(token.slice(5));
    expect(JSON.stringify(recentAudit(200))).not.toContain(token.slice(5));
    expect(recentAudit(200).some((a) => a.action === "capture_token.create")).toBe(true);
    // Revoke → next request 401.
    expect((await req(tokenRoute.DELETE, { method: "DELETE", params: { id: tokenInfo.id } })).status).toBe(200);
    expect(
      (
        await req(captureRoute.POST, {
          session: null,
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ text: "after revoke" }),
        })
      ).status,
    ).toBe(401);
  });

  it("expired tokens are refused; rate limits answer 429 with retry-after; bad tokens are throttled", async () => {
    const { token, tokenInfo } = await makeToken({ ratePerHour: 2 });
    const send = () =>
      req(captureRoute.POST, {
        session: null,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "rate" }),
      });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    getDb()
      .update(schema.captureTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.captureTokens.id, tokenInfo.id))
      .run();
    expect((await send()).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 7; i++)
      last = (
        await req(captureRoute.POST, {
          session: null,
          headers: { authorization: "Bearer jcap_wrongwrongwrongwrong", "content-type": "application/json" },
          body: "{}",
        })
      ).status;
    expect(last).toBe(429);
  });

  it("bearer device tokens can't manage capture tokens", async () => {
    const { createPairingCode, redeemPairingCode } = await import("@/server/devices");
    const code = createPairingCode(owner).code;
    const dev = redeemPairingCode(code, { name: "Pixel" });
    expect((await req(tokensRoute.GET, { method: "GET", session: null, headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(403);
  });
});

describe("AI triage → investigate chain", () => {
  it("finance captures are never sent to AI (zero Hermes calls) and say why; Send anyway is audited", async () => {
    saveAiSettings({ enabled: true });
    const r = await (await req(captureRoute.POST, { json: { text: "Chase checking balance $4,210" } })).json();
    expect(r.triage).toBe("skipped");
    expect(r.reason).toBe("finance_detected");
    expect(r.entry.capture.sensitivity).toBe("finance");
    const cred = await (await req(captureRoute.POST, { json: { text: "password: hunter2hunter2" } })).json();
    expect(cred.reason).toBe("credentials_detected");
    await runnerTick();
    await drainRunner();
    expect(HermesExecutionClient.start).not.toHaveBeenCalled();
    // Credentials: no override.
    expect((await req(investigateRoute.POST, { params: { id: cred.entry.id }, json: { financeOverride: true } })).status).toBe(403);
    // Finance heuristic: Send anyway (confirmed) is audited.
    expect((await req(investigateRoute.POST, { params: { id: r.entry.id }, json: { financeOverride: true } })).status).toBe(202);
    expect(recentAudit(100).some((a) => a.action === "ai.finance_override")).toBe(true);
  });

  it("triage suggests a destination, investigate writes a report, accept with suggestion re-points reports and attachments", async () => {
    saveAiSettings({ enabled: true });
    const u = resolveUser(new Headers(), createSession(owner).token)!;
    const home = store.createItem(u, { kind: "area", title: "Home" }, "c");
    (globalThis as { __dest?: string }).__dest = home.id;
    const r = await (await req(captureRoute.POST, { body: multipart({ text: "porch light" }, [{ name: "p.png", type: "image/png", data: PNG }]) })).json();
    expect(r.triage).toBe("queued");
    for (let i = 0; i < 4; i++) {
      await runnerTick();
      await drainRunner();
    }
    const inbox = await (await req(inboxRoute.GET, { method: "GET" })).json();
    const e = inbox.items.find((x: { id: string }) => x.id === r.entry.id);
    expect(e.capture).toMatchObject({ triageState: "done", suggestedTitle: "Fix the porch light", suggestion: { parentId: home.id, title: "Home" } });
    expect(e.capture.report.title).toBe("Porch light notes");
    // Images are not analysed (Hermes image input unverified): the prompt says so.
    const inputs = vi.mocked(HermesExecutionClient.start).mock.calls.map((c) => (c[1] as { input: string }).input);
    expect(inputs.every((i) => i.includes("[image attached 1×1: not analysed]"))).toBe(true);
    const acc = await (await req(acceptRoute.POST, { params: { id: r.entry.id }, json: { parentId: null, useSuggestion: true } })).json();
    expect(acc.item).toMatchObject({ parentId: home.id, title: "Fix the porch light" });
    const rep = getDb().select().from(schema.aiReports).get()!;
    expect(rep).toMatchObject({ subjectType: "work_item", subjectId: acc.item.id, originInboxId: r.entry.id });
    expect(getDb().select().from(schema.captureAttachments).get()!.itemId).toBe(acc.item.id);
    const link = getDb().select().from(schema.workLinks).where(eq(schema.workLinks.itemId, acc.item.id)).all();
    expect(link.some((l) => l.kind === "chat_session" && l.role === "source" && l.lineage === "ai_action")).toBe(true);
  });

  it("a person without work.ai still captures deterministically", async () => {
    saveAiSettings({ enabled: true });
    const adult = createPerson({ name: "Adult", username: "adult2", role: "adult", passcode: "synthetic-pass" }, owner).id;
    const r = await (await req(captureRoute.POST, { json: { text: "buy milk" }, session: adult })).json();
    expect(r).toMatchObject({ triage: "skipped", reason: "ai_not_allowed" });
  });
});
