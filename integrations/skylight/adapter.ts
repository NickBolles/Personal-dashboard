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
import { autoGroupMembers, autoMatchMembers, classifySkylightChore, groupMemberIds, keepAssigned, skylightPrefs, type SkylightMember } from "@/lib/task-source";

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
    prefs: skylightPrefs(r.config),
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

const relOne = z.object({ data: z.object({ id: z.union([z.string(), z.number()]) }).nullish() }).partial();
const resource = z.object({
  id: z.string(),
  type: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()),
  relationships: z.record(z.string(), z.unknown()).optional(),
});
const doc = z.object({ data: z.array(resource) });

export async function listFrames() {
  const r = doc.parse(await api("/frames"));
  return r.data.map((f) => ({
    id: f.id,
    name: String(f.attributes.name ?? f.attributes.household_name ?? f.id),
    timezone: String(f.attributes.timezone ?? ""),
  }));
}

/** Family members ("categories") on the frame: chores' assignees. */
export async function listMembers(frame?: string): Promise<SkylightMember[]> {
  const f = frame ?? (await frameId());
  const r = doc.parse(await api(`/frames/${f}/categories`));
  return r.data.map((c) => ({
    id: c.id,
    name: String(c.attributes.label ?? c.attributes.name ?? c.id),
    linkedToProfile: Boolean(c.attributes.linked_to_profile),
    isGroup: isGroupCategory(c.attributes),
  }));
}

/** Skylight's own household/group marker on a category, when the API exposes one. */
function isGroupCategory(a: Record<string, unknown>): boolean {
  if (a.is_family === true || a.family === true || a.is_group === true || a.group === true || a.household === true) return true;
  const kind = String(a.category_type ?? a.kind ?? a.type ?? "");
  return /\b(family|group|household)\b/i.test(kind);
}

function choreCategory(rel: Record<string, unknown> | undefined): string | null {
  const one = relOne.safeParse(rel?.category);
  if (one.success && one.data.data?.id != null) return String(one.data.data.id);
  const many = z.object({ data: z.array(z.object({ id: z.union([z.string(), z.number()]) })) }).safeParse(rel?.categories);
  return many.success && many.data.data[0] ? String(many.data.data[0].id) : null;
}

/** The owner's member ids: configured, else a unique name match against the Jarvis owner. */
async function ownerMembers(members: SkylightMember[], configured: string[]): Promise<string[]> {
  if (configured.length) return configured;
  try {
    const { getOwner } = await import("@/server/auth");
    const owner = getOwner();
    return owner ? autoMatchMembers(members, { name: owner.name, username: owner.username }) : [];
  } catch {
    return [];
  }
}

async function frameId() {
  const c = cfg();
  if (c.frameId) return c.frameId;
  const frames = await listFrames();
  if (!frames[0]) throw new UpstreamError("Skylight", "not_found", "No Skylight frames on this account");
  return frames[0].id;
}

/* ------------------------------------------------------------------ via Hermes */

const eventTime = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);
const hermesAnswer = z.object({
  events: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        start: eventTime,
        end: eventTime.nullish(),
        allDay: z.boolean().nullish(),
        location: z.string().max(1000).nullish(),
      }),
    )
    .max(500),
  chores: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).nullish(),
        title: z.string().min(1).max(500),
        time: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
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

const shellArg = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function skylightHermesRequest(ctx: AdapterContext) {
  const c = cfg();
  // Calendar days, not elapsed hours: DST must not shift the exclusive date.
  const to = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10);
  return {
    source: "skylight",
    label: "Skylight",
    task: [
      fill(c.prompt, { from: ctx.today, to, timezone: ctx.timezone }),
      "Use only the installed jarvis-skylight-read helper below. Dates are from-inclusive, to-exclusive; chores are for from only.",
      "First load skill_view(name='jarvis-skylight-read') so its declared environment is available. If setup is missing, fail without asking for credentials.",
      `Run: node "\${HERMES_HOME:-$HOME/.hermes}/skills/jarvis-skylight-read/scripts/read.mjs" ${shellArg(ctx.today)} ${shellArg(to)} ${shellArg(ctx.timezone)}`,
      "Return its JSON unchanged. Do not generate or write files, discover authentication, read credentials, or modify calendar/tasks. If missing or unsuccessful, return a short error; do not improvise a fallback.",
    ].join("\n"),
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
        sourceLabel: "Skylight · Chores",
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
    const [eventsDoc, choresDoc, members] = await Promise.all([
      api(`/frames/${frame}/calendar_events`, { date_min: ctx.today, date_max: until, timezone: ctx.timezone }).then((d) => doc.parse(d)),
      api(`/frames/${frame}/chores`, { after: ctx.today, before: ctx.today, include_late: "true" })
        .then((d) => doc.parse(d))
        .catch(() => ({ data: [] as z.infer<typeof resource>[] })),
      // Configured member ids filter without names; auto-matching needs the list, so a failure then
      // fails the sync (keeping the last filtered snapshot) instead of showing everyone's chores.
      listMembers(frame).catch((err) => {
        if (cfg().prefs.members.length) return [] as SkylightMember[];
        throw err;
      }),
    ]);
    const prefs = cfg().prefs;
    const mine = await ownerMembers(members, prefs.members);
    const effective = { ...prefs, members: mine };
    const groups = groupMemberIds(members, prefs);
    let hidden = 0;
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
      .map((c) => ({
        c,
        who: classifySkylightChore({ categoryId: choreCategory(c.relationships), upForGrabs: c.attributes.up_for_grabs === true }, members, mine, groups),
      }))
      .filter(({ who }) => {
        const keep = keepAssigned(who, effective);
        if (!keep) hidden++;
        return keep;
      })
      .map(({ c, who }) => {
        const a = c.attributes;
        const due = a.start_time ? iso(localTimeToInstant(String(a.start ?? ctx.today), String(a.start_time), ctx.timezone)) : undefined;
        return baseAction("skylight", c.id, ctx, STALE, {
          title: `${a.emoji_icon ? `${a.emoji_icon} ` : ""}${String(a.summary ?? "Chore")}`,
          detail: who.kind === "up_for_grabs" ? "Skylight chore · up for grabs" : who.name ? `Skylight chore · ${who.name}` : "Skylight chore",
          status: "open",
          priorityReason: due ? classifyInstant(due, ctx) : "today",
          dueAt: due,
          updatedAt: iso(ctx.now),
          href: "https://app.ourskylight.com/",
          external: true,
          primaryAction: { kind: "open", label: "Open Skylight" },
          sourceLabel: who.kind === "up_for_grabs" ? "Skylight · Up for grabs" : "Skylight · Chores",
          assignee: who.kind === "mine" ? { kind: "mine", name: who.name } : who,
        });
      });
    const counts = {
      mine: actions.filter((x) => x.assignee?.kind === "mine").length,
      upForGrabs: actions.filter((x) => x.assignee?.kind === "up_for_grabs").length,
      others: actions.filter((x) => x.assignee?.kind === "other").length,
      hidden,
    };
    // Unconfigured and no unique name match: Settings asks the owner to pick (extra.needsMember).
    return { actions, events, extra: { via: "direct", counts, needsMember: mine.length === 0 && members.length > 0 } };
  },
  async test() {
    if (cfg().mode === "hermes") {
      return runChecks([
        {
          name: "Hermes connected",
          run: async () => {
            const h = resolveIntegration("hermes");
            if (!h.enabled || !h.config.baseUrl) throw new Error("Enable and connect Hermes first: Skylight is read through Hermes");
            return "Skylight requests go through Hermes";
          },
        },
        {
          name: "Read Skylight via Hermes",
          run: async () => {
            const { adapterContext } = await import("@/server/sources");
            const ctx = adapterContext();
            let answer: HermesAnswer;
            try {
              answer = await runStructured({ ...skylightHermesRequest(ctx), interactive: true });
            } catch (err) {
              if (!(err instanceof UpstreamError) || err.kind !== "bad_response") throw err;
              // The usual cause: the Hermes profile serving Jarvis lacks the reader skill or its Skylight credentials.
              throw new Error(
                `${err.message}. Check that the Hermes profile serving Jarvis has the jarvis-skylight-read skill installed and SKYLIGHT_USERNAME, SKYLIGHT_PASSWORD and SKYLIGHT_FRAME_ID set (docs/operations/skylight-reliability.md), or switch to “Directly” and sign in.`,
              );
            }
            saveSnapshot("skylight", ctx.today, answer);
            const open = answer.chores.filter((c) => !c.completed).length;
            return `${answer.events.length} events this week, ${open} open chores today`;
          },
        },
      ]);
    }
    let frames: { id: string; name: string }[] = [];
    let members: SkylightMember[] = [];
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
        {
          name: "List family members",
          run: async () => {
            members = await listMembers().catch(() => []);
            if (!members.length) return "No members found (all chores shown)";
            // Groups stay a free-text list (several ids allowed), so list names + ids here instead of a single-choice picker.
            const auto = autoGroupMembers(members).map((id) => members.find((m) => m.id === id)?.name);
            return `${members.length} members: pick yours under “Whose tasks to show”. Up-for-grabs groups (auto): ${auto.join(", ") || "none"}. Ids: ${members.map((m) => `${m.name}=${m.id}`).join(", ")}`;
          },
        },
      ],
      () => [
        { field: "frameId", label: "Frame", options: frames.map((f) => ({ value: f.id, label: f.name })) },
        ...(members.length ? [{ field: "members", label: "Whose tasks to show (you)", options: members.map((m) => ({ value: m.id, label: m.name })) }] : []),
      ],
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
