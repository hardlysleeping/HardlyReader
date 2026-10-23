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
