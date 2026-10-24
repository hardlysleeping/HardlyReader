/**
 * Auto-mark-read: a post becomes read only after it has been the open article
 * for long enough to have been looked at.
 *
 * The point is the *accident* case. With continuous scrolling, posts fly past;
 * marking on sight would quietly delete whatever was flipped through. Three
 * seconds of dwell means a post you merely scrolled past stays unread — and in
 * the unread view it stays in the list, because it was never marked in the
 * first place.
 *
 * This module is the policy only: no timers, no reader state, so the rule can
 * be tested without waiting three real seconds.
 */

/** How long the open article must stay open before it counts as read. */
export const AUTO_MARK_MS = 3000;

/**
 * The same delay as a setting.
 *
 * Three seconds is the default because it is long enough to see a headline go
 * past without it counting, and short enough that stopping on a post marks it
 * without a pause. The bounds exist so the number stays usable: under a second
 * would mark posts you merely flipped past, and over a minute would never fire
 * before you moved on.
 */
export const DWELL_SECONDS_DEFAULT = 3;

/** Slider range, then the range a typed value may use. See `EFFORT_HARD_*`. */
export const DWELL_SECONDS_MIN = 1;
export const DWELL_SECONDS_MAX = 30;
export const DWELL_SECONDS_HARD_MIN = 1;
export const DWELL_SECONDS_HARD_MAX = 600;

export function clampDwellSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") return DWELL_SECONDS_DEFAULT;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return DWELL_SECONDS_DEFAULT;
  const rounded = Math.round(seconds);
  return Math.min(Math.max(rounded, DWELL_SECONDS_HARD_MIN), DWELL_SECONDS_HARD_MAX);
}

/** Milliseconds for a configured number of seconds, clamped the same way. */
export function dwellMs(seconds: number): number {
  return clampDwellSeconds(seconds) * 1000;
}

/**
 * Whether the dwell timer should be armed for this article.
 *
 * Off by default: nothing is marked anything until the reader asks for it. An
 * already-read post needs no timer, and neither does the case where the reader
 * has moved on (the caller clears the timer on every change anyway).
 */
export function shouldArmDwell(options: {
  enabled: boolean;
  alreadyRead: boolean;
  isOpen: boolean;
}): boolean {
  return options.enabled && !options.alreadyRead && options.isOpen;
}

/**
 * Where to land after the open post leaves the list — which happens the moment
 * it is marked read while the list is filtered to unread.
 *
 * Forwards first: you were reading down, so the next post is the one you meant
 * to get to. Backwards only at the end of the list. Null means the stream has
 * no other post, and the caller continues into the next stream.
 */
export function successorId(
  items: readonly { id: string }[],
  currentId: string,
): string | null {
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return null;
  const after = items[index + 1];
  if (after) return after.id;
  const before = items[index - 1];
  return before ? before.id : null;
}
