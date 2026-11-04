import type { CalendarEvent } from "@/lib/contracts";
import type { SkylightEventFields } from "@/lib/skylight-write";
import { addDays, localDate, localMinutes, localTimeToInstant } from "@/lib/time";

export function eventTime(value: string, timezone: string) {
  const minutes = localMinutes(new Date(value), timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Keep the household wall-clock offset, not the browser's timezone or midnight's DST offset. */
export function eventInstant(date: string, time: string, timezone: string) {
  const instant = localTimeToInstant(date, time, timezone);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(instant);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
  return `${localDate(instant, timezone)}T${eventTime(instant.toISOString(), timezone)}:00${offset}`;
}

/** Snapshot the actual fields, including description, so edit/delete Undo restores them. */
export function previousEvent(event: CalendarEvent): SkylightEventFields {
  const allDay = Boolean(event.allDay);
  const startsAt = allDay ? event.startsAt.slice(0, 10) : event.startsAt;
  return {
    summary: event.title,
    allDay,
    startsAt,
    endsAt: event.endsAt
      ? allDay
        ? event.endsAt.slice(0, 10)
        : event.endsAt
      : allDay
        ? addDays(startsAt, 1)
        : new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    location: event.location ?? null,
    description: event.skylight?.description ?? null,
  };
}
