/**
 * What a released pan does when it is handed back to physics.
 *
 * A drag is a placement and a fling is a throw, and the difference is speed: a
 * pan let go slowly keeps nothing, because the reader was aiming at a line. A
 * pan let go fast keeps its speed and decays, so a flick crosses the pane the way
 * it does in every other list on the device — and any new press catches it.
 *
 * The numbers live here rather than in the listener so they can be measured
 * without a browser: velocity over the last few frames, one decay per frame, and
 * the two thresholds that decide whether the throw starts and when it is over.
 */

/** A pointer position and when it was taken, in ms. */
export interface FlingSample {
  t: number;
  x: number;
  y: number;
}

export const FLING = {
  /** px/ms below which a release keeps no speed: a slow drag is a placement. */
  min: 0.12,
  /** px/ms the throw is capped at, so a whip cannot become a jump cut. */
  max: 5,
  /** Speed kept per frame. 0.94 over a 60Hz frame is a throw that dies in ~1s. */
  friction: 0.94,
  /** px/ms at which the throw is over and the pane is still. */
  stop: 0.02,
  /** The end of the gesture the release speed is read from, in ms. */
  window: 90,
  /** One 60Hz frame, the unit `friction` is quoted in. */
  frame: 1000 / 60,
} as const;

/**
 * The speed the pointer was still travelling at when it let go, in px/ms.
 *
 * Only the last `FLING.window` of the gesture counts: a drag that started fast
 * and slowed to a stop before release must not throw, and a drag that was slow
 * for a second and then flicked must. Samples older than the window are what
 * makes a flick at the end of a long drag read as a flick.
 */
export function releaseVelocity(
  samples: readonly FlingSample[],
  now: number,
  windowMs: number = FLING.window,
): { vx: number; vy: number } {
  const recent = samples.filter((sample) => now - sample.t <= windowMs);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  const cap = (v: number): number => Math.min(FLING.max, Math.max(-FLING.max, v));
  return { vx: cap((last.x - first.x) / dt), vy: cap((last.y - first.y) / dt) };
}

/** The same throw, one frame later. */
export function decayVelocity(
  vx: number,
  vy: number,
  dt: number,
): { vx: number; vy: number } {
  const keep = Math.pow(FLING.friction, dt / FLING.frame);
  return { vx: vx * keep, vy: vy * keep };
}

/** Whether a release throws at all. */
export function isFlung(vx: number, vy: number): boolean {
  return Math.hypot(vx, vy) >= FLING.min;
}

/** Whether the throw has run out. */
export function isSpent(vx: number, vy: number): boolean {
  return Math.hypot(vx, vy) < FLING.stop;
}

/**
 * How far a throw would travel from here, in px.
 *
 * Not used by the loop — a closed form would have to model the clamp at the ends
 * — but it is the number that says whether the feel is right. A throw of `v`
 * px/ms moves `v * frame` in its first frame and keeps `friction` of it per frame
 * after, so the sum is `v * frame / (1 - friction)`: half a pixel per ms is a
 * short flick of ~140px, and the cap is a screen or two.
 */
export function flingDistance(vx: number, vy: number): number {
  return (Math.hypot(vx, vy) * FLING.frame) / (1 - FLING.friction);
}
