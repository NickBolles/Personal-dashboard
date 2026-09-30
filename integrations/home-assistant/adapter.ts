import "server-only";
import type { CalendarEvent, HomeException, NextAction } from "@/lib/contracts";
import { iso, MINUTE, DAY } from "@/lib/time";
import { resolveIntegration } from "@/integrations/store";
import { runChecks } from "@/integrations/testing";
import { baseAction } from "@/integrations/actions";
import type { AdapterContext, SourceAdapter } from "@/integrations/types";
import { haConn, HomeAssistantClient, type HaState } from "./client";

const STALE = 5 * MINUTE;

export function parseLines(v: string | undefined) {
  return (v ?? "")
    .split(/[\r\n,]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export type ControlRule = { entityId: string; services: string[] };

/** "lock.front_door: lock, unlock" → { entityId, services } */
export function parseAllowlist(v: string | undefined): ControlRule[] {
  return (v ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [entity, svc] = l.split(":");
      return {
        entityId: entity!.trim(),
        services: (svc ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    })
    .filter((r) => /^[a-z_]+\.[a-z0-9_]+$/.test(r.entityId) && r.services.length);
}

const minutesSince = (t: string | undefined, now: Date) => (t ? (now.getTime() - new Date(t).getTime()) / MINUTE : 0);

/** Only exceptional states surface. Never render "all fine" noise. */
export function evaluateException(s: HaState, now: Date): HomeException | null {
  const [domain] = s.entity_id.split(".");
  const dc = String(s.attributes.device_class ?? "");
  const name = String(s.attributes.friendly_name ?? s.entity_id);
  const since = s.last_changed;
  const mins = minutesSince(since, now);
  const ex = (severity: HomeException["severity"], reason: string): HomeException => ({
    entityId: s.entity_id,
    name,
    state: s.state,
    severity,
    reason,
    since,
  });
  if (s.state === "unavailable" || s.state === "unknown") return ex("info", "Not reporting");
  if (domain === "alarm_control_panel") {
    if (s.state === "triggered") return ex("critical", "Alarm triggered");
    if (s.state === "pending") return ex("high", "Alarm pending");
    return null;
  }
  if (domain === "lock") {
    if (s.state === "jammed") return ex("critical", "Lock jammed");
    if (s.state === "open" || s.state === "opening") return ex("high", "Lock open");
    if (s.state === "unlocked") return ex(mins >= 10 ? "high" : "normal", mins >= 10 ? `Unlocked for ${Math.round(mins)} min` : "Unlocked");
    return null;
  }
  if (domain === "cover") {
    if (s.state === "open" || s.state === "opening") {
      return ex(mins >= 15 ? "high" : "normal", mins >= 15 ? `Open for ${Math.round(mins)} min` : "Open");
    }
    return null;
  }
  if (domain === "binary_sensor") {
    if (s.state !== "on") return null;
    if (["smoke", "gas", "carbon_monoxide", "moisture", "safety"].includes(dc)) return ex("critical", `${dc.replace("_", " ")} detected`);
    if (["problem", "tamper"].includes(dc)) return ex("high", dc === "tamper" ? "Tampering detected" : "Problem reported");
    if (["door", "garage_door", "opening", "window"].includes(dc) || dc === "") {
      return ex(mins >= 30 ? "high" : "normal", mins >= 30 ? `Open for ${Math.round(mins)} min` : "Open");
    }
    return null;
  }
  if (domain === "sensor" && ["problem"].includes(dc) && s.state !== "ok") return ex("normal", s.state);
  return null;
}

const SEVERITY_RANK = { critical: 0, high: 1, normal: 2, info: 3 } as const;

function eventFromHa(e: import("zod").infer<typeof import("./client").haCalendarEventSchema>, calendar: string): CalendarEvent | null {
  const start = e.start.dateTime ?? e.start.date;
  if (!start) return null;
  return {
    id: `ha:${calendar}:${e.uid ?? start}:${e.recurrence_id ?? ""}`,
    title: e.summary ?? "(untitled)",
    startsAt: e.start.dateTime ? new Date(e.start.dateTime).toISOString() : e.start.date!,
    endsAt: e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : e.end?.date,
    allDay: !e.start.dateTime,
    location: e.location ?? undefined,
    calendar,
    source: "home_assistant",
  };
}

export const homeAssistantAdapter: SourceAdapter = {
  source: "home_assistant",
  staleAfterMs: STALE,
  async fetch(ctx: AdapterContext) {
    const conn = haConn();
    const cfg = resolveIntegration("home_assistant").config;
    const watch = new Set(parseLines(cfg.watchEntities));
    const calendars = parseLines(cfg.calendarEntities);
    const states = await HomeAssistantClient.states(conn);
    const exceptions = states
      .filter((s) => watch.has(s.entity_id))
      .map((s) => evaluateException(s, ctx.now))
      .filter((e): e is HomeException => Boolean(e))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const missing = [...watch].filter((id) => !states.some((s) => s.entity_id === id));
    for (const id of missing) {
      exceptions.push({ entityId: id, name: id, state: "missing", severity: "info", reason: "Entity not found in Home Assistant" });
    }
    const actions: NextAction[] = exceptions
      .filter((e) => e.severity === "critical" || e.severity === "high")
      .map((e) =>
        baseAction("home_assistant", `${e.entityId}@${e.since ?? ""}`, ctx, STALE, {
          title: `${e.name}: ${e.reason}`,
          detail: `State: ${e.state}`,
          status: "open",
          priorityReason: "critical",
          updatedAt: e.since ?? iso(ctx.now),
          href: `/home-control?entity=${encodeURIComponent(e.entityId)}`,
          primaryAction: { kind: "open", label: "Review" },
          secondaryActions: ["acknowledge"],
        }),
      );
    const events: CalendarEvent[] = [];
    const start = iso(ctx.now.getTime() - 2 * 60 * MINUTE);
    const end = iso(ctx.now.getTime() + 7 * DAY);
    await Promise.all(
      calendars.map(async (cal) => {
        try {
          const list = await HomeAssistantClient.calendarEvents(conn, cal, start, end);
          for (const e of list) {
            const ev = eventFromHa(e, cal);
            if (ev) events.push(ev);
          }
        } catch {
          /* one calendar failing should not hide home state */
        }
      }),
    );
    return { actions, homeExceptions: exceptions, events };
  },
  async test() {
    let version = "";
    let watchCount = 0;
    let calendars: { entity_id: string; name: string }[] = [];
    return runChecks(
      [
        {
          name: "Reach Home Assistant",
          run: async () => {
            await HomeAssistantClient.ping(haConn());
            const cfg = await HomeAssistantClient.config(haConn()).catch(() => ({ version: undefined }));
            version = cfg.version ?? "";
            return version ? `Home Assistant ${version}` : "API running";
          },
        },
        {
          name: "Read watched entities",
          run: async () => {
            const cfg = resolveIntegration("home_assistant").config;
            const watch = parseLines(cfg.watchEntities);
            const states = await HomeAssistantClient.states(haConn());
            const found = watch.filter((w) => states.some((s) => s.entity_id === w));
            watchCount = found.length;
            const missing = watch.filter((w) => !found.includes(w));
            if (missing.length && !found.length && watch.length) throw new Error(`None of the watched entities exist: ${missing.join(", ")}`);
            return `${watchCount}/${watch.length} watched entities found${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`;
          },
        },
        {
          name: "Check allowed controls",
          run: async () => {
            const rules = parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);
            return rules.length ? `${rules.length} entities allowlisted` : "No controls allowlisted (read-only)";
          },
        },
        {
          name: "List calendars",
          run: async () => {
            const c = haConn();
            calendars = await import("@/server/http/fetch").then(({ upstream }) =>
              upstream<{ entity_id: string; name: string }[]>({
                source: "Home Assistant",
                baseUrl: c.baseUrl,
                path: "/api/calendars",
                headers: c.token ? { authorization: `Bearer ${c.token}` } : {},
              }),
            );
            return `${calendars.length} calendars available`;
          },
        },
      ],
      () => [
        {
          field: "calendarEntities",
          label: "Calendars",
          options: calendars.map((c) => ({ value: c.entity_id, label: c.name })),
        },
      ],
    );
  },
};
