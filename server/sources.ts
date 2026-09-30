import "server-only";
import { eq, inArray } from "drizzle-orm";
import { ACTION_SOURCES, SOURCE_LABELS, type ActionSource, type CalendarEvent, type HomePayload, type NextAction, type SourceStatus } from "@/lib/contracts";
import { iso, localDate, startOfLocalDay, DAY } from "@/lib/time";
import { getDb, schema } from "@/server/db";
import { getPreferences } from "@/server/settings";
import { boundedAll } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { dedupeActions, partitionForHome } from "@/server/ranking";
import { ADAPTERS } from "@/integrations";
import { isConfigured, resolveIntegration } from "@/integrations/store";
import type { AdapterContext, SourceData } from "@/integrations/types";

export const SOURCE_TIMEOUT_MS = Number(process.env.JARVIS_SOURCE_TIMEOUT_MS ?? 6000);

export function adapterContext(now = new Date()): AdapterContext {
  const timezone = getPreferences().timezone;
  const today = localDate(now, timezone);
  const tomorrow = localDate(now.getTime() + DAY, timezone);
  return { now, timezone, today, endOfToday: startOfLocalDay(tomorrow, timezone) };
}

type SourceResult = { status: SourceStatus; data?: SourceData };

function snapshotRow(source: ActionSource) {
  return getDb().select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.source, source)).get();
}

function withTimeout<T>(p: Promise<T>, ms: number, source: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new UpstreamError(source, "timeout", `${source} did not respond in ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function notConfigured(source: ActionSource): SourceResult | undefined {
  const r = resolveIntegration(source);
  if (!r.enabled) {
    return { status: { source, label: SOURCE_LABELS[source], state: rowExists(source) ? "disabled" : "unconfigured" } };
  }
  if (!isConfigured(source)) return { status: { source, label: SOURCE_LABELS[source], state: "unconfigured" } };
  return undefined;
}

function rowExists(source: ActionSource) {
  return Boolean(getDb().select({ k: schema.integrations.kind }).from(schema.integrations).where(eq(schema.integrations.kind, source)).get());
}

export function cachedSource(source: ActionSource, now = new Date()): SourceResult {
  const nc = notConfigured(source);
  if (nc) return nc;
  const row = snapshotRow(source);
  if (!row) return { status: { source, label: SOURCE_LABELS[source], state: "refreshing" } };
  const data = row.payload ? (JSON.parse(row.payload) as SourceData) : undefined;
  const stale = row.staleAfter ? new Date(row.staleAfter) < now : true;
  const state = row.state === "ok" ? (stale ? "stale" : "ok") : (row.state as SourceStatus["state"]);
  return {
    status: {
      source,
      label: SOURCE_LABELS[source],
      state,
      fetchedAt: row.fetchedAt ?? undefined,
      staleAfter: row.staleAfter ?? undefined,
      error: row.error ?? undefined,
      fromCache: true,
    },
    data,
  };
}

/** Fetch one source live; on failure fall back to the last-known snapshot with an honest state. */
export async function refreshSource(source: ActionSource, ctx = adapterContext()): Promise<SourceResult> {
  const nc = notConfigured(source);
  if (nc) return nc;
  const adapter = ADAPTERS[source];
  const now = new Date().toISOString();
  try {
    const data = await withTimeout(adapter.fetch(ctx), SOURCE_TIMEOUT_MS, SOURCE_LABELS[source]);
    // Cached upstream answers (e.g. via Hermes) carry their own read time; freshness follows it.
    const fetchedAt = data.asOf ?? now;
    const staleAfter = data.staleAfter ?? iso(new Date(fetchedAt).getTime() + adapter.staleAfterMs);
    if (data.asOf) data.actions = data.actions.map((a) => ({ ...a, fetchedAt, staleAfter }));
    const values = {
      source,
      state: "ok",
      fetchedAt,
      staleAfter,
      error: null,
      payload: JSON.stringify(data),
      consecutiveFailures: 0,
      firstFailureAt: null,
      updatedAt: now,
    };
    getDb().insert(schema.sourceSnapshots).values(values).onConflictDoUpdate({ target: schema.sourceSnapshots.source, set: values }).run();
    const state = new Date(staleAfter) < ctx.now ? "stale" : "ok";
    return { status: { source, label: SOURCE_LABELS[source], state, fetchedAt, staleAfter }, data };
  } catch (err) {
    const unauthorized = err instanceof UpstreamError && err.kind === "unauthorized";
    const message = err instanceof UpstreamError ? err.message : `Unexpected error: ${(err as Error).message}`;
    if (!(err instanceof UpstreamError)) console.error(`[jarvis] ${source} adapter error`, err);
    const prev = snapshotRow(source);
    const values = {
      source,
      state: unauthorized ? "unauthorized" : "error",
      fetchedAt: prev?.fetchedAt ?? null,
      staleAfter: prev?.staleAfter ?? null,
      error: message,
      payload: prev?.payload ?? null,
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      firstFailureAt: prev?.firstFailureAt ?? now,
      updatedAt: now,
    };
    getDb().insert(schema.sourceSnapshots).values(values).onConflictDoUpdate({ target: schema.sourceSnapshots.source, set: values }).run();
    return {
      status: {
        source,
        label: SOURCE_LABELS[source],
        state: values.state as SourceStatus["state"],
        fetchedAt: values.fetchedAt ?? undefined,
        staleAfter: values.staleAfter ?? undefined,
        error: message,
        fromCache: Boolean(prev?.payload),
      },
      data: prev?.payload ? (JSON.parse(prev.payload) as SourceData) : undefined,
    };
  }
}

export function failureInfo(source: ActionSource) {
  const row = snapshotRow(source);
  return row ? { consecutiveFailures: row.consecutiveFailures, firstFailureAt: row.firstFailureAt, state: row.state, error: row.error } : undefined;
}

function applyPrefs(actions: NextAction[], now: Date) {
  if (!actions.length) return actions;
  const prefs = getDb()
    .select()
    .from(schema.actionPrefs)
    .where(
      inArray(
        schema.actionPrefs.actionId,
        actions.map((a) => a.id),
      ),
    )
    .all();
  const map = new Map(prefs.map((p) => [p.actionId, p]));
  return actions
    .filter((a) => {
      const p = map.get(a.id);
      return !(p?.hiddenUntil && new Date(p.hiddenUntil) > now);
    })
    .map((a) => (map.get(a.id)?.pinned ? { ...a, pinned: true } : a));
}

export function nextEvent(events: CalendarEvent[], ctx: AdapterContext): CalendarEvent | undefined {
  return events
    .filter((e) => (e.allDay ? e.startsAt >= ctx.today : new Date(e.endsAt ?? e.startsAt) >= ctx.now))
    .sort((a, b) => {
      const as = a.allDay ? startOfLocalDay(a.startsAt, ctx.timezone).getTime() : new Date(a.startsAt).getTime();
      const bs = b.allDay ? startOfLocalDay(b.startsAt, ctx.timezone).getTime() : new Date(b.startsAt).getTime();
      return as - bs;
    })[0];
}

export async function collectSources(opts: { live: boolean; sources?: ActionSource[] } = { live: true }) {
  const ctx = adapterContext();
  const list = opts.sources ?? ACTION_SOURCES;
  const results = opts.live
    ? (
        await boundedAll(
          list.map((s) => () => refreshSource(s, ctx)),
          4,
        )
      ).map((r, i) => (r.status === "fulfilled" ? r.value : cachedSource(list[i]!)))
    : list.map((s) => cachedSource(s, ctx.now));
  return { ctx, results };
}

export async function getHome(opts: { live: boolean }): Promise<HomePayload> {
  const { ctx, results } = await collectSources(opts);
  const all = results.flatMap((r) => r.data?.actions ?? []);
  const actions = dedupeActions(applyPrefs(all, ctx.now));
  const parts = partitionForHome(actions, ctx.now);
  const byKey = Object.fromEntries(results.map((r) => [r.status.source, r])) as Record<ActionSource, SourceResult>;
  const events = [...(byKey.skylight?.data?.events ?? []), ...(byKey.home_assistant?.data?.events ?? [])];
  const compass = byKey.daily_compass?.data?.compass;
  return {
    generatedAt: iso(ctx.now),
    now: parts.now,
    later: {
      laterToday: parts.laterToday,
      upcoming: parts.upcoming.slice(0, 15),
      waitingOn: parts.waitingOn,
      recentlyCompleted: parts.recentlyCompleted,
    },
    glance: {
      nextEvent: nextEvent(events, ctx),
      compass: compass
        ? { date: compass.date, completed: compass.completed, inWindow: compass.inWindow, windowLabel: `${compass.windowStart}–${compass.windowEnd}` }
        : undefined,
      homeExceptions: (byKey.home_assistant?.data?.homeExceptions ?? []).filter((e) => e.severity !== "info" || e.state === "unavailable"),
    },
    sources: results.map((r) => r.status),
  };
}

export function setActionPref(actionId: string, patch: { pinned?: boolean; hiddenUntil?: string | null }) {
  getDb()
    .insert(schema.actionPrefs)
    .values({ actionId, pinned: patch.pinned ?? false, hiddenUntil: patch.hiddenUntil ?? null })
    .onConflictDoUpdate({
      target: schema.actionPrefs.actionId,
      set: { ...patch, updatedAt: new Date().toISOString() },
    })
    .run();
}
