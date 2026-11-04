import "server-only";
import { HttpError } from "@/server/http/errors";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { adapterContext, refreshSource } from "@/server/sources";
import { haConn, HomeAssistantClient } from "@/integrations/home-assistant/client";
import { localTimeToInstant, MINUTE } from "@/lib/time";
import type { ExternalIntent } from "@/lib/jarvis-ui/catalog";
import { calendarConfig, usesSkylightCalendar } from "./data";
import { getSmartSettings } from "./store";

import { runSkylightWrite } from "@/integrations/skylight/write";
import { recordWrite } from "@/server/skylight-writes";
import { newId } from "@/server/crypto";
import type { SkylightWriteOp } from "@/lib/skylight-write";

export { usesSkylightCalendar } from "./data";

export type CalendarBlockUndo = { type: "none" } | { type: "skylight"; writeId: string };

/**
 * `calendar.block`: prefer direct writable Skylight (with a recorded inverse),
 * otherwise keep the Home Assistant create/readback path. Both require the
 * person's calendar-writes setting and the separate calendar approval.
 */
export function requireCalendarWrites(user: CurrentUser) {
  if (!getSmartSettings(user.id).calendarWrites) throw new HttpError(403, "calendar_off", "Calendar writes are off. Turn them on in Settings → Smart replies.");
  if (usesSkylightCalendar()) {
    if (!can(user, "skylight.write")) throw new HttpError(403, "forbidden", "You don't have access to change Skylight.");
    return null;
  }
  if (!can(user, "home_assistant.calendar")) throw new HttpError(403, "forbidden", "You don't have access to the household calendar.");
  const cal = calendarConfig().calendars[0];
  if (!cal) throw new HttpError(409, "no_calendar", "No household calendar is set up in Home Assistant.");
  return cal;
}

export async function addCalendarBlock(
  user: CurrentUser,
  intent: ExternalIntent,
  title: string,
  correlationId = newId(),
): Promise<{ message: string; undo: CalendarBlockUndo }> {
  const cal = requireCalendarWrites(user);
  const tz = adapterContext().timezone;
  const start = localTimeToInstant(intent.date, intent.start, tz);
  const end = new Date(start.getTime() + intent.minutes * MINUTE);
  const summary = title.slice(0, 200);
  if (cal === null) {
    const op: SkylightWriteOp = {
      op: "event.create",
      event: { summary, allDay: false, startsAt: start.toISOString(), endsAt: end.toISOString(), description: "Planned in Jarvis" },
    };
    const result = await runSkylightWrite(op, user, { correlationId });
    const row = recordWrite(op, user, result.created);
    await refreshSource("skylight").catch(() => undefined);
    return { message: "Added to the family calendar", undo: { type: "skylight", writeId: row.id } };
  }
  const conn = haConn();
  await HomeAssistantClient.callService(conn, "calendar", "create_event", {
    entity_id: cal,
    summary,
    description: "Planned in Jarvis",
    start_date_time: start.toISOString(),
    end_date_time: end.toISOString(),
  });
  // Readback: the event must be on the calendar at that time before we say it is.
  const around = await HomeAssistantClient.calendarEvents(
    conn,
    cal,
    new Date(start.getTime() - MINUTE).toISOString(),
    new Date(end.getTime() + MINUTE).toISOString(),
  );
  const found = around.some((e) => {
    const at = (e.start as { dateTime?: string } | undefined)?.dateTime;
    return e.summary === summary && at && Math.abs(new Date(at).getTime() - start.getTime()) < MINUTE;
  });
  if (!found) throw new HttpError(502, "readback_failed", "The calendar didn't confirm the new block. Check it before trying again.");
  await refreshSource("home_assistant").catch(() => undefined);
  return { message: "Added to the calendar", undo: { type: "none" } };
}
