import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { upstream } from "@/server/http/fetch";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { inWindow, iso, localMinutes, localTimeToInstant, MINUTE } from "@/lib/time";
import { resolveIntegration } from "@/integrations/store";
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

function cfg() {
  const r = resolveIntegration("daily_compass");
  return {
    mode: (r.config.mode || "jarvis") as "jarvis" | "http",
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

export async function compassState(ctx: AdapterContext): Promise<CompassState> {
  const c = cfg();
  const within = inWindow(localMinutes(ctx.now, ctx.timezone), c.windowStart, c.windowEnd);
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
  const row = getDb().select().from(schema.compassEntries).where(eq(schema.compassEntries.date, ctx.today)).get();
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
    return { actions, compass: state };
  },
  async act(sourceId, kind, opts) {
    if (kind !== "complete") throw new HttpError(400, "unsupported", "Unsupported action");
    await completeCompass(sourceId, opts.actor, opts.correlationId);
    return { ok: true, message: "Check-in complete" };
  },
  async test() {
    const c = cfg();
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
