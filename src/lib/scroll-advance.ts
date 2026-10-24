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
 * `THRESHOLD * (1 + RESISTANCE / 2)` — 728px here, about seven 100px wheel
 * notches at the bottom of an article. Deliberate enough that a stray flick
 * does not switch articles, short enough that it never feels stuck.
 */
export const PULL_THRESHOLD = 280;

/**
 * How hard it is to leave a post, as a multiplier on the threshold.
 *
 * One knob rather than two: scaling the threshold scales the whole gesture —
 * the pull fills the same way and the same curve applies, it simply takes more
 * (or less) wheel travel to get there. Kept at 1 by default, which is exactly
 * the behaviour that was tuned by hand.
 */
export const EFFORT_DEFAULT = 1;

/**
 * The slider's range, and the range a typed value may use.
 *
 * The slider is for finding a feel by dragging; the number beside it is for
 * saying what you actually want, which may sit outside the slider — someone on
 * a mouse wheel may want ×4, someone on a trackpad ×0.3. The hard bounds only
 * stop values that break the gesture: below 0.1 one notch would leave a post,
 * and above 10 a "next post" would never arrive.
 */
export const EFFORT_MIN = 0.5;
export const EFFORT_MAX = 2;
export const EFFORT_HARD_MIN = 0.1;
export const EFFORT_HARD_MAX = 10;

export function clampEffort(value: unknown): number {
  if (value === null || value === undefined || value === "") return EFFORT_DEFAULT;
  const effort = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(effort)) return EFFORT_DEFAULT;
  const rounded = Math.round(effort * 10) / 10;
  return Math.min(Math.max(rounded, EFFORT_HARD_MIN), EFFORT_HARD_MAX);
}

/** What the slider should show for a value that may be outside its range. */
export function withinSlider(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The pull threshold for a chosen effort. 1 = `PULL_THRESHOLD` unchanged. */
export function thresholdFor(effort: number): number {
  return Math.round(PULL_THRESHOLD * clampEffort(effort));
}

/** How much heavier the pull gets by the end. 0 = linear, 2.5 = heavy. */
export const RESISTANCE = 3.2;

/** Convenience: how much of a wheel delta counts at current progress. */
export function contribution(progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return 1 / (1 + RESISTANCE * clamped);
}

/**
 * Add a wheel delta to the pull, in the same pixel units.
 *
 * The pull is signed: positive towards the next article, negative towards the
 * previous one, so one accumulator serves both ends of the article without a
 * second threshold and curve to keep in step. The magnitude never exceeds
 * `PULL_THRESHOLD`; `shouldAdvance()` decides when it is enough.
 *
 * Reversing direction first eats the pull already made rather than starting a
 * fresh counter — otherwise a flick down and back up would switch articles.
 */
export function accumulate(pull: number, deltaY: number, threshold = PULL_THRESHOLD): number {
  if (!(threshold > 0)) return 0;
  if (deltaY === 0) return pull;
  const progress = progressOf(pull, threshold);
  const next = pull + deltaY * contribution(progress);
  return Math.max(-threshold, Math.min(next, threshold));
}

/** How full the pull is, 0..1, regardless of direction. */
export function progressOf(pull: number, threshold = PULL_THRESHOLD): number {
  if (!(threshold > 0)) return 0;
  return Math.min(Math.abs(pull) / threshold, 1);
}

/** `1` when the pull would go forward, `-1` back, `0` when there is none. */
export function directionOf(pull: number): -1 | 0 | 1 {
  if (pull > 0) return 1;
  if (pull < 0) return -1;
  return 0;
}

export function shouldAdvance(pull: number, threshold = PULL_THRESHOLD): boolean {
  return Math.abs(pull) >= threshold;
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

/**
 * How long a switch keeps the wheel shut afterwards.
 *
 * A trackpad flick keeps sending deltas after the finger has stopped. Those land
 * on whatever has just arrived, and if it is short it is already at its end, so
 * they read as a fresh pull and take a second post with them. Both panes wait
 * this long after a switch before counting wheel travel again — the same delay
 * in the article and in the card list, so stepping feels identical.
 */
export const SETTLE_MS = 420;
