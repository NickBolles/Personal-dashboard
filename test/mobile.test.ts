/**
 * Phone app (native Android) server surface: pairing + bearer auth, FCM push,
 * source context for "Ask Hermes about …", widget summary, layout prefs.
 *
 * Also records the API responses the Android app's contract tests parse
 * (contracts/api/*.json). Committed fixtures are checked for compatibility
 * every run: removing a field or changing its type fails here, so the Kotlin
 * models get updated in the same change. Refresh with UPDATE_API_FIXTURES=1.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import type { IntegrationKind } from "@/integrations/registry";
import { updatePreferences } from "@/server/settings";
import { createPairingCode, redeemPairingCode } from "@/server/devices";
import { notify } from "@/server/notifications";
import { deliverPendingPushes } from "@/server/notifications/push";
import { saveFcmConfig } from "@/server/notifications/fcm";
import { refreshSource } from "@/server/sources";

import * as homeRoute from "@/app/api/home/route";
import * as widgetRoute from "@/app/api/widget/summary/route";
import * as pairingRoute from "@/app/api/devices/pairing/route";
import * as pairRoute from "@/app/api/devices/pair/route";
import * as devicesRoute from "@/app/api/devices/route";
import * as deviceRoute from "@/app/api/devices/[id]/route";
import * as meRoute from "@/app/api/devices/me/route";
import * as notificationsRoute from "@/app/api/notifications/route";
import * as notificationRoute from "@/app/api/notifications/[id]/route";
import * as countRoute from "@/app/api/notifications/count/route";
import * as sessionsRoute from "@/app/api/hermes/sessions/route";
import * as sessionRoute from "@/app/api/hermes/sessions/[id]/route";
import * as runsRoute from "@/app/api/hermes/sessions/[id]/runs/route";
import * as runRoute from "@/app/api/hermes/runs/[runId]/route";
import * as eventsRoute from "@/app/api/hermes/runs/[runId]/events/route";
import * as controlsRoute from "@/app/api/home-assistant/controls/route";
import * as controlRoute from "@/app/api/home-assistant/control/route";
import * as sourceRoute from "@/app/api/sources/[source]/route";
import * as compassRoute from "@/app/api/daily-compass/route";
import * as contextRoute from "@/app/api/context/route";
import * as settingsRoute from "@/app/api/settings/route";
import * as actionsRoute from "@/app/api/actions/route";

let server: Server;
let base: string;
let userId: string;
let cookie: string;
let token: string;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  handler: unknown,
  url: string,
  opts: { method?: string; body?: unknown; auth?: "device" | "cookie" | "none" | string; params?: Record<string, string>; csrf?: boolean } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.auth ?? "device";
  if (auth === "device") headers.authorization = `Bearer ${token}`;
  else if (auth === "cookie") headers.cookie = `jarvis_session=${cookie}`;
  else if (auth !== "none") headers.authorization = `Bearer ${auth}`;
  if (opts.csrf) headers["x-jarvis-csrf"] = "1";
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
}

async function json<T = Record<string, unknown>>(res: Response | Promise<Response>) {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T };
}

/* -------------------------------------------------------------- fixtures */

const FIXTURE_DIR = path.join(process.cwd(), "contracts/api");
const UPDATE = process.env.UPDATE_API_FIXTURES === "1";
const recorded = new Map<string, unknown>();

type Shape = string | { [k: string]: Shape } | Shape[];
function shapeOf(v: unknown): Shape {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [v.map(shapeOf).reduce(mergeShape)] : [];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v;
}
function mergeShape(a: Shape, b: Shape): Shape {
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, Shape> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeShape(out[k]!, v) : v;
    return out;
  }
  return a;
}
/** Fields the committed fixture has that the fresh response lost or changed type of. */
function incompatibilities(committed: Shape, fresh: Shape, at = "$"): string[] {
  if (committed === "null" || fresh === "null") return [];
  if (typeof committed === "string") return typeof fresh === "string" && fresh !== committed ? [`${at}: ${committed} → ${fresh}`] : [];
  if (Array.isArray(committed)) {
    if (!Array.isArray(fresh)) return [`${at}: array → ${JSON.stringify(fresh).slice(0, 20)}`];
    return committed.length && fresh.length ? incompatibilities(committed[0]!, fresh[0]!, `${at}[]`) : [];
  }
  if (typeof fresh !== "object" || Array.isArray(fresh)) return [`${at}: object → ${typeof fresh}`];
  return Object.entries(committed).flatMap(([k, v]) => (k in fresh ? incompatibilities(v, fresh[k]!, `${at}.${k}`) : []));
}

function record(name: string, body: unknown) {
  recorded.set(name, body);
  return body;
}

/* ------------------------------------------------------------------ setup */

async function mock(p: string, body: unknown = {}) {
  return fetch(`${base}/__mock${p}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }).then((r) => r.json());
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  process.env.JARVIS_FCM_BASE_URL = `${base}/fcm`;
  __setTestDatabase();
  userId = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  cookie = createSession(userId).token;
  updatePreferences({ timezone: "America/Chicago" });
  for (const [kind, p] of Object.entries(demoPresets()!)) saveIntegration(kind as IntegrationKind, { enabled: true, config: p!.config, secrets: p!.secrets });
  token = redeemPairingCode(createPairingCode(userId).code, { name: "Pixel test" }).token;
  for (const s of ["todos", "skylight", "home_assistant", "daily_compass", "hermes", "paperclip"] as const) await refreshSource(s);
});

afterAll(() => {
  server?.close();
  // Compatibility check against committed fixtures (or rewrite them).
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const problems: string[] = [];
  for (const [name, body] of recorded) {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    if (UPDATE || !fs.existsSync(file)) {
      fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
      continue;
    }
    const committed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const p of incompatibilities(shapeOf(committed), shapeOf(body))) problems.push(`${name}.json ${p}`);
  }
  if (problems.length) {
    throw new Error(
      `API responses changed shape for the Android app:\n${problems.join("\n")}\nUpdate the Kotlin models, then UPDATE_API_FIXTURES=1 npx vitest run test/mobile.test.ts`,
    );
  }
});

beforeEach(async () => {
  await mock("/reset");
});

/* ------------------------------------------------------------------ tests */

describe("pairing and device auth", () => {
  it("shows a one-time code to a browser session, and the phone exchanges it for a token", async () => {
    const shown = await json<{ code: string; uri: string; qrSvg: string; server: string }>(
      call(pairingRoute.POST, "/api/devices/pairing", { method: "POST", auth: "cookie", csrf: true }),
    );
    expect(shown.status).toBe(200);
    expect(shown.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(shown.body.uri).toBe(`jarvis://pair?server=${encodeURIComponent("http://jarvis.test")}&code=${encodeURIComponent(shown.body.code)}`);
    expect(shown.body.qrSvg).toContain("<svg");
    record("pairing", { ...shown.body, qrSvg: "<svg/>" });

    // Typed by hand: lower case, no dash. No CSRF header needed (public, bearer-less).
    const paired = await json<{ token: string; deviceId: string }>(
      call(pairRoute.POST, "/api/devices/pair", {
        method: "POST",
        auth: "none",
        body: { code: shown.body.code.replace("-", "").toLowerCase(), name: "Galaxy S22", appVersion: "1.0.0" },
      }),
    );
    expect(paired.status).toBe(200);
    expect(paired.body.token).toMatch(/^jdv_/);
    record("pair", { ...paired.body, token: "jdv_redacted" });

    const again = await json(call(pairRoute.POST, "/api/devices/pair", { method: "POST", auth: "none", body: { code: shown.body.code, name: "x" } }));
    expect(again.status).toBe(400);

    const me = await json<{ device: { name: string } }>(call(meRoute.GET, "/api/devices/me", { auth: paired.body.token }));
    expect(me.body.device.name).toBe("Galaxy S22");

    const list = await json<{ devices: { id: string }[] }>(call(devicesRoute.GET, "/api/devices", { auth: "cookie" }));
    expect(list.body.devices.map((d) => d.id)).toContain(paired.body.deviceId);
    record("devices", list.body);

    // Revoke from the web → the phone is signed out.
    const del = await call(deviceRoute.DELETE, `/api/devices/${paired.body.deviceId}`, {
      method: "DELETE",
      auth: "cookie",
      csrf: true,
      params: { id: paired.body.deviceId },
    });
    expect(del.status).toBe(200);
    expect((await call(homeRoute.GET, "/api/home?cached=1", { auth: paired.body.token })).status).toBe(401);
  });

  it("bearer requests skip CSRF, and a bad bearer never falls back to the cookie", async () => {
    const res = await call(actionsRoute.POST, "/api/actions", { method: "POST", body: { actionId: "todos:t-unknown", kind: "pin" } });
    expect(res.status).toBe(200);
    // Same request from a browser without the CSRF header is rejected.
    expect((await call(actionsRoute.POST, "/api/actions", { method: "POST", auth: "cookie", body: { actionId: "todos:x", kind: "pin" } })).status).toBe(403);
    const req = new NextRequest("http://jarvis.test/api/home?cached=1", { headers: { authorization: "Bearer jdv_nope", cookie: `jarvis_session=${cookie}` } });
    expect((await (homeRoute.GET as Handler)(req, { params: Promise.resolve({}) })).status).toBe(401);
  });

  it("phones can't mint pairing codes, and wrong codes are throttled", async () => {
    expect((await call(pairingRoute.POST, "/api/devices/pairing", { method: "POST" })).status).toBe(403);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await call(pairRoute.POST, "/api/devices/pair", { method: "POST", auth: "none", body: { code: "ZZZZ-ZZZZ", name: "x" } })).status;
    }
    expect(last).toBe(429);
  });
});

describe("phone push (FCM)", () => {
  it("sends data messages to registered phones and forgets dead tokens", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    saveFcmConfig({
      googleServices: JSON.stringify({
        project_info: { project_number: "123456789", project_id: "jarvis-test" },
        client: [
          {
            client_info: { mobilesdk_app_id: "1:123456789:android:abc", android_client_info: { package_name: "com.nickbolles.jarvis" } },
            api_key: [{ current_key: "AIzaTest" }],
          },
        ],
      }),
      serviceAccount: JSON.stringify({
        project_id: "jarvis-test",
        client_email: "jarvis@jarvis-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        token_uri: `${base}/fcm/token`,
      }),
    });
    const me = await json<{ push: unknown }>(call(meRoute.GET, "/api/devices/me"));
    expect(me.body.push).toEqual({ projectId: "jarvis-test", senderId: "123456789", applicationId: "1:123456789:android:abc", apiKey: "AIzaTest" });
    record("devices-me", me.body);

    expect((await call(meRoute.PATCH, "/api/devices/me", { method: "PATCH", body: { pushToken: "fcm-token-live-0001" } })).status).toBe(200);
    const dead = redeemPairingCode(createPairingCode(userId).code, { name: "Old phone" }).token;
    await call(meRoute.PATCH, "/api/devices/me", { method: "PATCH", auth: dead, body: { pushToken: "dead-token-0001" } });

    notify({
      type: "home.exception",
      category: "ha_critical",
      severity: "critical",
      title: "House alarm: Alarm triggered",
      body: "Current state: triggered",
      source: "home_assistant",
      deepLink: "/home-control",
      dedupeKey: `fcm-test-${Date.now()}`,
    });
    await deliverPendingPushes();
    const state = (await fetch(`${base}/__mock/state`).then((r) => r.json())) as {
      fcmMessages: { token: string; data: Record<string, string>; android: { priority: string } }[];
    };
    const msg = state.fcmMessages.find((m) => m.token === "fcm-token-live-0001")!;
    expect(msg.data).toMatchObject({
      type: "notification",
      title: "House alarm: Alarm triggered",
      severity: "critical",
      category: "ha_critical",
      url: "/home-control",
    });
    expect(msg.android.priority).toBe("HIGH");
    const devices = await json<{ devices: { name: string; pushEnabled: boolean }[] }>(call(devicesRoute.GET, "/api/devices", { auth: "cookie" }));
    expect(devices.body.devices.find((d) => d.name === "Old phone")!.pushEnabled).toBe(false);
  });
});

describe("ask Hermes about a source", () => {
  it("attaches a server-built snapshot of Skylight and Home Assistant", async () => {
    const preview = await json<{ text: string }>(call(contextRoute.GET, "/api/context?source=home_assistant"));
    expect(preview.body.text).toContain("Controllable entities (live):");
    expect(preview.body.text).toContain("Front door lock (lock.front_door_lock)");
    record("context", preview.body);

    const sky = await json<{ text: string }>(call(contextRoute.GET, "/api/context?source=skylight"));
    expect(sky.body.text).toMatch(/^Skylight — as of/);
    expect(sky.body.text).toContain("Calendar (next 7 days):");

    const created = await json<{ id: string }>(call(sessionsRoute.POST, "/api/hermes/sessions", { method: "POST", body: { title: "Ask about home" } }));
    record("session-created", created.body);
    const sid = created.body.id;
    const run = await json<{ runId: string }>(
      call(runsRoute.POST, `/api/hermes/sessions/${sid}/runs`, {
        method: "POST",
        params: { id: sid },
        body: { input: "Is the garage open?", idempotencyKey: `mobile-${Date.now()}`, contextSources: ["home_assistant", "skylight"] },
      }),
    );
    expect(run.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const all = (await fetch(`${base}/hermes/api/sessions/${sid}/messages`, { headers: { authorization: "Bearer mock-hermes-key-0123456789" } }).then((r) =>
      r.json(),
    )) as {
      data: { role: string; content: string }[];
    };
    const user = all.data.find((m) => m.role === "user")!.content;
    expect(user).toContain("Is the garage open?");
    expect(user).toContain("Context from Jarvis:");
    expect(user).toContain("Home Assistant — as of");
    expect(user).toContain("Skylight — as of");
  });

  it("rejects unknown context sources", async () => {
    expect((await call(contextRoute.GET, "/api/context?source=passwords")).status).toBe(400);
  });
});

describe("widget summary and layout", () => {
  it("summarises what a widget needs from cached data", async () => {
    const r = await json<{ next: unknown[]; home: { critical: number }; unread: number }>(call(widgetRoute.GET, "/api/widget/summary"));
    expect(r.status).toBe(200);
    expect(r.body.next.length).toBeGreaterThan(0);
    expect(r.body.next.length).toBeLessThanOrEqual(5);
    expect(typeof r.body.unread).toBe("number");
    record("widget-summary", r.body);
  });

  it("stores the home layout, keeps every section exactly once, rejects unknown sections", async () => {
    const put = await json<{ layout: { homeSections: { id: string; visible: boolean }[]; dynamicColor: boolean } }>(
      call(settingsRoute.PUT, "/api/settings", {
        method: "PUT",
        body: {
          layout: {
            homeSections: [
              { id: "glance", visible: true },
              { id: "now", visible: true },
              { id: "glance", visible: false },
            ],
            dynamicColor: false,
          },
        },
      }),
    );
    expect(put.status).toBe(200);
    const ids = put.body.layout.homeSections.map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(["glance", "now"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("completed");
    expect(put.body.layout.dynamicColor).toBe(false);
    record("settings", put.body);
    const bad = await call(settingsRoute.PUT, "/api/settings", { method: "PUT", body: { layout: { homeSections: [{ id: "nope", visible: true }] } } });
    expect(bad.status).toBe(400);
  });
});

describe("app screens' existing APIs work with a device token", () => {
  it("records the responses the Android app parses", async () => {
    record("home", (await json(call(homeRoute.GET, "/api/home?cached=1"))).body);
    notify({
      type: "jarvis.test",
      category: "hermes_input",
      severity: "normal",
      title: "Hermes needs you",
      body: "Approve a command",
      source: "hermes",
      deepLink: "/chat/sess_morning",
      dedupeKey: "fixture-1",
    });
    const list = await json<{ notifications: { id: string }[] }>(call(notificationsRoute.GET, "/api/notifications"));
    expect(list.body.notifications.length).toBeGreaterThan(0);
    record("notifications", list.body);
    record("notification-count", (await json(call(countRoute.GET, "/api/notifications/count"))).body);
    const id = list.body.notifications[0]!.id;
    record(
      "notification-transition",
      (await json(call(notificationRoute.PATCH, `/api/notifications/${id}`, { method: "PATCH", params: { id }, body: { transition: "read" } }))).body,
    );

    record("sessions", (await json(call(sessionsRoute.GET, "/api/hermes/sessions"))).body);
    record("session", (await json(call(sessionRoute.GET, "/api/hermes/sessions/sess_morning", { params: { id: "sess_morning" } }))).body);

    const run = await json<{ runId: string }>(
      call(runsRoute.POST, "/api/hermes/sessions/sess_morning/runs", {
        method: "POST",
        params: { id: "sess_morning" },
        body: { input: "search the weather", idempotencyKey: `fixture-run-${Date.now()}`, contextSources: ["overview"] },
      }),
    );
    record("run-started", run.body);
    const sse = await call(eventsRoute.GET, `/api/hermes/runs/${run.body.runId}/events`, { params: { runId: run.body.runId } });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await sse.text();
    expect(text).toContain('"type":"run.terminal"');
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    if (UPDATE || !fs.existsSync(path.join(FIXTURE_DIR, "run-events.sse"))) fs.writeFileSync(path.join(FIXTURE_DIR, "run-events.sse"), text);
    record("run", (await json(call(runRoute.GET, `/api/hermes/runs/${run.body.runId}`, { params: { runId: run.body.runId } }))).body);

    const controls = await json<{ controls: { entityId: string; stateToken: string; services: { service: string }[] }[] }>(
      call(controlsRoute.GET, "/api/home-assistant/controls"),
    );
    record("controls", controls.body);
    const garage = controls.body.controls.find((c) => c.entityId === "cover.garage_door")!;
    const exec = await json(
      call(controlRoute.POST, "/api/home-assistant/control", {
        method: "POST",
        body: { entityId: garage.entityId, service: "close_cover", stateToken: garage.stateToken, confirmed: true },
      }),
    );
    expect(exec.status).toBe(200);
    record("control-result", exec.body);

    for (const s of ["skylight", "todos", "home_assistant", "daily_compass"]) {
      record(`source-${s.replace("_", "-")}`, (await json(call(sourceRoute.GET, `/api/sources/${s}?cached=1`, { params: { source: s } }))).body);
    }
    record("daily-compass", (await json(call(compassRoute.GET, "/api/daily-compass"))).body);
    record("action-result", (await json(call(actionsRoute.POST, "/api/actions", { method: "POST", body: { actionId: "todos:x1", kind: "pin" } }))).body);
  }, 30_000);
});
