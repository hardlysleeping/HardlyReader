/**
 * A sheet that is pulled up and pushed down.
 *
 * The reading options on a phone were a popover in the top corner: it appeared,
 * it covered the article, and the only way back was a press somewhere else. On
 * a phone the thing you reach for while reading should come up from the bottom
 * edge under the thumb and go back the same way it came, which is the gesture
 * the rest of this app already speaks (`pull.ts` for the top edge, the pane
 * swipe for the sides).
 *
 * The arithmetic lives here so it can be tested without a DOM: how far the sheet
 * follows the finger, how far it may be lifted past its own top, and when
 * letting go means "open" rather than "put it away".
 */

import { resist } from "./pull";

/** Letting go past this share of the sheet's own height closes it. */
export const DISMISS_FRACTION = 0.35;

/** ...or a flick, in px per millisecond, downward. */
export const DISMISS_FLICK = 0.55;

/** Lifting the sheet past its top is elastic and stops here. */
export const MAX_LIFT = 28;

/**
 * Where the sheet sits for a drag of `dy` from its resting place.
 *
 * Downward is 1:1 — the sheet belongs to the finger, so it must not lag it —
 * and capped at its own height, because dragging it past the bottom of the
 * screen is dragging nothing. Upward has nothing to reveal, so it is resisted
 * by the same curve the pull-down gesture uses and stops at `MAX_LIFT`: a small
 * elastic give that says "this is already as open as it gets".
 */
export function sheetOffset(dy: number, height: number): number {
  const span = height > 0 ? height : 0;
  if (!Number.isFinite(dy)) return 0;
  if (dy <= 0) return -Math.min(MAX_LIFT, resist(-dy));
  return Math.min(span, dy);
}

/**
 * What letting go does. A flick wins over the distance travelled — a short,
 * fast push is a dismissal even though the sheet barely moved — and the
 * fraction decides the slow drag.
 */
export function sheetSettles(
  offset: number,
  height: number,
  velocity: number,
): "open" | "dismiss" {
  if (Number.isFinite(velocity)) {
    if (velocity > DISMISS_FLICK) return "dismiss";
    if (velocity < -DISMISS_FLICK) return "open";
  }
  if (!Number.isFinite(offset)) return "open";
  if (!(height > 0)) return "open";
  return offset > height * DISMISS_FRACTION ? "dismiss" : "open";
}

/**
 * The scrim behind the sheet fades as the sheet is pushed away, so the article
 * comes back into view before the sheet has left it. Never fully opaque: the
 * thing behind a sheet is the article you are still reading.
 */
export function scrimOpacity(offset: number, height: number, peak = 0.42): number {
  if (!(height > 0)) return peak;
  const left = 1 - Math.min(1, Math.max(0, offset / height));
  return peak * left;
}
