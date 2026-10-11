import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { applyConfiguration, previewConfiguration, type Configuration } from "@/server/config-transfer";
import { resolveIntegration, saveIntegration } from "@/integrations/store";
import { hermesConn } from "@/integrations/hermes/client";
import { haConn } from "@/integrations/home-assistant/client";
import { hermesAdapter } from "@/integrations/hermes/adapter";
import { homeAssistantAdapter } from "@/integrations/home-assistant/adapter";
import { skylightAdapter } from "@/integrations/skylight/adapter";
import { dailyCompassAdapter, completeCompass } from "@/integrations/daily-compass/adapter";
import { todosAdapter } from "@/integrations/todos/adapter";
import { cameraSnapshot, listDevices, switchLight } from "@/integrations/home-assistant/devices";
import type { AdapterContext } from "@/integrations/types";
import { NextRequest } from "next/server";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { POST as connectionTest } from "@/app/api/integrations/[kind]/test/route";
import { GET as devicesGet } from "@/app/api/home-assistant/devices/route";

const ctx: AdapterContext = { now: new Date("2026-10-10T12:00:00Z"), today: "2026-10-10", timezone: "UTC", endOfToday: new Date("2026-10-11T00:00:00Z") };
const imported: Configuration = {
  version: 1,
  integrations: [
    { kind: "hermes", config: { baseUrl: "https://imported.invalid", sessionSource: "jarvis" }, secrets: { apiKey: "imported-fixture" } },
    { kind: "home_assistant", config: { baseUrl: "https://imported-ha.invalid", watchEntities: "# none" }, secrets: { token: "imported-ha-fixture" } },
  ],
};
beforeEach(() => {
  __setTestDatabase();
  for (const key of ["HERMES_BASE_URL", "HERMES_API_KEY", "HA_BASE_URL", "HA_TOKEN"]) vi.stubEnv(key, "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected upstream request")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function importDisabled() {
  applyConfiguration(imported, true, previewConfiguration(imported, true).revision);
}

describe("preview consent binding", () => {
  it.each(["url", "secret", "kind", "mode"])("rejects changed %s with no writes", (change) => {
    const revision = previewConfiguration(imported, false).revision;
    const changed = structuredClone(imported);
    if (change === "url") changed.integrations[0].config.baseUrl = "https://changed.invalid";
    if (change === "secret") changed.integrations[0].secrets.apiKey = "different-fixture";
    if (change === "kind") changed.integrations.pop();
    expect(() => applyConfiguration(changed, change === "mode", revision)).toThrow(/changed/);
    expect(getDb().select().from(schema.integrations).all()).toEqual([]);
  });
  it("canonicalizes record keys and integration ordering without weakening value binding", () => {
    const reordered: Configuration = {
      version: 1,
      integrations: [...imported.integrations].reverse().map((e) => ({ ...e, config: Object.fromEntries(Object.entries(e.config).reverse()) })),
    };
    const revision = previewConfiguration(imported, true).revision;
    expect(previewConfiguration(reordered, true).revision).toBe(revision);
    expect(applyConfiguration(reordered, true, revision)).toEqual({ applied: 2, preserved: 0 });
  });
  it("rejects destination changes and does not disclose imported values", () => {
    const preview = previewConfiguration(imported, true);
    expect(JSON.stringify(preview)).not.toMatch(/imported\.invalid|imported-fixture/);
    saveIntegration("hermes", { config: { baseUrl: "https://existing.invalid" } });
    expect(() => applyConfiguration(imported, true, preview.revision)).toThrow(/changed/);
    expect(resolveIntegration("hermes").enabled).toBe(true);
  });
});

describe("disabled upstream boundaries", () => {
  it("blocks imported URLs even when environment secrets override imported secrets", () => {
    vi.stubEnv("HERMES_API_KEY", "environment-fixture");
    vi.stubEnv("HA_TOKEN", "environment-ha-fixture");
    importDisabled();
    expect(() => hermesConn()).toThrow(/disabled/i);
    expect(() => haConn()).toThrow(/disabled/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves enabled stored and environment-only connection rules", () => {
    vi.stubEnv("HERMES_BASE_URL", "https://environment.invalid");
    vi.stubEnv("HERMES_API_KEY", "environment-fixture");
    expect(hermesConn()).toEqual({ baseUrl: "https://environment.invalid", apiKey: "environment-fixture" });
    saveIntegration("hermes", { enabled: true, config: { baseUrl: "https://stored.invalid" }, secrets: { apiKey: "stored-fixture" } });
    expect(hermesConn()).toEqual({ baseUrl: "https://environment.invalid", apiKey: "environment-fixture" });
    vi.stubEnv("HERMES_BASE_URL", "");
    vi.stubEnv("HERMES_API_KEY", "");
    expect(hermesConn()).toEqual({ baseUrl: "https://stored.invalid", apiKey: "stored-fixture" });
    saveIntegration("home_assistant", { enabled: true, config: { baseUrl: "https://ha.invalid" }, secrets: { token: "ha-fixture" } });
    expect(haConn()).toEqual({ baseUrl: "https://ha.invalid", token: "ha-fixture" });
  });
  it("preserved enabled Skylight and Compass cannot start automatic Hermes runs", async () => {
    saveIntegration("skylight", { enabled: true, config: { mode: "hermes" } });
    saveIntegration("daily_compass", { enabled: true, config: { mode: "hermes" } });
    importDisabled();
    await expect(skylightAdapter.fetch(ctx)).rejects.toThrow(/disabled/i);
    await expect(dailyCompassAdapter.fetch(ctx)).rejects.toThrow(/disabled/i);
    await expect(completeCompass(ctx.today, "fixture", "fixture")).rejects.toThrow(/disabled/i);
    expect(resolveIntegration("skylight").enabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks HA devices, camera, light writes and preserved enabled HA todos", async () => {
    saveIntegration("todos", { enabled: true, config: { provider: "home_assistant", haEntityId: "todo.fixture" } });
    importDisabled();
    await expect(listDevices({ doors: true, lights: true, cameras: true, doorControls: true, lightControls: true })).rejects.toThrow(/disabled/i);
    await expect(cameraSnapshot("camera.fixture")).rejects.toThrow(/disabled/i);
    await expect(switchLight("light.fixture", true, "fixture", "fixture")).rejects.toThrow(/disabled/i);
    await expect(todosAdapter.fetch(ctx)).rejects.toThrow(/disabled/i);
    await expect(todosAdapter.act!("fixture", "complete", { actor: "fixture", correlationId: "fixture" })).rejects.toThrow(/disabled/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("dependent connection tests cannot bypass a disabled dependency", async () => {
    saveIntegration("skylight", { enabled: true, config: { mode: "hermes" } });
    saveIntegration("daily_compass", { enabled: true, config: { mode: "hermes" } });
    saveIntegration("todos", { enabled: true, config: { provider: "home_assistant", haEntityId: "todo.fixture" } });
    importDisabled();
    for (const adapter of [skylightAdapter, dailyCompassAdapter, todosAdapter]) {
      expect((await adapter.test()).ok).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the connection-test exception admin/CSRF-only and blocks the ordinary devices route", async () => {
    const owner = claimInstance({ setupCode: "TESTCODE", name: "Fixture", passcode: "fixture-passcode" });
    const admin = createSession(owner).token;
    const adult = createSession(createPerson({ name: "Adult", username: "adult", role: "adult", passcode: "fixture-adult" }, owner).id).token;
    importDisabled();
    const request = (token?: string, csrf = true) =>
      new NextRequest("http://jarvis.test/api/integrations/hermes/test", {
        method: "POST",
        headers: { origin: "http://jarvis.test", ...(token ? { cookie: `jarvis_session=${token}` } : {}), ...(csrf ? { "x-jarvis-csrf": "1" } : {}) },
      });
    for (const [req, status] of [
      [request(), 401],
      [request(adult), 403],
      [request(admin, false), 403],
    ] as const) {
      expect((await connectionTest(req, { params: Promise.resolve({ kind: "hermes" }) })).status).toBe(status);
    }
    const devices = await devicesGet(new NextRequest("http://jarvis.test/api/home-assistant/devices", { headers: { cookie: `jarvis_session=${admin}` } }), {
      params: Promise.resolve({}),
    });
    expect(devices.status).not.toBe(200);
    expect((await devices.json()).error).toMatch(/disabled/i);
    expect(fetch).not.toHaveBeenCalled();
    // An authorized explicit test may attempt the saved endpoint, but never enables it.
    expect((await connectionTest(request(admin), { params: Promise.resolve({ kind: "hermes" }) })).status).toBe(200);
    expect(fetch).toHaveBeenCalled();
    expect(resolveIntegration("hermes").enabled).toBe(false);
  });
  it.each(["hermes", "home_assistant"] as const)("permits only the explicit own-connection test for disabled %s without enabling it", async (kind) => {
    importDisabled();
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const data =
        path === "/health"
          ? { status: "ok" }
          : path === "/v1/capabilities"
            ? { features: { run_submission: true, run_events_sse: true, run_stop: true, session_fork: true } }
            : path === "/api/sessions"
              ? { data: [], total: 0 }
              : path === "/api/states" || path === "/api/calendars"
                ? []
                : {};
      return Response.json(data);
    });
    const result = await (kind === "hermes" ? hermesAdapter : homeAssistantAdapter).test();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fetch).toHaveBeenCalled();
    expect(resolveIntegration(kind).enabled).toBe(false);
    expect(() => (kind === "hermes" ? hermesConn() : haConn())).toThrow(/disabled/i);
  });
});
