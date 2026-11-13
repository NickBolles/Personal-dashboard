export type SheetDetent = "closed" | "half" | "full";

/** How far ahead (ms) a release is projected along its speed, so a short quick flick counts like a long slow drag. */
const PROJECT_MS = 150;
/** Fastest speed (px/ms) a release is credited with: one noisy sample must not throw the sheet across the screen. */
const MAX_SPEED = 2;

/**
 * Where a dragged bottom sheet settles when the finger lifts.
 * `height` is how tall the sheet would be at the release point, `velocity` is px/ms with down as positive,
 * `half` and `full` are the two resting heights.
 */
export function sheetSnap({ height, velocity, half, full }: { height: number; velocity: number; half: number; full: number }): SheetDetent {
  const speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocity));
  const projected = height - speed * PROJECT_MS;
  if (projected < half * 0.6) return "closed";
  if (projected > (half + full) / 2) return "full";
  return "half";
}
