/**
 * Scrolling past the end of an article: a pull that gets heavier as it fills.
 *
 * Advancing on the first wheel tick past the bottom felt like an ambush — one
 * flick and you were in a different article. Instead the scroll accumulates
 * into a pull, and each pixel of wheel movement contributes less than the one
 * before, so the last stretch needs a deliberate push. The pull is drawn as a
 * filling line at the bottom of the pane, which is the feedback: you can feel
 * how close the switch is before it happens.
 */

/**
 * Wheel travel a full pull is worth. With the resistance the real cost is
 * `THRESHOLD * (1 + RESISTANCE / 2)` — 450px here, about four 100px wheel
 * notches at the bottom of an article. Deliberate enough that a stray flick
 * does not switch articles, short enough that it never feels stuck.
 */
export const PULL_THRESHOLD = 200;

/** How much heavier the pull gets by the end. 0 = linear, 2.5 = heavy. */
export const RESISTANCE = 2.5;

/** Convenience: how much of a wheel delta counts at current progress. */
export function contribution(progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return 1 / (1 + RESISTANCE * clamped);
}

/**
 * Add a wheel delta to the pull, in the same pixel units.
 *
 * The result never exceeds `PULL_THRESHOLD`; `shouldAdvance()` decides when the
 * accumulated pull is enough.
 */
export function accumulate(pull: number, deltaY: number, threshold = PULL_THRESHOLD): number {
  if (!(deltaY > 0)) return Math.max(0, pull);
  const progress = Math.min(Math.max(pull / threshold, 0), 1);
  const next = pull + deltaY * contribution(progress);
  return Math.min(next, threshold);
}

export function progressOf(pull: number, threshold = PULL_THRESHOLD): number {
  if (!(threshold > 0)) return 0;
  return Math.min(Math.max(pull / threshold, 0), 1);
}

export function shouldAdvance(pull: number, threshold = PULL_THRESHOLD): boolean {
  return pull >= threshold;
}

/**
 * Wheel travel actually needed to switch, given the curve. Exposed for the
 * tests and for the honest answer to "how much scrolling is that".
 */
export function travelToAdvance(threshold = PULL_THRESHOLD, step = 1): number {
  let pull = 0;
  let travel = 0;
  while (pull < threshold && travel < threshold * 100) {
    pull = accumulate(pull, step, threshold);
    travel += step;
  }
  return travel;
}
