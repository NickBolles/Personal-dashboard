import { describe, expect, it } from "vitest";
import { addDays, isoDate, isoDateIn } from "../mock-upstreams/util.mjs";

// Mock seeds ("due N days ago") must be calendar days in the frame tz (America/Chicago), even across a
// DST change: n × 24 h landed a day late between 23:00 and 00:00 CST in the week after the fall-back,
// which flipped the home-suggestions / smart-surface visual baselines every late evening.
describe("mock-upstreams date seeds", () => {
  const lateEvening = new Date("2026-11-02T05:21:00Z"); // Sun Nov 1 23:21 CST (DST ended that morning)
  const midday = new Date("2026-11-01T18:00:00Z"); // Sun Nov 1 12:00 CST

  it("counts calendar days across the fall-back at any time of day", () => {
    for (const now of [lateEvening, midday]) {
      expect(isoDate(now)).toBe("2026-11-01");
      expect(isoDateIn(-5, now)).toBe("2026-10-27");
      expect(isoDateIn(-10, now)).toBe("2026-10-22");
      expect(isoDateIn(10, now)).toBe("2026-11-11");
    }
  });

  it("counts calendar days across the spring-forward just after midnight", () => {
    const now = new Date("2027-03-15T05:30:00Z"); // Mon Mar 15 00:30 CDT (DST began Mar 14)
    expect(isoDate(now)).toBe("2027-03-15");
    expect(isoDateIn(-5, now)).toBe("2027-03-10");
  });

  it("keeps the frame wall-clock time", () => {
    expect(addDays(lateEvening, -5).toISOString()).toBe("2026-10-28T04:21:00.000Z"); // Oct 27 23:21 CDT
  });
});
