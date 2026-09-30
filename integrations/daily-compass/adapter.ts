import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { upstream } from "@/server/http/fetch";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { inWindow, iso, localMinutes, localTimeToInstant, MINUTE } from "@/lib/time";
import { resolveIntegration } from "@/integrations/store";
import { COMPASS_COMPLETE_PROMPT, COMPASS_STATUS_PROMPT } from "@/integrations/registry";
import { cachedStructured, refreshSnapshot, runStructured, saveSnapshot } from "@/integrations/hermes/structured";
import { runChecks } from "@/integrations/testing";
import { baseAction } from "@/integrations/actions";
import type { AdapterContext, CompassState, SourceAdapter } from "@/integrations/types";
import type { NextAction } from "@/lib/contracts";

const STALE = 10 * MINUTE;

const remoteSchema = z.object({
  date: z.string(),
  completed: z.boolean(),
  completedAt: z.string().nullish(),
  url: z.string().nullish(),
});

/** Hermes-owned Daily Compass: the structured answer Jarvis requires. */
const hermesSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completed: z.boolean(),
  completedAt: z.string().nullish(),
  summary: z.string().max(500).nullish(),
});
type HermesCompass = z.infer<typeof hermesSchema>;
const HERMES_EXAMPLE: HermesCompass = { date: "2026-10-01", completed: false, completedAt: null, summary: "optional one-line status" };

function cfg() {
  const r = resolveIntegration("daily_compass");
  return {
    mode: (r.config.mode || "hermes") as "hermes" | "jarvis" | "http",
    syncMs: Math.max(5, Number(r.config.syncMinutes) || 15) * MINUTE,
    statusPrompt: r.config.statusPrompt || COMPASS_STATUS_PROMPT,
    completePrompt: r.config.completePrompt || COMPASS_COMPLETE_PROMPT,
    windowStart: r.config.windowStart || "19:00",
    windowEnd: r.config.windowEnd || "22:00",
    reminderTime: r.config.reminderTime || "20:00",
    prompt: r.config.prompt,
    url: r.config.url,
    token: r.secrets.token,
  };
}

function remote<T>(path: string, method = "GET") {
  const c = cfg();
  if (!c.url) throw new UpstreamError("Daily Compass", "unsupported", "Daily Compass endpoint URL is not set");
  return upstream<T>({
    source: "Daily Compass",
    baseUrl: c.url,
    path,
    method,
    headers: c.token ? { authorization: `Bearer ${c.token}` } : {},
  });
}

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Ask Hermes about `date`; the answer must be about that date or it is rejected. */
async function askHermes(kind: "status" | "complete", date: string, timezone: string): Promise<HermesCompass> {
  const c = cfg();
  const answer = await runStructured({
    source: kind === "status" ? "daily_compass" : "daily_compass_complete",
    label: "Daily Compass",
    task: fill(kind === "status" ? c.statusPrompt : c.completePrompt, { date, timezone }),
    schema: hermesSchema,
    example: HERMES_EXAMPLE,
  });
  if (answer.date !== date) {
    throw new UpstreamError("Daily Compass", "bad_response", `Hermes answered for ${answer.date}, not ${date}`);
  }
  return answer;
}

function localState(date: string) {
  return getDb().select().from(schema.compassEntries).where(eq(schema.compassEntries.date, date)).get();
}

export async function compassState(ctx: AdapterContext): Promise<CompassState> {
  const c = cfg();
  const within = inWindow(localMinutes(ctx.now, ctx.timezone), c.windowStart, c.windowEnd);
  if (c.mode === "hermes") {
    const snap = await cachedStructured({
      source: "daily_compass",
      label: "Daily Compass",
      key: ctx.today,
      maxAgeMs: c.syncMs,
      load: () => askHermes("status", ctx.today, ctx.timezone),
    });
    return {
      date: ctx.today,
      completed: snap.data.completed,
      completedAt: snap.data.completedAt ?? undefined,
      summary: snap.data.summary ?? undefined,
      sessionId: localState(ctx.today)?.sessionId ?? undefined,
      inWindow: within,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      asOf: snap.asOf,
    };
  }
  if (c.mode === "http") {
    const r = remoteSchema.parse(await remote("/today"));
    return {
      date: r.date,
      completed: r.completed,
      completedAt: r.completedAt ?? undefined,
      inWindow: within,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      url: r.url ?? undefined,
    };
  }
  const row = localState(ctx.today);
  return {
    date: ctx.today,
    completed: Boolean(row?.completedAt),
    completedAt: row?.completedAt ?? undefined,
    sessionId: row?.sessionId ?? undefined,
    inWindow: within,
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
  };
}

export function compassSessionId(date: string) {
  return localState(date)?.sessionId ?? undefined;
}

export function compassPrompt() {
  return cfg().prompt;
}

export function recordCompassSession(date: string, sessionId: string) {
  getDb().insert(schema.compassEntries).values({ date, sessionId }).onConflictDoUpdate({ target: schema.compassEntries.date, set: { sessionId } }).run();
}

export async function completeCompass(date: string, actor: string, correlationId: string) {
  const c = cfg();
  if (c.mode === "http") {
    const r = remoteSchema.parse(await remote("/today/complete", "POST"));
    if (!r.completed) throw new UpstreamError("Daily Compass", "bad_response", "Daily Compass did not confirm completion");
  } else if (c.mode === "hermes") {
    const { getPreferences } = await import("@/server/settings");
    const answer = await askHermes("complete", date, getPreferences().timezone);
    // Readback is part of the contract: only an answer saying "completed" counts.
    if (!answer.completed) throw new UpstreamError("Daily Compass", "bad_response", "Hermes did not confirm the check-in as complete");
    saveSnapshot("daily_compass", date, answer);
  } else {
    const now = new Date().toISOString();
    getDb()
      .insert(schema.compassEntries)
      .values({ date, completedAt: now })
      .onConflictDoUpdate({ target: schema.compassEntries.date, set: { completedAt: now } })
      .run();
  }
  audit({ actor, action: "daily_compass.complete", source: "daily_compass", sourceRecord: date, result: "ok", correlationId });
}

export function reminderInstant(ctx: AdapterContext) {
  return localTimeToInstant(ctx.today, cfg().reminderTime, ctx.timezone);
}

export const dailyCompassAdapter: SourceAdapter = {
  source: "daily_compass",
  staleAfterMs: STALE,
  async fetch(ctx) {
    const state = await compassState(ctx);
    const { asOf } = state;
    const actions: NextAction[] = [];
    if (!state.completed) {
      const start = localTimeToInstant(ctx.today, state.windowStart, ctx.timezone);
      const end = localTimeToInstant(ctx.today, state.windowEnd, ctx.timezone);
      const afterWindow = !state.inWindow && ctx.now > end && end > start;
      if (!afterWindow) {
        actions.push(
          baseAction("daily_compass", state.date, ctx, STALE, {
            title: "Daily Compass check-in",
            detail: state.inWindow ? `Window open until ${state.windowEnd}` : `Opens at ${state.windowStart}`,
            status: "open",
            priorityReason: state.inWindow ? "checkin_window" : "today",
            availableAt: state.inWindow ? undefined : iso(start),
            dueAt: iso(end),
            updatedAt: iso(ctx.now),
            href: "/daily-compass",
            primaryAction: { kind: "open", label: state.sessionId ? "Continue" : "Start" },
            secondaryActions: ["complete"],
          }),
        );
      }
    }
    if (!asOf) return { actions, compass: state };
    const syncMs = cfg().syncMs;
    return { actions, compass: state, asOf, staleAfter: iso(new Date(asOf).getTime() + 2 * syncMs) };
  },
  async act(sourceId, kind, opts) {
    if (kind !== "complete") throw new HttpError(400, "unsupported", "Unsupported action");
    await completeCompass(sourceId, opts.actor, opts.correlationId);
    return { ok: true, message: "Check-in complete" };
  },
  async test() {
    const c = cfg();
    if (c.mode === "hermes") {
      return runChecks([
        { name: "Check-in window", run: async () => `${c.windowStart}–${c.windowEnd}, reminder at ${c.reminderTime}` },
        {
          name: "Hermes connected",
          run: async () => {
            if (!resolveIntegration("hermes").config.baseUrl) throw new Error("Connect Hermes first: Daily Compass is read through Hermes");
            return "Daily Compass requests go through Hermes";
          },
        },
        {
          name: "Read today's state via Hermes",
          run: async () => {
            const { adapterContext } = await import("@/server/sources");
            const ctx = adapterContext();
            const s = await refreshSnapshot("daily_compass", ctx.today, () => askHermes("status", ctx.today, ctx.timezone));
            return `${s.data.date}: ${s.data.completed ? "completed" : "not yet completed"}`;
          },
        },
      ]);
    }
    if (c.mode === "jarvis") {
      return runChecks([
        { name: "Check-in window", run: async () => `${c.windowStart}–${c.windowEnd}, reminder at ${c.reminderTime}` },
        {
          name: "Hermes available for check-ins",
          run: async () => {
            const h = resolveIntegration("hermes");
            if (!h.config.baseUrl) throw new Error("Connect Hermes to run check-ins as conversations");
            return "Check-ins start a Hermes conversation";
          },
        },
      ]);
    }
    return runChecks([
      {
        name: "Read today's state",
        run: async () => {
          const r = remoteSchema.parse(await remote("/today"));
          return `${r.date}: ${r.completed ? "completed" : "not yet completed"}`;
        },
      },
    ]);
  },
};
