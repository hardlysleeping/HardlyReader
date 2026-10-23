/**
 * Continuous reading walks the sidebar: past the last post of the last feed it
 * comes round to the first feed again, and above the first it wraps to the
 * last. It only stops when the whole loop has no post left to show — which, in
 * practice, is the unread view when the account is cleared.
 *
 * The wrapping arithmetic lives here, away from the loading, so the rule can be
 * read and tested without a server: "the next feed" is `+1 mod n`, and "nothing
 * anywhere" is n failed candidates, never an unbounded search.
 */

export interface CycleStep {
  /** Index into the stream list, or null when there is nothing to try. */
  index: number | null;
  /** How many streams were passed over to reach it (1 = the immediate neighbour). */
  hops: number;
}

/**
 * Index `hops` away in `direction`, wrapping. Null only for an empty list.
 *
 * `index` below zero means "not in the list", which is treated as starting
 * just before the first entry going forward and just after it going back.
 */
export function cycleIndex(
  length: number,
  index: number,
  direction: -1 | 1,
  hops = 1,
): number | null {
  if (length <= 0 || hops <= 0) return null;
  const base = index >= 0 && index < length ? index : direction === 1 ? -1 : 0;
  return (((base + direction * hops) % length) + length) % length;
}

/**
 * The order in which to try streams: the neighbours outwards, wrapping, with
 * the current one last.
 *
 * Returning after a full lap lets the caller stop on a definite "n streams
 * tried" instead of looping forever when every feed is empty in this view.
 */
export function attemptOrder(length: number, index: number, direction: -1 | 1): number[] {
  if (length <= 0) return [];
  const order: number[] = [];
  for (let hops = 1; hops <= length; hops++) {
    const at = cycleIndex(length, index, direction, hops);
    if (at === null) break;
    if (at === index) continue;
    order.push(at);
  }
  return order;
}
