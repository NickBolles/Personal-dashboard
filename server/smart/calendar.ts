import "server-only";
import { HttpError } from "@/server/http/errors";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { adapterContext, refreshSource } from "@/server/sources";
import { haConn, HomeAssistantClient } from "@/integrations/home-assistant/client";
import { localTimeToInstant, MINUTE } from "@/lib/time";
import type { ExternalIntent } from "@/lib/jarvis-ui/catalog";
import { calendarConfig } from "./data";
import { getSmartSettings } from "./store";

/**
 * `calendar.block` (spec §4.3): one Home Assistant `calendar.create_event`
 * call, then a readback of that time window. Only when the person turned
 * calendar writes on, only through the separate calendar approval, and only
 * to the first configured household calendar. There is no delete: removing
 * a block happens in the calendar itself.
 */
export function requireCalendarWrites(user: CurrentUser) {
  if (!getSmartSettings(user.id).calendarWrites) throw new HttpError(403, "calendar_off", "Calendar writes are off. Turn them on in Settings → Smart replies.");
  if (!can(user, "home_assistant.calendar")) throw new HttpError(403, "forbidden", "You don't have access to the household calendar.");
  const cal = calendarConfig().calendars[0];
  if (!cal) throw new HttpError(409, "no_calendar", "No household calendar is set up in Home Assistant.");
  return cal;
}

export async function addCalendarBlock(user: CurrentUser, intent: ExternalIntent, title: string) {
  const cal = requireCalendarWrites(user);
  const tz = adapterContext().timezone;
  const start = localTimeToInstant(intent.date, intent.start, tz);
  const end = new Date(start.getTime() + intent.minutes * MINUTE);
  const summary = title.slice(0, 200);
  const conn = haConn();
  await HomeAssistantClient.callService(conn, "calendar", "create_event", {
    entity_id: cal,
    summary,
    description: "Planned in Jarvis",
    start_date_time: start.toISOString(),
    end_date_time: end.toISOString(),
  });
  // Readback: the event must be on the calendar at that time before we say it is.
  const around = await HomeAssistantClient.calendarEvents(conn, cal, new Date(start.getTime() - MINUTE).toISOString(), new Date(end.getTime() + MINUTE).toISOString());
  const found = around.some((e) => {
    const at = (e.start as { dateTime?: string } | undefined)?.dateTime;
    return e.summary === summary && at && Math.abs(new Date(at).getTime() - start.getTime()) < MINUTE;
  });
  if (!found) throw new HttpError(502, "readback_failed", "The calendar didn't confirm the new block. Check it before trying again.");
  await refreshSource("home_assistant").catch(() => undefined);
  return { message: "Added to the calendar", undo: { type: "none" } };
}
