/**
 * #239: after a device write, the House caches take the read-back freshness
 * token immediately, so the next slider change doesn't 409.
 */
import { describe, expect, it } from "vitest";
import { withFreshToken } from "@/components/home/HaControls";

describe("withFreshToken", () => {
  it("patches the device in every House list and leaves the rest alone", () => {
    const devices = {
      fetchedAt: "x",
      lights: [
        { entityId: "light.k", state: "on", stateToken: "old", brightness: 40 },
        { entityId: "light.p", state: "off", stateToken: "p1" },
      ],
      others: [{ entityId: "climate.hall", state: "heat", stateToken: "c1" }],
      doors: [],
    };
    const out = withFreshToken(devices, "light.k", "new", "on");
    expect(out.lights[0]).toEqual({ entityId: "light.k", state: "on", stateToken: "new", brightness: 40 });
    expect(out.lights[1]).toBe(devices.lights[1]);
    expect(out.others[0]).toBe(devices.others[0]);
    expect(devices.lights[0]!.stateToken).toBe("old");
    const controls = { controls: [{ entityId: "climate.hall", state: "heat", stateToken: "c1" }], fetchedAt: "x" };
    expect(withFreshToken(controls, "climate.hall", "c2", "cool").controls[0]).toMatchObject({ stateToken: "c2", state: "cool" });
  });

  it("ignores unrelated cache entries", () => {
    expect(withFreshToken(undefined, "light.k", "t", "on")).toBeUndefined();
    const other = { cameras: 1 };
    expect(withFreshToken(other, "light.k", "t", "on")).toBe(other);
  });
});
