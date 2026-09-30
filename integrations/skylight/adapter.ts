import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { joinUrl, upstream } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { iso, localDate, MINUTE, DAY, localTimeToInstant } from "@/lib/time";
import type { CalendarEvent, NextAction } from "@/lib/contracts";
import { resolveIntegration, saveIntegration } from "@/integrations/store";
import { processSingleton } from "@/server/singleton";
import { runChecks } from "@/integrations/testing";
import { SKYLIGHT_DEFAULT_PROMPT } from "@/integrations/registry";
import { baseAction, classifyInstant } from "@/integrations/actions";
import { cachedStructured, runStructured, saveSnapshot } from "@/integrations/hermes/structured";
import type { AdapterContext, SourceAdapter, SourceData } from "@/integrations/types";

/**
 * Skylight has no official API. Two modes:
 * - "hermes" (default): Skylight is Hermes-owned. Jarvis sends a structured,
 *   read-only request and caches the validated answer (integrations/hermes/structured.ts).
 * - "direct": community-client contracts (go-skylight, skycli, pyskylight) —
 *   see docs/research/integrations-api.md.
 * Read-only in both: chore completion exists upstream but is not verified.
 */
const STALE = 15 * MINUTE;
const CLIENT_ID = "skylight-mobile";
const REDIRECT_URI = "https://ourskylight.com/welcome";

function cfg() {
  const r = resolveIntegration("skylight");
  return {
    mode: (r.config.mode || "hermes") as "hermes" | "direct",
    prompt: r.config.prompt || SKYLIGHT_DEFAULT_PROMPT,
    syncMs: Math.max(5, Number(r.config.syncMinutes) || 30) * MINUTE,
    baseUrl: r.config.baseUrl || "https://app.ourskylight.com",
    apiVersion: r.config.apiVersion || "2026-06-01",
    frameId: r.config.frameId,
    fingerprint: r.config.deviceFingerprint,
    refreshToken: r.secrets.refreshToken,
  };
}

const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().default(3600) });

type TokenState = { access?: { token: string; expiresAt: number; forRefresh: string }; refreshing?: Promise<string> };
const tokens = processSingleton<TokenState>("skylight_tokens", () => ({}));

async function tokenRequest(form: Record<string, string>) {
  const c = cfg();
  let res: Response;
  try {
    res = await fetch(joinUrl(c.baseUrl, "oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new UpstreamError("Skylight", "unreachable", `Could not reach Skylight (${(err as Error).message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 || res.status === 401)
    throw new UpstreamError("Skylight", "unauthorized", "Skylight rejected the refresh token — sign in again", res.status);
  if (!res.ok) throw new UpstreamError("Skylight", "bad_response", `Skylight token endpoint returned ${res.status}`, res.status);
  return tokenSchema.parse(body);
}

/** Refresh tokens rotate on every use: serialize refreshes and persist the new token immediately. */
async function accessToken(): Promise<string> {
  const c = cfg();
  if (!c.refreshToken) throw new UpstreamError("Skylight", "unauthorized", "Sign in to Skylight first");
  const a = tokens.access;
  if (a && a.forRefresh === c.refreshToken && a.expiresAt > Date.now() + 60_000) return a.token;
  tokens.refreshing ??= (async () => {
    try {
      return await refreshWith(cfg().refreshToken);
    } catch (err) {
      // Another refresh may have rotated the token between our read and the request: retry once with the latest.
      const latest = cfg().refreshToken;
      if (err instanceof UpstreamError && err.kind === "unauthorized" && latest && latest !== c.refreshToken) return refreshWith(latest);
      throw err;
    } finally {
      tokens.refreshing = undefined;
    }
  })();
  return tokens.refreshing;
}

async function refreshWith(refreshToken: string) {
  const c = cfg();
  const t = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...(c.fingerprint ? { skylight_api_client_device_fingerprint: c.fingerprint } : {}),
  });
  const nextRefresh = t.refresh_token ?? refreshToken;
  if (t.refresh_token) saveIntegration("skylight", { secrets: { refreshToken: t.refresh_token } });
  tokens.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, forRefresh: nextRefresh };
  return t.access_token;
}

async function api<T>(path: string, query?: Record<string, string>) {
  const c = cfg();
  const token = await accessToken();
  return upstream<T>({
    source: "Skylight",
    baseUrl: c.baseUrl,
    path: `/api${path}`,
    query,
    headers: { authorization: `Bearer ${token}`, "skylight-api-version": c.apiVersion },
    timeoutMs: 10_000,
  });
}

const resource = z.object({ id: z.string(), type: z.string().optional(), attributes: z.record(z.string(), z.unknown()) });
const doc = z.object({ data: z.array(resource) });

export async function listFrames() {
  const r = doc.parse(await api("/frames"));
  return r.data.map((f) => ({
    id: f.id,
    name: String(f.attributes.name ?? f.attributes.household_name ?? f.id),
    timezone: String(f.attributes.timezone ?? ""),
  }));
}

async function frameId() {
  const c = cfg();
  if (c.frameId) return c.frameId;
  const frames = await listFrames();
  if (!frames[0]) throw new UpstreamError("Skylight", "not_found", "No Skylight frames on this account");
  return frames[0].id;
}

/* ------------------------------------------------------------------ via Hermes */

const hermesAnswer = z.object({
  events: z
    .array(
      z.object({
        title: z.string(),
        start: z.string().min(10),
        end: z.string().nullish(),
        allDay: z.boolean().nullish(),
        location: z.string().nullish(),
      }),
    )
    .max(500),
  chores: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).nullish(),
        title: z.string(),
        time: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .nullish(),
        completed: z.boolean(),
      }),
    )
    .max(200),
});
type HermesAnswer = z.infer<typeof hermesAnswer>;

const EXAMPLE: HermesAnswer = {
  events: [
    { title: "Soccer practice", start: "2026-10-01T17:30:00-05:00", end: "2026-10-01T18:30:00-05:00", allDay: false, location: "Field 3" },
    { title: "School holiday", start: "2026-10-02", allDay: true },
  ],
  chores: [{ id: "123", title: "Feed the dog", time: "07:30", completed: false }],
};

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function skylightHermesRequest(ctx: AdapterContext) {
  const c = cfg();
  const to = localDate(ctx.now.getTime() + 7 * DAY, ctx.timezone);
  return {
    source: "skylight",
    label: "Skylight",
    task: fill(c.prompt, { from: ctx.today, to, timezone: ctx.timezone }),
    schema: hermesAnswer,
    example: EXAMPLE,
  };
}

/** Event times without an offset are wall-clock times in the user's timezone. */
function toInstant(v: string, ctx: AdapterContext) {
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  const d = m ? localTimeToInstant(m[1]!, m[2]!, ctx.timezone) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function mapHermesAnswer(answer: HermesAnswer, ctx: AdapterContext): SourceData {
  const events: CalendarEvent[] = answer.events
    .map((e, i) => {
      const allDay = Boolean(e.allDay) || /^\d{4}-\d{2}-\d{2}$/.test(e.start);
      const startsAt = allDay ? e.start.slice(0, 10) : toInstant(e.start, ctx);
      if (!startsAt) return null;
      return {
        id: `skylight:h${crypto.createHash("sha1").update(`${e.title}|${e.start}|${i}`).digest("hex").slice(0, 12)}`,
        title: e.title || "(untitled)",
        startsAt,
        endsAt: e.end ? (allDay ? e.end.slice(0, 10) : toInstant(e.end, ctx)) : undefined,
        allDay,
        location: e.location ?? undefined,
        source: "skylight" as const,
        href: "https://app.ourskylight.com/",
      };
    })
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const actions: NextAction[] = answer.chores
    .filter((c) => !c.completed)
    .map((c) => {
      const id = c.id != null ? String(c.id) : `h${crypto.createHash("sha1").update(c.title).digest("hex").slice(0, 12)}`;
      const due = c.time ? iso(localTimeToInstant(ctx.today, c.time, ctx.timezone)) : undefined;
      return baseAction("skylight", id, ctx, STALE, {
        title: c.title,
        detail: "Skylight chore",
        status: "open",
        priorityReason: due ? classifyInstant(due, ctx) : "today",
        dueAt: due,
        updatedAt: iso(ctx.now),
        href: "https://app.ourskylight.com/",
        external: true,
        primaryAction: { kind: "open", label: "Open Skylight" },
      });
    });
  return { actions, events, extra: { via: "hermes" } };
}

async function fetchViaHermes(ctx: AdapterContext): Promise<SourceData> {
  const c = cfg();
  const snap = await cachedStructured({
    source: "skylight",
    label: "Skylight",
    // A new day needs a new answer: chores and "today" move.
    key: ctx.today,
    maxAgeMs: c.syncMs,
    load: () => runStructured(skylightHermesRequest(ctx)),
  });
  return {
    ...mapHermesAnswer(snap.data, ctx),
    asOf: snap.asOf,
    // Tolerate one missed sync before calling it stale.
    staleAfter: iso(new Date(snap.asOf).getTime() + 2 * c.syncMs),
  };
}

export const skylightAdapter: SourceAdapter = {
  source: "skylight",
  staleAfterMs: STALE,
  async fetch(ctx: AdapterContext) {
    if (cfg().mode === "hermes") return fetchViaHermes(ctx);
    const frame = await frameId();
    const until = localDate(ctx.now.getTime() + 7 * DAY, ctx.timezone);
    const [eventsDoc, choresDoc] = await Promise.all([
      api(`/frames/${frame}/calendar_events`, { date_min: ctx.today, date_max: until, timezone: ctx.timezone }).then((d) => doc.parse(d)),
      api(`/frames/${frame}/chores`, { after: ctx.today, before: ctx.today, include_late: "true" })
        .then((d) => doc.parse(d))
        .catch(() => ({ data: [] })),
    ]);
    const events: CalendarEvent[] = eventsDoc.data
      .map((e) => {
        const a = e.attributes;
        const startsAt = String(a.starts_at ?? "");
        if (!startsAt) return null;
        return {
          id: `skylight:${e.id}`,
          title: String(a.summary ?? "(untitled)"),
          startsAt: a.all_day ? startsAt.slice(0, 10) : new Date(startsAt).toISOString(),
          endsAt: a.ends_at ? String(a.ends_at) : undefined,
          allDay: Boolean(a.all_day),
          location: a.location ? String(a.location) : undefined,
          source: "skylight" as const,
          href: "https://app.ourskylight.com/",
        };
      })
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const actions: NextAction[] = choresDoc.data
      .filter((c) => c.attributes.status !== "complete" && c.attributes.status !== "skipped")
      .map((c) => {
        const a = c.attributes;
        const due = a.start_time ? iso(localTimeToInstant(String(a.start ?? ctx.today), String(a.start_time), ctx.timezone)) : undefined;
        return baseAction("skylight", c.id, ctx, STALE, {
          title: `${a.emoji_icon ? `${a.emoji_icon} ` : ""}${String(a.summary ?? "Chore")}`,
          detail: "Skylight chore",
          status: "open",
          priorityReason: due ? classifyInstant(due, ctx) : "today",
          dueAt: due,
          updatedAt: iso(ctx.now),
          href: "https://app.ourskylight.com/",
          external: true,
          primaryAction: { kind: "open", label: "Open Skylight" },
        });
      });
    return { actions, events };
  },
  async test() {
    if (cfg().mode === "hermes") {
      return runChecks([
        {
          name: "Hermes connected",
          run: async () => {
            if (!resolveIntegration("hermes").config.baseUrl) throw new Error("Connect Hermes first: Skylight is read through Hermes");
            return "Skylight requests go through Hermes";
          },
        },
        {
          name: "Read Skylight via Hermes",
          run: async () => {
            const { adapterContext } = await import("@/server/sources");
            const ctx = adapterContext();
            const answer = await runStructured(skylightHermesRequest(ctx));
            saveSnapshot("skylight", ctx.today, answer);
            const open = answer.chores.filter((c) => !c.completed).length;
            return `${answer.events.length} events this week, ${open} open chores today`;
          },
        },
      ]);
    }
    let frames: { id: string; name: string }[] = [];
    return runChecks(
      [
        {
          name: "Refresh Skylight session",
          run: async () => {
            await accessToken();
            return "Token refreshed (new refresh token stored)";
          },
        },
        {
          name: "List frames",
          run: async () => {
            frames = await listFrames();
            return frames.map((f) => f.name).join(", ") || "No frames";
          },
        },
        {
          name: "Read calendar",
          run: async () => {
            const frame = await frameId();
            const today = new Date().toISOString().slice(0, 10);
            const r = doc.parse(await api(`/frames/${frame}/calendar_events`, { date_min: today, date_max: today }));
            return `${r.data.length} events today`;
          },
        },
      ],
      () => [{ field: "frameId", label: "Frame", options: frames.map((f) => ({ value: f.id, label: f.name })) }],
    );
  },
};

/**
 * Best-effort one-time sign-in: web login form → OAuth code → tokens. Email
 * and password are used once and never stored. 2FA/device verification makes
 * this fail; then paste a refresh token from `skycli auth login` instead.
 */
export async function skylightSignIn(email: string, password: string) {
  const c = cfg();
  const fingerprint = c.fingerprint || crypto.randomUUID();
  const jar = new Map<string, string>();
  const ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36";
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      jar.set(k!.trim(), v.join("="));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const base = c.baseUrl;
  const fail = (msg: string) => new UpstreamError("Skylight", "unauthorized", msg);

  const form = await fetch(joinUrl(base, "auth/session/new"), { headers: { "user-agent": ua }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  store(form);
  const html = await form.text();
  const authenticity = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1];
  if (!authenticity) throw fail("Could not load the Skylight login form");

  const login = await fetch(joinUrl(base, "auth/session"), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": ua,
      cookie: cookie(),
      origin: base,
      referer: joinUrl(base, "auth/session/new").toString(),
    },
    body: new URLSearchParams({ authenticity_token: authenticity, email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  store(login);
  if ((login.headers.get("location") ?? "").includes("/auth/session/new")) {
    throw fail("Skylight rejected the sign-in (wrong password, or 2FA/device verification required)");
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = joinUrl(base, "oauth/authorize");
  for (const [k, v] of Object.entries({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "everything",
    skylight_api_client_device_fingerprint: fingerprint,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(k, v);
  const auth = await fetch(authorize, { redirect: "manual", headers: { cookie: cookie(), "user-agent": ua }, signal: AbortSignal.timeout(10_000) });
  const code = new URL(auth.headers.get("location") ?? "http://x/").searchParams.get("code");
  if (!code) throw fail("Skylight did not return an authorization code");

  const t = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "everything",
    skylight_api_client_device_fingerprint: fingerprint,
    code_verifier: verifier,
  });
  if (!t.refresh_token) throw fail("Skylight did not return a refresh token");
  saveIntegration("skylight", {
    enabled: true,
    config: { deviceFingerprint: fingerprint },
    secrets: { refreshToken: t.refresh_token },
  });
  tokens.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, forRefresh: t.refresh_token };
}
