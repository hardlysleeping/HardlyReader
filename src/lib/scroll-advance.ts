/**
 * Scrolling past the end of an article: a pull that gets heavier as it fills.
 *
 * Advancing on the first wheel tick past the bottom felt like an ambush — one
 * flick and you were in a different article. Instead the scroll accumulates
 * into a pull, and each pixel of wheel movement contributes less than the one
 * before, so the last stretch needs a deliberate push. The pull is drawn as a
 * filling line at the bottom of the pane, which is the feedback: you can feel
 * how close the switch is before it happens.
 *
 * A finger gets the same curve, and the same line, from `swipePull`: it reports
 * where it is rather than how far it just moved, so the gesture is one closed
 * form of the same integral, worth `SWIPE_GAIN` wheel pixels per pixel of
 * thumb. What fills the line is one number either way, so the two cannot drift
 * apart in feel or in feedback.
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
 * How much a finger's travel is worth against the wheel's own curve.
 *
 * The wheel needs 728px to fill the pull, which is a trackpad flick; the same
 * 728px on a phone is an arm movement, not a swipe. This gain puts a full pull
 * at 273px of thumb — a third of a 390x844 screen, one unhurried swipe — while
 * keeping the shape identical, because what makes the gesture feel like a
 * spring is the curve, not the distance. It was 4, which filled at 182px; the
 * owner read that as "it switches before I have dragged anything" and asked for
 * half again. Lowering the gain rather than raising the wheel's threshold is the
 * narrow fix: the wheel's 728px was tuned by hand and is not in this complaint.
 */
export const SWIPE_GAIN = 2.67;

/**
 * Finger travel a full pull is worth, the inverse of `swipePull`.
 *
 * At the shipped gain this is 273px from 182: the owner asked for the drag to
 * be half again as long as it was, because at 182 a thumb barely moved and the
 * post was already leaving. The number he can change is the pull threshold's
 * effort multiplier (`reading.scrollEffort`), which scales this distance with
 * it — the phone's Aa panel shows the result in pixels rather than as a
 * multiplier, since "×1.5" says nothing about where a third of the screen is.
 */
export function swipeTravel(threshold = PULL_THRESHOLD, gain = SWIPE_GAIN): number {
  if (!(threshold > 0) || !(gain > 0)) return 0;
  return Math.round(((RESISTANCE + 2) * threshold) / (2 * gain));
}

/** The drag distance, in pixels, that a chosen effort draws on a phone. */
export function swipePxFor(effort: number, gain = SWIPE_GAIN): number {
  return swipeTravel(thresholdFor(effort), gain);
}

/**
 * The effort a pixel distance means, so a stepper in pixels writes the same
 * store the wheel's multiplier row does. Linear because `swipeTravel` is:
 * 273px is ×1, and every 27px above it is another tenth.
 */
export function effortForSwipePx(px: number, gain = SWIPE_GAIN): number {
  const base = swipeTravel(PULL_THRESHOLD, gain);
  if (!(base > 0) || !Number.isFinite(px)) return EFFORT_DEFAULT;
  return clampEffort(px / base);
}

/**
 * Where in the pull's last stretch the next post starts to come into view.
 *
 * Not at the apex: the apex is the half of the curve that costs the most, and a
 * reveal that begins only when the pull is already full would flash. From 85%
 * of it the post above slides away and the next one shows behind it, so the
 * last push has somewhere to go — and letting go before the line fills puts
 * both back on one curve.
 */
export const PEEK_FROM = 0.85;

/** How much more travel completes the reveal, as a fraction of the apex. */
export const PEEK_SPAN = 0.3;

/**
 * How far the next post has been revealed, 0..1, for a finger's travel.
 *
 * `off` is the setting: with "Reveal next" off this is always 0 and the pull is
 * the bar filling, exactly as it was. Kept here rather than in the component so
 * the curve can be tested without a finger.
 */
export function peekOf(
  travel: number,
  threshold = PULL_THRESHOLD,
  on = true,
  gain = SWIPE_GAIN,
): number {
  if (!on) return 0;
  const apex = swipeTravel(threshold, gain);
  if (!(apex > 0) || !(travel > 0)) return 0;
  const start = apex * PEEK_FROM;
  const span = Math.max(1, apex * PEEK_SPAN);
  return Math.min(1, Math.max(0, (travel - start) / span));
}

/**
 * The pull a finger's travel has built, on the wheel's own curve.
 *
 * `accumulate` integrates the resistance a notch at a time; a finger reports
 * where it is rather than how far it just moved, so this is the same curve in
 * closed form — `(1 + R p) dp = k dt`, solved for `p` — and the two agree to
 * the pixel. Keeping it closed rather than stepping means a fast swipe cannot
 * skip the expensive part of the curve by arriving with one big delta.
 */
export function swipePull(travel: number, threshold = PULL_THRESHOLD, gain = SWIPE_GAIN): number {
  if (!(threshold > 0) || !(gain > 0) || !(travel > 0)) return 0;
  const progress = (-1 + Math.sqrt(1 + (2 * RESISTANCE * gain * travel) / threshold)) / RESISTANCE;
  return Math.min(threshold, progress * threshold);
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
