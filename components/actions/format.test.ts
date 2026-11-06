import { describe, expect, it } from "vitest";
import { calendarDay } from "@/lib/time";
import { formatDue } from "./format";

describe("date-only household due dates", () => {
  const dueAt = "2026-11-08T05:59:00Z";
  const now = Date.parse("2026-11-04T18:00:00Z");
  it("derives the calendar day in Chicago explicitly, independently of process/browser TZ", () => {
    expect(calendarDay(dueAt, "America/Chicago")).toBe("2026-11-07");
    expect(calendarDay(dueAt, "UTC")).toBe("2026-11-08");
    expect(calendarDay("2026-11-07", "America/Chicago")).toBe("2026-11-07");
  });
  it("formats Nov 7 rather than Nov 8 when a date-only timestamp crosses midnight UTC", () => {
    expect(formatDue({ dueAt, dueIsDate: true }, now, "America/Chicago")).toBe("Due Sat, Nov 7");
  });
  it("uses source household timezone even when the browser uses UTC", () => {
    expect(formatDue({ dueAt, dueIsDate: true, dueTimezone: "America/Chicago" }, now)).toBe("Due Sat, Nov 7");
    expect(formatDue({ dueAt, dueIsDate: true, dueTimezone: "America/Chicago" }, Date.parse("2026-11-08T02:00:00Z"))).toBe("Due today");
  });
  it.each([
    ["2026-11-06T18:00:00Z", "Due tomorrow"],
    ["2026-11-07T18:00:00Z", "Due today"],
    ["2026-11-08T18:00:00Z", "Due yesterday"],
    ["2026-11-09T18:00:00Z", "Due 2 days ago"],
  ])("uses household calendar-day differences at %s", (at, expected) => {
    expect(formatDue({ dueAt, dueIsDate: true }, Date.parse(at), "America/Chicago")).toBe(expected);
  });
  it("preserves bare dates in a timezone west of UTC", () => {
    expect(formatDue({ dueAt: "2026-11-07", dueIsDate: true }, now, "America/Chicago")).toBe("Due Sat, Nov 7");
  });
});
