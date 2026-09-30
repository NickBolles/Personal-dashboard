import { describe, expect, it } from "vitest";
import { inWindow, localDate, localMinutes, localTimeToInstant, parseHHMM, startOfLocalDay } from "./time";

describe("time helpers", () => {
  it("windows handle midnight crossing", () => {
    expect(inWindow(parseHHMM("23:00"), "22:00", "07:00")).toBe(true);
    expect(inWindow(parseHHMM("06:59"), "22:00", "07:00")).toBe(true);
    expect(inWindow(parseHHMM("07:00"), "22:00", "07:00")).toBe(false);
    expect(inWindow(parseHHMM("20:00"), "19:00", "22:00")).toBe(true);
    expect(inWindow(parseHHMM("12:00"), "12:00", "12:00")).toBe(false);
  });
  it("local dates and times respect the timezone", () => {
    const t = new Date("2026-10-01T03:30:00Z"); // 22:30 CDT on Sep 30
    expect(localDate(t, "America/Chicago")).toBe("2026-09-30");
    expect(localMinutes(t, "America/Chicago")).toBe(22 * 60 + 30);
    expect(startOfLocalDay("2026-09-30", "America/Chicago").toISOString()).toBe("2026-09-30T05:00:00.000Z");
    expect(localTimeToInstant("2026-09-30", "20:00", "America/Chicago").toISOString()).toBe("2026-10-01T01:00:00.000Z");
  });
  it("handles DST transitions", () => {
    expect(startOfLocalDay("2026-11-02", "America/Chicago").toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(startOfLocalDay("2026-03-09", "America/Chicago").toISOString()).toBe("2026-03-09T05:00:00.000Z");
  });
});
