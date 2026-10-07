#!/usr/bin/env node
// Mock upstreams for Jarvis: one HTTP server, one path prefix per service.
//   /hermes/*   Hermes API Server       /paperclip/*   Paperclip
//   /ha/*       Home Assistant          /skylight/*    Skylight
//   /google/*   Google OAuth + Tasks    /compass/*     Daily Compass HTTP
//   /fcm/*      Firebase OAuth + FCM v1 (phone push)
//   /monarch/*  Monarch Money GraphQL (finance balances)
//   /anthropic/* Anthropic Messages API (Claude-direct conversations)
//   /__mock/*   control plane (reset, fail, speed)
import http from "node:http";
import { createHermes } from "./hermes.mjs";
import { createPaperclip } from "./paperclip.mjs";
import { createHomeAssistant } from "./home-assistant.mjs";
import { createSkylight } from "./skylight.mjs";
import { createGoogleTasks } from "./google-tasks.mjs";
import { createFcm } from "./fcm.mjs";
import { createMonarch } from "./monarch.mjs";
import { createAnthropic } from "./anthropic.mjs";
import { json, readBody, bearerOk, isoDate } from "./util.mjs";

export const MOCK_CREDENTIALS = {
  hermesKey: "mock-hermes-key-0123456789",
  paperclipKey: "pcp_board_mock000000000000000000000000000000000000000000",
  haToken: "mock-ha-long-lived-token",
  skylightRefresh: "sk_rt_initial_mock",
  googleClientId: "mock-client.apps.googleusercontent.com",
  googleClientSecret: "mock-client-secret",
  googleRefresh: "1//mock-refresh-token",
  compassToken: "mock-compass-token",
  monarchToken: "mock-monarch-session-token",
  anthropicKey: "mock-anthropic-key",
};

export function startMockServer({ port = Number(process.env.MOCK_PORT ?? 4010), host = process.env.MOCK_HOST ?? "127.0.0.1" } = {}) {
  const c = MOCK_CREDENTIALS;
  const control = { fail: new Set(), speed: Number(process.env.MOCK_SPEED ?? 120), physicalDelayMs: 300 };
  const services = {
    hermes: createHermes({ apiKey: c.hermesKey }),
    paperclip: createPaperclip({ apiKey: c.paperclipKey }),
    ha: createHomeAssistant({ token: c.haToken }),
    skylight: createSkylight({ refreshToken: c.skylightRefresh }),
    google: createGoogleTasks({ clientId: c.googleClientId, clientSecret: c.googleClientSecret, refreshToken: c.googleRefresh }),
    fcm: createFcm(),
    monarch: createMonarch({ token: c.monarchToken }),
    anthropic: createAnthropic({ apiKey: c.anthropicKey }),
  };
  const compass = { completed: new Map() };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const [, prefix, ...rest] = url.pathname.split("/");
    const path = "/" + rest.join("/");
    try {
      if (prefix === "__mock") {
        if (path === "/reset") {
          for (const s of Object.values(services)) s.reset();
          compass.completed.clear();
          control.fail.clear();
          return json(res, 200, { ok: true });
        }
        if (path === "/fail") {
          const body = await readBody(req);
          for (const s of [].concat(body.services ?? [])) control.fail.add(s);
          for (const s of [].concat(body.restore ?? [])) control.fail.delete(s);
          return json(res, 200, { failing: [...control.fail] });
        }
        if (path === "/speed") {
          const body = await readBody(req);
          control.speed = Number(body.ms ?? control.speed);
          return json(res, 200, { speed: control.speed });
        }
        if (path === "/state")
          return json(res, 200, {
            haCalls: services.ha.state.calls,
            hermesStructuredRequests: services.hermes.state.structuredCount,
            fcmMessages: services.fcm.state.messages,
            monarchRefreshes: services.monarch.state.refreshes,
            anthropicRequests: services.anthropic.state.requests,
            failing: [...control.fail],
          });
        if (path === "/health") return json(res, 200, { ok: true });
      }
      if (prefix === "hermes") return await services.hermes.handle(req, res, path, url, control);
      if (prefix === "paperclip") return await services.paperclip.handle(req, res, path, url, control);
      if (prefix === "ha") {
        if (path.startsWith("/__mock")) return await services.ha.handle(req, res, path, url, control);
        return await services.ha.handle(req, res, path, url, control);
      }
      if (prefix === "skylight") return await services.skylight.handle(req, res, path, url, control);
      if (prefix === "google") return await services.google.handle(req, res, path, url, control);
      if (prefix === "fcm") return await services.fcm.handle(req, res, path, url, control);
      if (prefix === "monarch") return await services.monarch.handle(req, res, path, url, control);
      if (prefix === "anthropic") return await services.anthropic.handle(req, res, path, url, control);
      if (prefix === "compass") {
        if (control.fail.has("daily_compass")) return json(res, 503, { error: "unavailable" });
        if (!bearerOk(req, c.compassToken)) return json(res, 401, { error: "unauthorized" });
        const date = isoDate(new Date());
        if (path === "/today" && req.method === "GET") {
          return json(res, 200, {
            date,
            completed: compass.completed.has(date),
            completedAt: compass.completed.get(date) ?? null,
            url: "https://compass.example.com/today",
          });
        }
        if (path === "/today/complete" && req.method === "POST") {
          compass.completed.set(date, new Date().toISOString());
          return json(res, 200, { date, completed: true, completedAt: compass.completed.get(date) });
        }
      }
      json(res, 404, { error: `mock route not found: ${url.pathname}` });
    } catch (err) {
      console.error("[mock] error", err);
      if (!res.headersSent) json(res, 500, { error: String(err) });
    }
  });
  server.listen(port, host, () => console.log(`[mock-upstreams] listening on http://${host}:${port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startMockServer();
