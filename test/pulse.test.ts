import { describe, expect, it } from "vitest";
import { addedVsCompleted, dayKey, lastDays, sparkPoints, sum } from "@/lib/pulse";

const TZ = "America/Chicago";

describe("Today pulse trend", () => {
  it("buckets days in the given time zone, not UTC", () => {
    // 02:00Z on Oct 30 is still Oct 29 in Chicago.
    expect(dayKey("2026-10-30T02:00:00Z", TZ)).toBe("2026-10-29");
    expect(dayKey("2026-10-30T12:00:00Z", TZ)).toBe("2026-10-30");
    expect(dayKey("not a date", TZ)).toBe("");
  });

  it("lists the last 14 days oldest first, ending today", () => {
    const days = lastDays(new Date("2026-10-30T15:00:00Z"), 14, TZ);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe("2026-10-17");
    expect(days[13]).toBe("2026-10-30");
    // crosses a month boundary
    expect(lastDays(new Date("2026-11-02T15:00:00Z"), 3, TZ)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("counts added and completed per day and ignores rows outside the window", () => {
    const now = new Date("2026-10-30T15:00:00Z");
    const t = addedVsCompleted(
      [
        { createdAt: "2026-10-30T14:00:00Z", completedAt: null },
        { createdAt: "2026-10-29T14:00:00Z", completedAt: "2026-10-30T13:00:00Z" },
        { createdAt: "2026-09-01T14:00:00Z", completedAt: "2026-10-17T18:00:00Z" },
        { createdAt: "2026-09-01T14:00:00Z", completedAt: "2026-10-16T18:00:00Z" }, // before window
        { createdAt: null, completedAt: null },
      ],
      now,
      TZ,
    );
    expect(t.days).toHaveLength(14);
    expect(t.added[13]).toBe(1);
    expect(t.added[12]).toBe(1);
    expect(sum(t.added)).toBe(2);
    expect(t.completed[13]).toBe(1);
    expect(t.completed[0]).toBe(1);
    expect(sum(t.completed)).toBe(2);
  });

  it("draws sparkline points on a shared scale", () => {
    expect(sparkPoints([], 100, 20)).toBe("");
    const pts = sparkPoints([0, 2, 4], 100, 20, 4).split(" ");
    expect(pts).toEqual(["0,19", "50,10", "100,1"]);
    // zeros sit on the baseline
    expect(sparkPoints([0, 0], 10, 20)).toBe("0,19 10,19");
  });
});
