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
import { evaluateException, homeHealth, parseAllowlist } from "@/integrations/home-assistant/adapter";
import { assertShareableContext } from "@/server/privacy";
import { executeControl, listControls } from "@/integrations/home-assistant/controls";
import { track, trackIdempotencyKey } from "@/integrations/paperclip/service";
import { tick } from "@/server/worker";
import { updatePreferences } from "@/server/settings";
import { clearSnapshot, extractJson, parseStructured, saveSnapshot } from "@/integrations/hermes/structured";
import { z } from "zod";

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
  it("default allowlist is the safe direction only: unlock and open are opt-in", async () => {
    await setHa("lock.front_door_lock", "locked");
    await setHa("cover.garage_door_2", "closed");
    const controls = await listControls();
    const lock = controls.find((c) => c.entityId === "lock.front_door_lock")!;
    expect(lock.services.map((s) => s.service)).toEqual(["lock"]);
    expect(controls.flatMap((c) => c.services.map((s) => s.service))).not.toContain("open_cover");
    await expect(executeControl({ entityId: lock.entityId, service: "unlock", stateToken: lock.stateToken, confirmed: true }, userId, "c0")).rejects.toThrow(
      /allowlist/,
    );
  });
  it("health: counts only, and unknown (undefined) rather than 0 when HA can't say", async () => {
    const data = await ADAPTERS.home_assistant.fetch(adapterContext());
    const h = data.extra!.health as ReturnType<typeof homeHealth>;
    expect(h).toMatchObject({ unavailable: 1, updatesPending: 1, integrationsFailing: 1, failingDomains: ["ring"] });
    expect(JSON.stringify(h)).not.toMatch(/sensor\.|lock\.|cover\./);
    const bare = homeHealth([{ entity_id: "light.x", state: "on", attributes: {} }], undefined, new Date());
    expect(bare.updatesPending).toBeUndefined();
    expect(bare.integrationsFailing).toBeUndefined();
  });
  it("privacy: Home Assistant items can't be attached as Hermes context", () => {
    expect(() => assertShareableContext("- Garage door: Open [home_assistant:cover.garage_door@x]")).toThrow(/stays out of Hermes/);
    notify({
      type: "home.exception",
      category: "ha_critical",
      severity: "high",
      title: "Front door lock: Unlocked",
      body: "x",
      source: "home_assistant",
      deepLink: "/home-control",
      dedupeKey: "privacy-test",
    });
    const alertId = listNotifications(userId).find((n) => n.title === "Front door lock: Unlocked")!.id;
    expect(() => assertShareableContext(`- Front door [alert:${alertId}]`)).toThrow(/stays out of Hermes/);
    expect(() => assertShareableContext("- Renew car registration [todos:abc]")).not.toThrow();
    expect(() => assertShareableContext(undefined)).not.toThrow();
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

describe("sources owned by Hermes (structured requests)", () => {
  const hermesSessions = async () => {
    const r = await fetch(`${base}/hermes/api/sessions?limit=200`, { headers: { authorization: "Bearer mock-hermes-key-0123456789" } });
    return ((await r.json()) as { data: { title?: string; source?: string }[] }).data;
  };
  const useSkylightViaHermes = (prompt = "") => {
    saveIntegration("skylight", { config: { mode: "hermes", prompt } });
    clearSnapshot("skylight");
  };
  afterAll(() => saveIntegration("skylight", { config: { mode: "direct", prompt: "" } }));

  it("parses fenced JSON and fails closed on prose, error answers and contract mismatches", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":2} hope that helps')).toEqual({ a: 2 });
    const schema = z.object({ a: z.number() });
    expect(parseStructured("X", '{"a":3}', schema)).toEqual({ a: 3 });
    expect(() => parseStructured("X", "no idea", schema)).toThrow(/did not answer X with JSON/);
    expect(() => parseStructured("X", '{"error":"tool missing"}', schema)).toThrow(/could not complete X: tool missing/);
    expect(() => parseStructured("X", '{"a":"three"}', schema)).toThrow(/didn't match the contract \(a:/);
    expect(() => parseStructured("X", "", schema)).toThrow(/no answer/);
  });

  it("skylight via Hermes: validated answer becomes events and open chores, in a hidden throwaway session", async () => {
    useSkylightViaHermes();
    const ctx = adapterContext();
    const data = await ADAPTERS.skylight.fetch(ctx);
    expect(data.asOf).toBeTruthy();
    expect(data.events!.map((e) => e.title)).toEqual(["Grandma visiting", "Soccer practice"]);
    const soccer = data.events!.find((e) => e.title === "Soccer practice")!;
    // Offset-less times are wall-clock in the user's timezone (America/Chicago).
    expect(new Date(soccer.startsAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })).toBe("5:30 PM");
    expect(data.actions.map((a) => a.title).sort()).toEqual(["Take out recycling", "Water plants"]);
    expect(data.actions.find((a) => a.title === "Take out recycling")!.sourceId).toBe("9002");
    const sessions = await hermesSessions();
    expect(sessions.some((s) => s.source === "jarvis-sync" || s.title?.startsWith("jarvis-sync"))).toBe(false);

    const r = await refreshSource("skylight");
    expect(r.status.state).toBe("ok");
    expect(r.status.fetchedAt).toBe(data.asOf);
  });

  it("skylight via Hermes: serves the last answer labelled stale while it refreshes", async () => {
    useSkylightViaHermes();
    const ctx = adapterContext();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    saveSnapshot("skylight", ctx.today, { events: [], chores: [{ title: "Old chore", completed: false }] }, old);
    const r = await refreshSource("skylight", ctx);
    expect(r.status.state).toBe("stale");
    expect(r.status.fetchedAt).toBe(old);
    expect(r.data!.actions.map((a) => a.title)).toEqual(["Old chore"]);
    await new Promise((res) => setTimeout(res, 800));
    const again = await ADAPTERS.skylight.fetch(adapterContext());
    expect(again.actions.map((a) => a.title)).toContain("Take out recycling");
  });

  it("skylight via Hermes: test connection reports declines, prose and approval requests honestly", async () => {
    useSkylightViaHermes();
    expect((await ADAPTERS.skylight.test()).ok).toBe(true);
    useSkylightViaHermes("Read Skylight FORCE_ERROR");
    expect((await ADAPTERS.skylight.test()).summary).toMatch(/could not complete Skylight: Skylight tool is not available/);
    useSkylightViaHermes("Read Skylight FORCE_PROSE");
    expect((await ADAPTERS.skylight.test()).summary).toMatch(/did not answer Skylight with JSON/);
    useSkylightViaHermes("Read Skylight FORCE_APPROVAL");
    expect((await ADAPTERS.skylight.test()).summary).toMatch(/asked for approval/);
    // A failed first sync is an error, never an empty calendar.
    await expect(ADAPTERS.skylight.fetch(adapterContext())).rejects.toThrow(/approval/);
    // …and Jarvis backs off instead of spending a model run on every refresh.
    const count = async () => ((await (await fetch(`${base}/__mock/state`)).json()) as { hermesStructuredRequests: number }).hermesStructuredRequests;
    const before = await count();
    await expect(ADAPTERS.skylight.fetch(adapterContext())).rejects.toThrow(/approval/);
    expect(await count()).toBe(before);
  });

  it("daily compass via Hermes: completion only counts after Hermes reads it back", async () => {
    saveIntegration("daily_compass", { config: { mode: "hermes" } });
    clearSnapshot("daily_compass");
    try {
      const ctx = adapterContext();
      const before = await ADAPTERS.daily_compass.fetch(ctx);
      expect(before.compass!.completed).toBe(false);
      expect(before.compass!.summary).toBe("Not checked in yet");
      expect((await ADAPTERS.daily_compass.test()).ok).toBe(true);
      await expect(ADAPTERS.daily_compass.act!(ctx.today, "complete", { actor: userId, correlationId: "c1" })).resolves.toMatchObject({ ok: true });
      const after = await ADAPTERS.daily_compass.fetch(adapterContext());
      expect(after.compass!.completed).toBe(true);
      expect(after.actions).toHaveLength(0);
    } finally {
      saveIntegration("daily_compass", { config: { mode: "jarvis" } });
    }
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
