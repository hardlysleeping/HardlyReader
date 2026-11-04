/**
 * The fullscreen picture viewer's arithmetic: which post, in what order, and how
 * far a drag has to travel before it closes.
 *
 * Pure, and it walks the list **as drawn** — the Unread and Starred filters
 * decide what is in the carousel, which is the rule continuous reading already
 * obeys. A post with no picture is not a frame: a slide that draws an empty box
 * says nothing, and the swipe that landed on it would read as a broken picture
 * rather than as the next post.
 *
 * The item itself travels with the frame so the viewer can star and mark read
 * through the same reader the list used, instead of a second opinion about what
 * a post is.
 */

export interface Frame<T> {
  id: string;
  url: string;
  item: T;
}

/** A downward drag this far closes the viewer, in CSS pixels. */
export const CLOSE_DRAG_PX = 80;

/** How many pictures either side of this one are asked for before they are seen. */
export const PREFETCH_RADIUS = 2;

/** The posts that have a picture, in the order the list draws them. */
export function framesOf<T extends { id: string }>(
  items: readonly T[],
  urlOf: (item: T) => string | null,
): Frame<T>[] {
  const frames: Frame<T>[] = [];
  for (const item of items) {
    const url = urlOf(item);
    if (url === null || url === "") continue;
    frames.push({ id: item.id, url, item });
  }
  return frames;
}

/**
 * A position inside a list, wrapping at both ends.
 *
 * Nothing to walk is 0 rather than NaN: an empty carousel is not a division by
 * zero anyone should have to guard at the call site.
 */
export function wrapIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  const whole = Math.trunc(index);
  return ((whole % count) + count) % count;
}

/** Where this post sits, or -1 when it has no picture and so is not in the walk. */
export function frameIndex(frames: readonly Frame<unknown>[], id: string): number {
  return frames.findIndex((frame) => frame.id === id);
}

export function frameAt<T>(frames: readonly Frame<T>[], index: number): Frame<T> | null {
  if (frames.length === 0) return null;
  return frames[wrapIndex(index, frames.length)] ?? null;
}

/**
 * The frame one step away, and where it sits.
 *
 * It wraps, because a carousel with a hard end is a list with a broken swipe:
 * the gesture that reaches the last picture should land on the first.
 */
export function stepFrame<T>(
  frames: readonly Frame<T>[],
  index: number,
  delta: number,
): { frame: Frame<T>; index: number } | null {
  const frame = frameAt(frames, index + delta);
  if (frame === null) return null;
  return { frame, index: wrapIndex(index + delta, frames.length) };
}

/** The pictures worth asking the cache for around one position, nearest first. */
export function prefetchWindow<T>(
  frames: readonly Frame<T>[],
  index: number,
  radius: number = PREFETCH_RADIUS,
): Frame<T>[] {
  if (frames.length === 0) return [];
  const at = wrapIndex(index, frames.length);
  const reach = Math.max(0, Math.trunc(radius));
  // Nearest first, and forwards before backwards on a tie: the picture the
  // reader is about to see is the one after this one, not the one behind it.
  const steps: number[] = [0];
  for (let step = 1; step <= reach; step += 1) steps.push(step, -step);

  const seen = new Set<string>();
  const window: Frame<T>[] = [];
  for (const step of steps) {
    const frame = frameAt(frames, at + step);
    if (frame === null || seen.has(frame.id)) continue;
    seen.add(frame.id);
    window.push(frame);
  }
  return window;
}

/**
 * How far a drag has gone towards closing, for the backdrop's fade.
 *
 * Only downward travel counts: pulling the picture up is a scroll inside the
 * picture, not a dismissal, so it reads as nothing.
 */
export function dragProgress(travel: number, distance: number = CLOSE_DRAG_PX): number {
  if (!Number.isFinite(travel) || travel <= 0) return 0;
  if (distance <= 0) return 1;
  return Math.min(1, travel / distance);
}

/** Whether a released drag dismisses the viewer. */
export function closesOnDrag(travel: number, distance: number = CLOSE_DRAG_PX): boolean {
  return dragProgress(travel, distance) >= 1;
}

/** One swipe step: a sideways travel of this much is the next picture. */
export const SWIPE_STEP_PX = 64;

/**
 * How many pictures a swipe travelled, in whole steps.
 *
 * Fractional swipes are not half a step: a drag that never reached the step is
 * the picture settling back, so the answer is 0 and the caller animates nothing.
 */
export function stepsForTravel(travel: number, distance: number = SWIPE_STEP_PX): number {
  if (!Number.isFinite(travel) || distance <= 0) return 0;
  return Math.trunc(Math.abs(travel) / distance);
}
