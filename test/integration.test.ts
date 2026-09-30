import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { decrypt, encrypt, hashPasscode, verifyPasscode } from "@/server/crypto";
import { claimInstance, createSession, userFromSessionToken, verifyLogin, AuthError } from "@/server/auth";
import { checkCsrf } from "@/server/http/api";
import { listNotifications, notify, transition, unreadActionableCount } from "@/server/notifications";
import { saveIntegration, resolveIntegration, publicIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import type { IntegrationKind } from "@/integrations/registry";
import { ADAPTERS } from "@/integrations";
import { adapterContext, getHome, refreshSource } from "@/server/sources";
import { evaluateException, parseAllowlist } from "@/integrations/home-assistant/adapter";
import { executeControl, listControls } from "@/integrations/home-assistant/controls";
import { track, trackIdempotencyKey } from "@/integrations/paperclip/service";
import { tick } from "@/server/worker";
import { updatePreferences } from "@/server/settings";

let server: Server;
let base: string;
let userId: string;

async function mock(p: string, body: unknown = {}) {
  await fetch(`${base}/__mock${p}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
async function setHa(entity_id: string, state: string, agoMin = 0) {
  await fetch(`${base}/ha/__mock/ha/set`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer mock-ha-long-lived-token" },
    body: JSON.stringify({ entity_id, state, agoMin }),
  });
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  __setTestDatabase();
  userId = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago" });
  for (const [kind, p] of Object.entries(demoPresets()!)) saveIntegration(kind as IntegrationKind, { enabled: true, config: p!.config, secrets: p!.secrets });
});

afterAll(() => server?.close());
beforeEach(() => mock("/reset"));

describe("crypto + auth", () => {
  it("encrypts secrets and hashes passcodes", () => {
    const c = encrypt("hello");
    expect(c).not.toContain("hello");
    expect(decrypt(c)).toBe("hello");
    const h = hashPasscode("pw123456");
    expect(verifyPasscode("pw123456", h)).toBe(true);
    expect(verifyPasscode("nope", h)).toBe(false);
  });
  it("cannot be claimed twice; sessions resolve to the owner", () => {
    expect(() => claimInstance({ setupCode: "TESTCODE", name: "x", passcode: "secret123" })).toThrow(AuthError);
    const s = createSession(userId);
    expect(userFromSessionToken(s.token)?.id).toBe(userId);
    expect(userFromSessionToken("bogus")).toBeNull();
    expect(() => verifyLogin("wrong", "t1")).toThrow(/Incorrect/);
    expect(verifyLogin("secret123", "t1").id).toBe(userId);
  });
  it("integration secrets are never stored in plaintext and never exposed publicly", () => {
    const row = getDb().select().from(schema.integrations).where(eq(schema.integrations.kind, "hermes")).get()!;
    expect(row.secrets).not.toContain("mock-hermes-key");
    expect(resolveIntegration("hermes").secrets.apiKey).toBe("mock-hermes-key-0123456789");
    expect(JSON.stringify(publicIntegration("hermes"))).not.toContain("mock-hermes-key");
    expect(publicIntegration("hermes").secrets.apiKey).toEqual({ set: true, fromEnv: false });
  });
});

describe("CSRF", () => {
  const req = (headers: Record<string, string>, method = "POST") => new NextRequest("http://jarvis.local/api/x", { method, headers });
  it("requires the custom header and a same-origin Origin for mutations", () => {
    expect(() => checkCsrf(req({}))).toThrow(/CSRF/);
    expect(() => checkCsrf(req({ "x-jarvis-csrf": "1", origin: "https://evil.example", host: "jarvis.local" }))).toThrow(/Cross-origin/);
    expect(() => checkCsrf(req({ "x-jarvis-csrf": "1", origin: "http://jarvis.local", host: "jarvis.local" }))).not.toThrow();
    expect(() => checkCsrf(req({}, "GET"))).not.toThrow();
  });
});

describe("notifications", () => {
  it("dedupes by key, escalates, and keeps read/dismissed/acted distinct", () => {
    const a = notify({
      type: "t",
      category: "ha_critical",
      severity: "normal",
      title: "Door open",
      body: "x",
      source: "home_assistant",
      deepLink: "/home-control",
      dedupeKey: "door:1",
    })!;
    const b = notify({
      type: "t",
      category: "ha_critical",
      severity: "normal",
      title: "Door open",
      body: "x",
      source: "home_assistant",
      deepLink: "/home-control",
      dedupeKey: "door:1",
    })!;
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    transition(userId, a.id, "read");
    const before = unreadActionableCount(userId);
    notify({
      type: "t",
      category: "ha_critical",
      severity: "critical",
      title: "Door open 30m",
      body: "x",
      source: "home_assistant",
      deepLink: "/",
      dedupeKey: "door:1",
    });
    expect(unreadActionableCount(userId)).toBe(before + 1); // escalation resurfaces it
    const n = listNotifications(userId).find((x) => x.id === a.id)!;
    expect(n).toMatchObject({ severity: "critical", occurrences: 3 });
    transition(userId, a.id, "acted");
    transition(userId, a.id, "dismiss");
    const all = listNotifications(userId, "all").find((x) => x.id === a.id)!;
    expect(all.readAt && all.actedAt && all.dismissedAt).toBeTruthy();
    expect(listNotifications(userId, "inbox").some((x) => x.id === a.id)).toBe(false);
  });
});

describe("home assistant", () => {
  it("only exceptional states surface", () => {
    const now = new Date();
    const s = (entity_id: string, state: string, attrs: Record<string, unknown> = {}, ago = 0) => ({
      entity_id,
      state,
      attributes: attrs,
      last_changed: new Date(now.getTime() - ago * 60000).toISOString(),
    });
    expect(evaluateException(s("lock.front", "locked"), now)).toBeNull();
    expect(evaluateException(s("lock.front", "unlocked", {}, 20), now)?.severity).toBe("high");
    expect(evaluateException(s("alarm_control_panel.a", "triggered"), now)?.severity).toBe("critical");
    expect(evaluateException(s("binary_sensor.leak", "on", { device_class: "moisture" }), now)?.severity).toBe("critical");
    expect(evaluateException(s("cover.garage", "open", {}, 5), now)?.severity).toBe("normal");
    expect(evaluateException(s("cover.garage", "closed"), now)).toBeNull();
    expect(evaluateException(s("sensor.x", "unavailable"), now)?.severity).toBe("info");
  });
  it("parses the allowlist strictly", () => {
    expect(parseAllowlist("lock.front_door: lock, unlock\n# comment\nbad line\ncover.g: close_cover")).toEqual([
      { entityId: "lock.front_door", services: ["lock", "unlock"] },
      { entityId: "cover.g", services: ["close_cover"] },
    ]);
  });
  it("controls: rejects non-allowlisted, rejects stale state, confirms by readback", async () => {
    await setHa("cover.garage_door", "open", 20);
    const controls = await listControls();
    const garage = controls.find((c) => c.entityId === "cover.garage_door")!;
    await expect(executeControl({ entityId: "switch.x", service: "turn_on", stateToken: "x", confirmed: true }, userId, "c1")).rejects.toThrow(/allowlist/);
    await setHa("cover.garage_door", "closed");
    await expect(
      executeControl({ entityId: garage.entityId, service: "close_cover", stateToken: garage.stateToken, confirmed: true }, userId, "c2"),
    ).rejects.toThrow(/State changed/);
    await setHa("cover.garage_door", "open");
    const fresh = (await listControls()).find((c) => c.entityId === "cover.garage_door")!;
    const res = await executeControl({ entityId: fresh.entityId, service: "close_cover", stateToken: fresh.stateToken, confirmed: true }, userId, "c3", {
      pollMs: 100,
    });
    expect(res).toMatchObject({ verified: true, state: "closed" });
  });
});

describe("adapters against the mock upstreams", () => {
  it("todos: Google Tasks lists, classifies, and completes with readback", async () => {
    const data = await ADAPTERS.todos.fetch(adapterContext());
    const overdue = data.actions.find((a) => a.title === "Renew car registration")!;
    expect(overdue.priorityReason).toBe("overdue");
    expect(data.actions.find((a) => a.title === "Sort garage shelves")!.priorityReason).toBe("upcoming");
    await expect(ADAPTERS.todos.act!(overdue.sourceId, "complete", { actor: userId, correlationId: "x" })).resolves.toMatchObject({ ok: true });
    const after = await ADAPTERS.todos.fetch(adapterContext());
    expect(after.actions.find((a) => a.sourceId === overdue.sourceId)!.status).toBe("completed");
  });

  it("skylight: rotating refresh tokens are persisted", async () => {
    const before = resolveIntegration("skylight").secrets.refreshToken;
    const r = await ADAPTERS.skylight.test();
    expect(r.ok).toBe(true);
    expect(resolveIntegration("skylight").secrets.refreshToken).not.toBe(before);
    const data = await ADAPTERS.skylight.fetch(adapterContext());
    expect(data.events!.length).toBeGreaterThan(0);
  });

  it("paperclip: tracking the same initiative from two conversations creates it once", async () => {
    const a = await track({ mode: "create", sessionId: "s1", title: "Enable v6" }, userId, "t1");
    const b = await track({ mode: "create", sessionId: "s2", title: "enable v6 " }, userId, "t2");
    expect(b.issue.id).toBe(a.issue.id);
    expect(a.created).toBe(true);
    expect(b.deduplicated).toBe(true);
    expect(trackIdempotencyKey({ title: "Enable v6" })).toBe(trackIdempotencyKey({ title: " enable V6" }));
  });

  it("home composition survives a failing source and reports it honestly", async () => {
    await refreshSource("todos");
    await mock("/fail", { services: ["todos"] });
    const home = await getHome({ live: true });
    const todos = home.sources.find((s) => s.source === "todos")!;
    expect(todos.state).toBe("error");
    expect(todos.fromCache).toBe(true);
    expect(home.now.length).toBeLessThanOrEqual(3);
    expect(home.sources.find((s) => s.source === "hermes")!.state).toBe("ok");
    await mock("/fail", { restore: ["todos"] });
  });
});

describe("worker", () => {
  it("raises a sustained-failure alert after the threshold and a critical home alert", async () => {
    updatePreferences({ integrationFailureAlertMinutes: 5 });
    await mock("/fail", { services: ["paperclip"] });
    await setHa("alarm_control_panel.wausau_alarm", "triggered");
    await tick();
    getDb()
      .update(schema.sourceSnapshots)
      .set({ firstFailureAt: new Date(Date.now() - 10 * 60000).toISOString() })
      .where(eq(schema.sourceSnapshots.source, "paperclip"))
      .run();
    await tick();
    const titles = listNotifications(userId).map((n) => n.title);
    expect(titles).toContain("Paperclip is failing");
    expect(titles.some((t) => t.startsWith("House alarm"))).toBe(true);
    await mock("/fail", { restore: ["paperclip"] });
  });
});

describe("backup drill", () => {
  it("backs up a file database and verifies the copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bk-"));
    const holder = __setTestDatabase(path.join(dir, "jarvis.db"));
    void holder;
    const out = execFileSync(process.execPath, ["scripts/backup.mjs", "--out", path.join(dir, "out")], {
      env: { ...process.env, JARVIS_DATA_DIR: dir, JARVIS_DB_PATH: path.join(dir, "jarvis.db") },
      encoding: "utf8",
    });
    expect(out).toMatch(/Backup written/);
    __setTestDatabase();
  });
});
