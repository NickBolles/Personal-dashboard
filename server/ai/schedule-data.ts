import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getPreferences } from "@/server/settings";
import type { ScheduleSlot } from "@/lib/ai";
import { getAiSettings } from "./settings";
import { findSlots, type Busy } from "./schedule";

/**
 * Busy blocks for "Suggest a time": Home Assistant calendars (live, next 14
 * days, from ai.schedule.calendars or the HA integration's calendar entities)
 * plus the cached Home Assistant and Skylight snapshots. Server-side only:
 * calendar data never goes to AI.
 */
function cachedEvents(source: "home_assistant" | "skylight"): Busy[] {
  const row = getDb().select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.source, source)).get();
  if (!row?.payload) return [];
  try {
    const data = JSON.parse(row.payload) as { events?: { startsAt: string; endsAt?: string; allDay?: boolean }[] };
    return (data.events ?? []).map((e) => ({ start: e.startsAt, end: e.endsAt ?? null, allDay: !!e.allDay }));
  } catch {
    return [];
  }
}

async function haEvents(calendars: string[], start: Date, end: Date): Promise<Busy[]> {
  if (!calendars.length) return [];
  try {
    const { haConn, HomeAssistantClient } = await import("@/integrations/home-assistant/client");
    const conn = haConn();
    const out: Busy[] = [];
    await Promise.all(
      calendars.map(async (cal) => {
        try {
          for (const e of await HomeAssistantClient.calendarEvents(conn, cal, start.toISOString(), end.toISOString())) {
            const allDay = !!e.start.date && !e.start.dateTime;
            out.push({ start: e.start.dateTime ?? e.start.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? null, allDay });
          }
        } catch {
          /* one calendar failing doesn't block suggestions */
        }
      }),
    );
    return out;
  } catch {
    return [];
  }
}

function configuredHaCalendars(): string[] {
  const s = getAiSettings().schedule.calendars;
  if (s.length) return s;
  try {
    const row = getDb().select().from(schema.integrations).where(eq(schema.integrations.kind, "home_assistant")).get() as { config?: string } | undefined;
    const cfg = row?.config ? (JSON.parse(row.config) as { calendarEntities?: string }) : {};
    return (cfg.calendarEntities ?? "")
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function scheduleSlotsFor(
  userId: string,
  est: { durationMinutes: number; splitOk: boolean; preferredWindows: string[]; earliest?: string | null; deadline?: string | null },
  now = new Date(),
): Promise<ScheduleSlot[]> {
  const prefs = getPreferences(userId);
  const settings = getAiSettings();
  const end = new Date(now.getTime() + 15 * 86400_000);
  const busy = [...(await haEvents(configuredHaCalendars(), now, end)), ...cachedEvents("home_assistant"), ...cachedEvents("skylight")];
  const loaded = getDb()
    .select({ d: schema.workItems.targetDate })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.userId, userId), inArray(schema.workItems.status, ["in_progress"]), isNull(schema.workItems.completedAt)))
    .all()
    .map((r) => r.d)
    .filter((d): d is string => !!d);
  return findSlots({
    durationMinutes: est.durationMinutes,
    splitOk: est.splitOk,
    preferredWindows: est.preferredWindows as never,
    earliest: est.earliest,
    deadline: est.deadline,
    busy,
    workHours: settings.schedule.workHours,
    quietHours: prefs.quietHours,
    loadedDays: loaded,
    tz: prefs.timezone,
    now,
  });
}
