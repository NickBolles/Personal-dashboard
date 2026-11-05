import { describe, expect, it } from "vitest";
import type { CalendarEvent, NextAction } from "@/lib/contracts";
import { eventInstant, eventTime, previousEvent, shiftedEndDate } from "./eventFields";
import { choreWrite, listWrite } from "./model";

const event: CalendarEvent = {
  id: "sky:event",
  source: "skylight",
  title: "Lantern walk",
  startsAt: "2026-11-01T17:00:00-06:00",
  endsAt: "2026-11-01T18:00:00-06:00",
  allDay: false,
  location: "Park",
  skylight: { eventId: "event", editable: true, description: "Bring a lantern" },
};
const action: NextAction = {
  id: "sky:chore",
  source: "skylight",
  sourceId: "chore",
  title: "Water the fern",
  status: "open",
  priorityReason: "today",
  href: "/skylight",
  fetchedAt: "2026-11-01T12:00:00Z",
  staleAfter: "2026-11-02T12:00:00Z",
  updatedAt: "2026-11-01T12:00:00Z",
  skylight: { kind: "chore", choreId: "chore", instanceDate: "2026-11-01", instanceTime: "17:00", categoryId: "member", recurring: true },
};

describe("Skylight household calendar fields", () => {
  it.each([
    ["multi-day timed", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-13"],
    ["overnight", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"],
    ["all-day multi-day exclusive end", "2026-11-01", "2026-11-04", "2026-11-08", "2026-11-11"],
    ["month rollover", "2026-11-29", "2026-11-30", "2026-11-30", "2026-12-01"],
    ["spring DST boundary", "2026-03-07", "2026-03-09", "2026-03-08", "2026-03-10"],
    ["backwards across year", "2027-01-02", "2027-01-04", "2026-12-30", "2027-01-01"],
  ])("shifts %s by calendar days", (_label, start, end, next, expected) => {
    expect(shiftedEndDate(start, end, next)).toBe(expected);
  });
  it("keeps incomplete date inputs safe", () => {
    expect(shiftedEndDate("2026-11-01", "2026-11-02", "")).toBe("2026-11-02");
    expect(shiftedEndDate("2026-11-01", "", "2026-11-03")).toBe("");
  });
  it("snapshots every original calendar target field for delete Undo", () => {
    expect(
      previousEvent({ ...event, skylight: { ...event.skylight!, calendarId: "work@example.com", sourceCalendarId: "42", calendarAccountId: "7" } }),
    ).toMatchObject({
      calendarId: "work@example.com",
      sourceCalendarId: "42",
      calendarAccountId: "7",
    });
  });
  it.each([
    ["2026-03-08", "01:30", "2026-03-08T01:30:00-06:00"],
    ["2026-03-08", "17:30", "2026-03-08T17:30:00-05:00"],
    ["2026-11-01", "00:30", "2026-11-01T00:30:00-05:00"],
    ["2026-11-01", "17:30", "2026-11-01T17:30:00-06:00"],
  ])("uses the offset at %s %s rather than midnight or the browser", (date, time, expected) => {
    expect(eventInstant(date, time, "America/Chicago")).toBe(expected);
  });
  it("handles UTC and a non-whole-hour timezone", () => {
    expect(eventInstant("2026-11-01", "17:30", "UTC")).toBe("2026-11-01T17:30:00+00:00");
    expect(eventInstant("2026-11-01", "17:30", "Asia/Kathmandu")).toBe("2026-11-01T17:30:00+05:45");
  });
  it("normalizes a spring-forward gap to the actual household time", () => {
    expect(eventInstant("2026-03-08", "02:30", "America/Chicago")).toBe("2026-03-08T03:30:00-05:00");
  });
  it("prefills wall-clock time in the household timezone", () => {
    expect(eventTime("2026-11-01T23:00:00Z", "America/Chicago")).toBe("17:00");
  });
  it("preserves original event fields for update/delete inverses", () => {
    expect(previousEvent(event)).toEqual({
      summary: "Lantern walk",
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: false,
      location: "Park",
      description: "Bring a lantern",
    });
  });
  it("keeps all-day values date-only and the end exclusive across month boundaries", () => {
    expect(previousEvent({ ...event, allDay: true, startsAt: "2026-11-30", endsAt: undefined })).toMatchObject({
      startsAt: "2026-11-30",
      endsAt: "2026-12-01",
      allDay: true,
    });
  });
});

describe("Skylight action write targets", () => {
  it("carries recurring occurrence and assignment fields to complete/reopen", () => {
    expect(choreWrite(action, "chore.complete")).toEqual({
      op: "chore.complete",
      title: action.title,
      choreId: "chore",
      instanceDate: "2026-11-01",
      instanceTime: "17:00",
      categoryId: "member",
    });
    expect(choreWrite(action, "chore.reopen")?.op).toBe("chore.reopen");
  });
  it("checks pending items and unchecks completed items without losing their list identity", () => {
    const item = { ...action, skylight: { kind: "list_item" as const, listId: "7001", itemId: "oat", listLabel: "Groceries" } };
    expect(listWrite(item)).toEqual({ op: "list.check", listId: "7001", itemId: "oat", listLabel: "Groceries", label: action.title });
    expect(listWrite({ ...item, status: "completed" })?.op).toBe("list.uncheck");
    expect(choreWrite(item, "chore.complete")).toBeNull();
    expect(listWrite(action)).toBeNull();
  });
});
