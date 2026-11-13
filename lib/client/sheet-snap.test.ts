import { expect, it } from "vitest";
import { sheetSnap } from "./sheet-snap";

const half = 480;
const full = 720;

it("a slow drag settles on the nearest resting height", () => {
  expect(sheetSnap({ height: 470, velocity: 0, half, full })).toBe("half");
  expect(sheetSnap({ height: 590, velocity: 0, half, full })).toBe("half");
  expect(sheetSnap({ height: 610, velocity: 0, half, full })).toBe("full");
  expect(sheetSnap({ height: 900, velocity: 0, half, full })).toBe("full");
});

it("dragged well below half height, it closes; a small dip does not", () => {
  expect(sheetSnap({ height: 300, velocity: 0, half, full })).toBe("half");
  expect(sheetSnap({ height: 280, velocity: 0, half, full })).toBe("closed");
  expect(sheetSnap({ height: 0, velocity: 0, half, full })).toBe("closed");
});

it("a quick flick counts for more than the distance moved", () => {
  // 40 px up from half, released fast: full height
  expect(sheetSnap({ height: 520, velocity: -1, half, full })).toBe("full");
  // 40 px down from half, released fast: closed
  expect(sheetSnap({ height: 440, velocity: 1.2, half, full })).toBe("closed");
  // a quick flick down from full height stops at half first
  expect(sheetSnap({ height: 680, velocity: 1, half, full })).toBe("half");
});

it("one wild speed sample cannot throw the sheet further than a real flick", () => {
  expect(sheetSnap({ height: 700, velocity: 40, half, full })).toBe("half");
  expect(sheetSnap({ height: 100, velocity: -40, half, full })).toBe("half");
});
