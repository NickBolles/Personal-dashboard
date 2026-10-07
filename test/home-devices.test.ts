/**
 * Home Assistant devices: doors, locks, lights and cameras, with per-person
 * capabilities. Lights switch with readback; cameras are proxied and never cached.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import { listDevices, switchLight } from "@/integrations/home-assistant/devices";
import * as devicesRoute from "@/app/api/home-assistant/devices/route";
import * as lightsRoute from "@/app/api/home-assistant/lights/route";
import * as cameraRoute from "@/app/api/home-assistant/cameras/[entityId]/route";
import * as controlRoute from "@/app/api/home-assistant/control/route";

let server: Server;
let base: string;
let owner: string;
let kid: string;
let tablet: string;
let adultNoDoors: string;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, url: string, userId: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method,
    headers: { "content-type": "application/json", "x-jarvis-csrf": "1", cookie: `jarvis_session=${createSession(userId).token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (handler as Handler)(req, { params: Promise.resolve(params) });
}
const mockState = async () => (await (await fetch(`${base}/__mock/state`)).json()) as { haCalls: { domain: string; service: string }[] };

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  const ha = demoPresets()!.home_assistant!;
  saveIntegration("home_assistant", { enabled: true, config: ha.config, secrets: ha.secrets });
  kid = createPerson({ name: "Ava", username: "ava", role: "kid", passcode: "avasecret1" }, owner).id;
  tablet = createPerson({ name: "Kitchen", username: "kitchen", role: "household", passcode: "4321" }, owner).id;
  adultNoDoors = createPerson({ name: "Guest", username: "guest", role: "adult", passcode: "guestpass1" }, owner).id;
  const { updatePerson } = await import("@/server/people");
  updatePerson(adultNoDoors, { capabilities: { "home_assistant.control_doors": false, "home_assistant.cameras": false } }, owner);
});
afterAll(() => server?.close());

describe("devices", () => {
  it("finds every door, lock, light and camera, with controls per capability", async () => {
    const d = await listDevices({ doors: true, lights: true, cameras: true, doorControls: true, lightControls: true });
    expect(d.lights.map((l) => l.entityId)).toEqual(["light.kitchen", "light.living_room", "light.porch"]);
    expect(d.lights.find((l) => l.entityId === "light.kitchen")).toMatchObject({ state: "on", brightness: 80 });
    expect(d.cameras.map((c) => c.entityId).sort()).toEqual(["camera.driveway", "camera.front_door"]);
    const kinds = Object.fromEntries(d.doors.map((x) => [x.entityId, x.kind]));
    expect(kinds).toMatchObject({ "lock.front_door_lock": "lock", "cover.garage_door": "garage", "binary_sensor.back_door": "door" });
    // Doors keep the safe allowlist (lock, close) only.
    expect(d.doors.find((x) => x.entityId === "lock.front_door_lock")!.services.map((s) => s.service)).toEqual(["lock"]);
    expect(d.doors.find((x) => x.entityId === "binary_sensor.back_door")!.services).toEqual([]);
  });

  it("a kid can't see devices or cameras; the tablet can", async () => {
    expect((await call(devicesRoute.GET, "/api/home-assistant/devices", kid)).status).toBe(403);
    expect(
      (await call(cameraRoute.GET, "/api/home-assistant/cameras/camera.front_door", kid, "GET", undefined, { entityId: "camera.front_door" })).status,
    ).toBe(403);
    const r = await call(devicesRoute.GET, "/api/home-assistant/devices", tablet);
    const body = (await r.json()) as { lights: { services: unknown[] }[]; cameras: unknown[] };
    expect(body.cameras.length).toBe(2);
    expect(body.lights[0]!.services.length).toBe(2);
  });

  it("camera stills are proxied, typed as images and never cached", async () => {
    const r = await call(cameraRoute.GET, "/api/home-assistant/cameras/camera.driveway", tablet, "GET", undefined, { entityId: "camera.driveway" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(10);
    expect(
      (await call(cameraRoute.GET, "/api/home-assistant/cameras/lock.front_door_lock", owner, "GET", undefined, { entityId: "lock.front_door_lock" })).status,
    ).toBe(400);
    // Someone without camera access gets nothing.
    expect(
      (await call(cameraRoute.GET, "/api/home-assistant/cameras/camera.driveway", adultNoDoors, "GET", undefined, { entityId: "camera.driveway" })).status,
    ).toBe(403);
  });
});

describe("lights", () => {
  it("switches a light and reports success only after readback", async () => {
    const r = await switchLight("light.porch", true, owner, "c1", { pollMs: 50 });
    expect(r).toMatchObject({ verified: true, state: "on" });
    expect((await mockState()).haCalls.some((c) => c.domain === "light" && c.service === "turn_on")).toBe(true);
    // Already in that state: no call.
    const before = (await mockState()).haCalls.length;
    expect(await switchLight("light.porch", true, owner, "c2")).toMatchObject({ message: "Already on" });
    expect((await mockState()).haCalls.length).toBe(before);
  });

  it("people without light control get 403; lights can be made view-only", async () => {
    expect((await call(lightsRoute.POST, "/api/home-assistant/lights", kid, "POST", { entityId: "light.porch", on: false })).status).toBe(403);
    const ha = demoPresets()!.home_assistant!;
    saveIntegration("home_assistant", { config: { ...ha.config, lightControl: "none" } });
    await expect(switchLight("light.porch", false, owner, "c3")).rejects.toThrow(/isn't allowed/);
    saveIntegration("home_assistant", { config: { ...ha.config, lightControl: "all" } });
  });

  it("door controls need the door capability even with light control", async () => {
    const r = await call(controlRoute.POST, "/api/home-assistant/control", adultNoDoors, "POST", {
      entityId: "lock.front_door_lock",
      service: "lock",
      stateToken: "abcd1234",
      confirmed: true,
    });
    expect(r.status).toBe(403);
  });
});
