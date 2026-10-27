/**
 * The app's own feed order.
 *
 * FreshRSS has no order for the feeds inside a category — it hands them back in
 * whatever order its own query produced, and the website lets you sort by name
 * or by unread count, never by hand. Dragging a feed is therefore an app-local
 * arrangement: it is kept per account on this device and never sent anywhere.
 *
 * Category *membership* is different. A feed belongs to a category on the
 * server, and pretending otherwise would show one thing here and another on the
 * website the moment the sidebar reloads. Moving a feed to another category is
 * a real edit; only the position inside a category is local.
 *
 * Kept pure so the ordering rules can be tested without a browser.
 */

/** Where a feed sits in the arrangement. Unknown feeds sort after known ones. */
export function orderIndex(order: readonly string[], streamId: string): number {
  const index = order.indexOf(streamId);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * Sorts one category's feeds by the arrangement, leaving anything the user has
 * never dragged in the order the server sent it.
 */
export function sortByOrder<T extends { id: string }>(feeds: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...feeds];
  return [...feeds].sort((left, right) => {
    const a = orderIndex(order, left.id);
    const b = orderIndex(order, right.id);
    if (a === b) return 0;
    return a - b;
  });
}

/**
 * Puts `moving` before `before` (or at the end when `before` is null) and drops
 * any earlier entry for it, so dragging the same feed twice cannot leave it in
 * two places.
 */
export function moveInOrder(
  order: readonly string[],
  moving: string,
  before: string | null,
): string[] {
  const next = order.filter((id) => id !== moving);
  const at = before === null ? -1 : next.indexOf(before);
  if (at === -1) {
    next.push(moving);
  } else {
    next.splice(at, 0, moving);
  }
  return next;
}

/**
 * The `before` id that expresses "after this feed", so a drop below a row and a
 * drop above the next row are the same instruction.
 */
export function beforeAfter(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  if (index === -1) return null;
  return ids[index + 1] ?? null;
}

/** True when the drop would not change anything: same feed, same slot. */
export function isNoopDrop(
  order: readonly string[],
  moving: string,
  before: string | null,
): boolean {
  if (moving === before) return true;
  const current = order.filter((id) => id !== moving);
  const at = before === null ? -1 : current.indexOf(before);
  const target = [...current];
  if (at === -1) target.push(moving);
  else target.splice(at, 0, moving);
  return order.length === target.length && order.every((id, index) => id === target[index]);
}

/**
 * What a finished category move says.
 *
 * A move is drawn before it is written, so the sidebar shows the new folder the
 * instant the drag ends — the one fact it cannot show is whether the account
 * took it, which is why this line says "synced" and not just "moved". A null
 * target is Uncategorized, because that is the absence of a label rather than a
 * label with that name.
 */
export function moveNotice(title: string, to: string | null): string {
  const name = title.trim() === "" ? "Feed" : title.trim();
  const where = to === null || to.trim() === "" ? "Uncategorized" : to.trim();
  return `Moved ${name} to ${where} — synced`;
}
