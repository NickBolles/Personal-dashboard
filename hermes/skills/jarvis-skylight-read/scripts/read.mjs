#!/usr/bin/env node
/** Dependency-free, read-only Skylight reader. No disk writes or persisted tokens. */
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
const ORIGIN = "https://app.ourskylight.com";
const REDIRECT = "https://ourskylight.com/welcome";
const fail = () => {
  throw new Error("skylight_read_failed");
};
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) fail();
  return +parsed;
}
export function validateWindow(input) {
  const days = (date(input.to) - date(input.from)) / 86400000;
  if (days < 1 || days > 14 || typeof input.timezone !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(input.timezone)) fail();
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  } catch {
    fail();
  }
  return { from: input.from, to: input.to, timezone: input.timezone };
}
function text(v, max = 500) {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail();
  return v;
}
function title(v) {
  return v == null || (typeof v === "string" && !v.trim()) ? "(untitled)" : text(v);
}
function timestamp(v) {
  if (typeof v !== "string") fail();
  date(v.slice(0, 10));
  if (v.length === 10) return v;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/.test(v)) fail();
  return v;
}
function rows(doc, limit) {
  if (!doc || !Array.isArray(doc.data) || doc.data.length > limit || doc.links?.next || doc.meta?.has_more === true) fail();
  return doc.data;
}
function localDay(v, timezone) {
  if (v.length === 10 || !/(Z|[+-]\d\d:\d\d)$/.test(v)) return v.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(v));
  return ["year", "month", "day"].map((k) => parts.find((p) => p.type === k).value).join("-");
}
export function normalize(eventsDoc, choresDoc, input) {
  const { from, to, timezone } = validateWindow(input);
  const events = rows(eventsDoc, 500)
    .map((row) => {
      const a = row.attributes;
      if (!a || typeof a.all_day !== "boolean") fail();
      const start = timestamp(a.starts_at ?? a.start);
      const end = a.ends_at ?? a.end;
      if (end != null) timestamp(end);
      // All-day dates remain calendar dates; timed values preserve explicit offsets/wall time.
      return {
        title: title(a.summary),
        start: a.all_day ? start.slice(0, 10) : start,
        end: end == null ? null : a.all_day ? end.slice(0, 10) : end,
        allDay: a.all_day,
        location: a.location == null || a.location === "" ? null : text(a.location, 1000),
      };
    })
    .filter((e) => {
      const startDay = e.allDay ? e.start : localDay(e.start, timezone);
      const endDay = e.end ? (e.allDay ? e.end : localDay(e.end, timezone)) : startDay;
      return startDay < to && (startDay >= from || (e.allDay ? endDay > from : endDay >= from));
    });
  const chores = rows(choresDoc, 200).flatMap((row) => {
    const a = row.attributes;
    if (!a || !["pending", "complete", "completed", "skipped"].includes(a.status)) fail();
    // Undated chores belong to the task box, not this dated-card contract.
    if (a.start === null) return [];
    date(a.start);
    if (a.start !== from || a.status === "skipped") return [];
    if (a.start_time != null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(a.start_time)) fail();
    if (typeof row.id !== "string" && !Number.isSafeInteger(row.id)) fail();
    return [{ id: text(String(row.id), 128), title: title(a.summary), time: a.start_time ?? null, completed: ["complete", "completed"].includes(a.status) }];
  });
  return { events, chores };
}

/** Authentication POSTs only; data endpoint methods are hard-coded GET.
 * @param {{from: string, to: string, timezone: string}} input
 * @param {{env?: Record<string, string | undefined>, fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>}} options
 */
export async function readSkylight(input, { env = process.env, fetchImpl = fetch } = {}) {
  const window = validateWindow(input);
  const username = env.SKYLIGHT_USERNAME || env.SKYLIGHT_EMAIL;
  const password = env.SKYLIGHT_PASSWORD;
  const frame = env.SKYLIGHT_FRAME_ID;
  if (!username || !password || !frame || !/^\d{1,20}$/.test(frame)) fail();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const cookies = new Map();
  async function request(url, init = {}) {
    const target = new URL(url, ORIGIN);
    if (target.origin !== ORIGIN) fail();
    const r = await fetchImpl(target, { ...init, redirect: "manual", signal: controller.signal });
    let body = "";
    const reader = r.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          fail();
        }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    }
    for (const cookie of r.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const i = pair.indexOf("=");
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: r.status, location: r.headers.get("location"), body };
  }
  const cookieHeaders = () => ({ "User-Agent": "Mozilla/5.0", Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const authorize = new URL(`${ORIGIN}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: "skylight-mobile",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "everything",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  async function follow(url) {
    for (let i = 0; i < 8; i++) {
      const target = new URL(url, ORIGIN);
      if (target.origin === new URL(REDIRECT).origin && target.pathname === "/welcome") {
        if (target.searchParams.get("state") !== state || !target.searchParams.get("code")) fail();
        return { code: target.searchParams.get("code") };
      }
      const r = await request(target, { headers: cookieHeaders() });
      if (r.status >= 300 && r.status < 400 && r.location) {
        url = r.location;
        continue;
      }
      if (r.status !== 200) fail();
      return { html: r.body };
    }
    fail();
  }
  try {
    const page = await follow(authorize);
    const csrf = page.html?.match(/<meta name="csrf-token" content="([^"]+)"/i)?.[1] ?? page.html?.match(/name="authenticity_token" value="([^"]+)"/i)?.[1];
    if (!csrf) fail();
    const login = await request(`${ORIGIN}/auth/session`, {
      method: "POST",
      headers: {
        ...cookieHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/auth/session/new`,
        "X-CSRF-Token": csrf,
      },
      body: new URLSearchParams({ authenticity_token: csrf, email: username, password }),
    });
    if (login.status < 200 || login.status >= 400) fail();
    let result = login.location ? await follow(login.location) : {};
    if (!result.code) result = await follow(authorize);
    if (!result.code) fail();
    const tokenResponse = await request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "skylight-mobile",
        redirect_uri: REDIRECT,
        code: result.code,
        code_verifier: verifier,
        scope: "everything",
        skylight_api_client_device_fingerprint: "hermes-jarvis-reader",
        skylight_api_client_device_platform: "web",
        skylight_api_client_device_name: "hermes",
        skylight_api_client_device_os_version: "linux",
        skylight_api_client_device_app_version: "1",
        skylight_api_client_device_hardware: "container",
        source: "js-mobile",
      }),
    });
    if (tokenResponse.status !== 200) fail();
    const token = JSON.parse(tokenResponse.body).access_token;
    if (typeof token !== "string" || !token) fail();
    async function get(endpoint, query) {
      const r = await request(`${ORIGIN}/api/frames/${frame}/${endpoint}?${new URLSearchParams(query)}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Skylight-Api-Version": "2026-03-01" },
      });
      if (r.status !== 200) fail();
      return JSON.parse(r.body);
    }
    const events = await get("calendar_events", { date_min: window.from, date_max: window.to, timezone: window.timezone });
    const chores = await get("chores", { after: window.from, before: window.from, timezone: window.timezone, include_late: "false" });
    return normalize(events, chores, window);
  } catch {
    fail();
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) fail();
    const [from, to, timezone] = process.argv.slice(2);
    console.log(JSON.stringify(await readSkylight({ from, to, timezone })));
  } catch {
    console.error('{"error":"skylight_read_failed"}');
    process.exitCode = 1;
  }
}
