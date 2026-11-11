/**
 * Scrolling past the end of an article: a pull that gets heavier as it fills.
 *
 * Advancing on the first wheel tick past the bottom felt like an ambush — one
 * flick and you were in a different article. Instead the scroll accumulates
 * into a pull, and the cost of the next pixel rises the further the pull has
 * come: the first third of the bar is cheap, the last third needs a deliberate
 * push. The pull is drawn as a filling line at the bottom of the pane, which is
 * the feedback — you can feel how close the switch is before it happens.
 *
 * The shape is `progress = 1 - (1 - u)²`, where `u` is how much of the full
 * travel has been spent, 0..1. It is the same curve for a wheel and for a
 * finger, and it is exactly invertible, so neither has to be integrated a notch
 * at a time: a finger reports where it is (`swipePull`) and gets the number the
 * wheel would have after the same travel. That also means a fast swipe cannot
 * skip the expensive end of the curve by arriving with one big delta.
 *
 * Why not the old `1 / (1 + 3.2 p)` per-pixel resistance: measured, it held
 * every notch at 26–38px after the first two, so the last stretch cost the same
 * as the middle — the bar crawled but the effort never changed. Here the same
 * 100px notch is worth 71px of pull at the start and 12px at the end, and the
 * last quarter of the bar takes 40% of the travel.
 */

/**
 * Wheel travel a full pull is worth, as a multiple of the threshold. With the
 * shipped threshold that is 728px — about seven 100px notches at the bottom of
 * an article. Deliberate enough that a stray flick does not switch articles,
 * short enough that it never feels stuck.
 */
export const TRAVEL_RATIO = 2.6;

export const PULL_THRESHOLD = 280;

/**
 * How the travel is shaped into progress. 1 would be linear; 2 means the last
 * quarter of the bar costs 40% of the travel and the first quarter costs 13%.
 */
export const PULL_CURVE = 2;

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

/** Travel, in wheel pixels, that fills a pull for a given threshold. */
export function travelFor(threshold = PULL_THRESHOLD): number {
  if (!(threshold > 0)) return 0;
  return Math.round(threshold * TRAVEL_RATIO);
}

/** How much of the pull a share of the travel has built, 0..1. */
export function curveAt(u: number): number {
  if (!(u > 0)) return 0;
  if (!Number.isFinite(u)) return 1;
  const spent = Math.min(u, 1);
  return 1 - Math.pow(1 - spent, PULL_CURVE);
}

/** The inverse of {@link curveAt}: the share of travel a progress needs. */
export function travelAt(progress: number): number {
  if (!(progress > 0)) return 0;
  if (!Number.isFinite(progress)) return 1;
  const filled = Math.min(progress, 1);
  return 1 - Math.pow(1 - filled, 1 / PULL_CURVE);
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
 * fresh counter — otherwise a flick down and back up would switch articles —
 * and because the reversal runs on the same curve it also eats the expensive
 * end last, so a pull nearly made is not swept away by one backwards flick.
 */
export function accumulate(pull: number, deltaY: number, threshold = PULL_THRESHOLD): number {
  if (!(threshold > 0)) return 0;
  if (deltaY === 0) return pull;
  const total = travelFor(threshold);
  if (!(total > 0)) return 0;
  const sign = pull > 0 ? 1 : pull < 0 ? -1 : 0;
  const spent = sign * travelAt(progressOf(pull, threshold));
  const moved = Math.max(-1, Math.min(1, spent + deltaY / total));
  return Math.sign(moved) * curveAt(Math.abs(moved)) * threshold;
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
  return Math.round(travelFor(threshold) / gain);
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
 * The pull a finger's travel has built, on the wheel's own curve.
 *
 * Same closed form the wheel integrates to, so the two agree to the pixel:
 * `curveAt(travel / travelFor(threshold))`. Keeping it closed rather than
 * stepping means a fast swipe cannot skip the expensive part of the curve by
 * arriving with one big delta.
 */
export function swipePull(travel: number, threshold = PULL_THRESHOLD, gain = SWIPE_GAIN): number {
  if (!(threshold > 0) || !(gain > 0)) return 0;
  if (!(travel > 0)) return 0;
  if (!Number.isFinite(travel)) return threshold;
  const full = swipeTravel(threshold, gain);
  if (!(full > 0)) return 0;
  return Math.min(threshold, curveAt(travel / full) * threshold);
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
export const PEEK_FROM = 0.8;

/**
 * How much more progress completes the reveal.
 *
 * The reveal lands exactly on the apex, so the post that lifts away has been
 * fully uncovered by the time letting go would switch — a reveal that only got
 * half way would be a page that started to move and then stopped for no reason.
 */
export const PEEK_SPAN = 0.2;

/**
 * How far the next post has been revealed, 0..1, for the pull's progress.
 *
 * Progress, not travel, so a wheel and a finger reveal the same thing at the
 * same point on the line — and a wheel that is pushing past the end gets the
 * same slide-away a thumb does. `off` is the setting: with "Reveal next" off
 * this is always 0 and the pull is the bar filling, exactly as it was. Kept
 * here rather than in the component so the curve can be tested without a finger.
 */
export function peekOf(progress: number, on = true): number {
  if (!on) return 0;
  if (!(progress > PEEK_FROM)) return 0;
  if (!Number.isFinite(progress)) return 1;
  // Tested, not computed: `(1 - 0.8) / 0.2` is 0.9999999999999998 in binary
  // floating point, and a reveal that stops a hair short of its own apex is a
  // reveal that ends a pixel early on the one frame that matters.
  if (progress >= PEEK_FROM + PEEK_SPAN) return 1;
  const span = Math.max(PEEK_SPAN, 1e-6);
  return Math.min(1, (Math.min(progress, 1) - PEEK_FROM) / span);
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

/**
 * How long the wheel has to be quiet before a push counts as a NEW gesture.
 *
 * The settle window above is a fixed interval, so a trackpad or a spun wheel
 * that keeps sending deltas for a second and a half outlives it: every 420ms
 * another pull fills on travel the reader already spent, and one flick walks
 * several posts. On short posts — a comic strip, a one-line link — that reads as
 * the list jumping from the 5th to the 1st, which is exactly what the owner
 * reported. So a gesture earns one switch: the deltas that follow it are spent
 * until one arrives after a gap this long, which is a hand that has stopped and
 * pushed again.
 *
 * Deliberately short. A mouse wheel's own clicks are 30–80ms apart while it
 * spins, so a spin stays ONE gesture; a reader who wants the next post lifts off
 * and pushes, and 160ms is below the time it takes to do that.
 */
export const GESTURE_GAP_MS = 160;

/**
 * The same question for the cards column, whose answer is not the wheel's one.
 *
 * `GESTURE_GAP_MS` above is about a *wheel*, and a wheel is either turning or
 * not: its notches are 30–80ms apart, so a 160ms gap really is a hand that
 * stopped. Two-finger scrolling is not like that. Its deltas are emitted as the
 * accumulated travel crosses a threshold, so a *slow* push sends them 200–450ms
 * apart while the reader's fingers have never left the pad — and after a flick,
 * the desktop's own kinetic scrolling keeps sending them at that spacing too.
 *
 * At 160ms each of those read as a fresh gesture, so the column bought a card
 * per event: measured in a real browser against this component, ten deltas 180ms
 * apart crossed ten cards, and the same ten at 120ms apart crossed one. That is
 * the owner's "I scroll the comics and it jumps days at a time".
 *
 * The fix is not a longer *gap* — a slow push and two separate pushes can both
 * arrive 300ms apart, so no gap distinguishes them — it is the rule the article
 * pane already uses on its own wheel: a step buys the gesture, and the column
 * does not listen again until the wheel has been *quiet* for long enough that a
 * hand can plausibly have stopped and pushed again. Measured, that is 600ms:
 * deltas spaced anywhere from 8ms to 550ms cross exactly one card, while a
 * reader who stops and pushes again a second later gets the next one. Anything
 * shorter leaves a slow scroll — 450ms between deltas still crossed ten cards
 * at `SETTLE_MS` — and anything longer makes the column feel deaf.
 *
 * The cost is deliberate: a continuous scroll buys one card and then waits, so
 * skimming a strip of comics is the arrow keys' job (`store.stepSeq`), not the
 * wheel's. That is the trade the wheel is making, and it is the one the owner
 * asked for: the scroll lock is worth nothing if one scroll takes several days.
 */
export const LIST_GESTURE_GAP_MS = 600;

/** Whether a wheel event starts a new push, rather than continuing the last one. */
export function isNewGesture(now: number, last: number, gap = GESTURE_GAP_MS): boolean {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(last)) return true;
  return now - last > gap;
}
