// @vitest-environment jsdom
/** #62: radial submenus never stack entries onto the same spot when the orb sits in the desktop top row. */
import { expect, it } from "vitest";
import { subLayout } from "@/components/navigation/CommandDock";

const key = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;

it("stacks upward when there is room (phone dock at the bottom)", () => {
  Object.assign(window, { innerWidth: 390, innerHeight: 800 });
  const subs = subLayout({ x: 195, y: 700 }, 120, { x: 0 }, 4);
  expect(subs.map((p) => p.y)).toEqual([-190, -236, -282, -328]);
});

it("lays entries out sideways when the stack can't fit above (desktop top row)", () => {
  Object.assign(window, { innerWidth: 1280, innerHeight: 800 });
  const center = { x: 640, y: 215 };
  const subs = subLayout(center, 165, { x: 120 }, 4);
  expect(new Set(subs.map(key)).size).toBe(4);
  for (const p of subs) {
    expect(center.y + p.y).toBeGreaterThanOrEqual(64);
    expect(center.x + p.x).toBeGreaterThanOrEqual(70);
    expect(center.x + p.x).toBeLessThanOrEqual(1280 - 70);
  }
});
