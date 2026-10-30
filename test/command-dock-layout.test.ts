import { describe, expect, it } from "vitest";
import { BOTTOM_CLEAR, mapCentre } from "@/components/navigation/CommandDock";

describe("command dock radial centre", () => {
  it("raises a bottom orb so the lowest petals clear the bottom bar and safe area", () => {
    for (const [vw, vh] of [
      [390, 844],
      [412, 915],
      [820, 1180],
      [880, 1000],
      [1000, 880],
    ]) {
      const c = mapCentre({ x: vw / 2, y: vh - 40 }, vw, vh, 24);
      expect(c.y).toBeLessThanOrEqual(vh - 24 - BOTTOM_CLEAR);
      // Lowest petal (≈0.21R above the centre, 34px half-height) stays on screen above the bar.
      expect(c.y + 34).toBeLessThan(vh - 24 - 56);
    }
  });
  it("keeps a top-row orb pushed down and leaves mid-screen orbs alone", () => {
    expect(mapCentre({ x: 600, y: 30 }, 1440, 900).y).toBe(215);
    expect(mapCentre({ x: 600, y: 500 }, 1440, 900)).toEqual({ x: 600, y: 500 });
  });
});
