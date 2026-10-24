/**
 * Continuous reading: the order a reader walks through when an article is open
 * and they keep going.
 *
 * Streams come in sidebar order (Reading list, Starred, then each category's
 * feeds in the order shown), and items in the order the list shows them. Only
 * loaded items are in the order — the list's own Load more is what extends a
 * page, and this module never invents posts it has not been given.
 */

export interface OrderItem {
  id: string;
}

export interface OrderStream {
  id: string;
  title: string;
  items: readonly OrderItem[];
}

export type Position = { streamId: string; itemId: string };

export type Step =
  | { kind: "item"; streamId: string; streamTitle: string; itemId: string }
  | { kind: "stream"; streamId: string; streamTitle: string; direction: -1 | 1 }
  | { kind: "end" };

export interface FlatEntry extends Position {
  streamTitle: string;
  index: number;
}

/** The whole reading order, in one array. Used for tests and for the article counter. */
export function flatten(order: readonly OrderStream[]): FlatEntry[] {
  const entries: FlatEntry[] = [];
  for (const stream of order) {
    for (const item of stream.items) {
      entries.push({
        streamId: stream.id,
        streamTitle: stream.title,
        itemId: item.id,
        index: entries.length,
      });
    }
  }
  return entries;
}

/**
 * The next (or previous) thing to show.
 *
 * Inside a stream this is just the neighbouring item. At the end of a stream it
 * asks the caller to open the neighbouring stream — the caller owns loading and
 * error handling, because a failed fetch must leave the open article alone
 * rather than moving to a blank pane.
 */
export function step(
  order: readonly OrderStream[],
  from: Position | null,
  direction: -1 | 1,
): Step {
  const streams = order.filter((s) => s.items.length > 0);
  if (streams.length === 0) return { kind: "end" };

  if (from === null) {
    const first = direction === 1 ? streams[0] : streams[streams.length - 1];
    const item = direction === 1 ? first.items[0] : first.items[first.items.length - 1];
    return { kind: "item", streamId: first.id, streamTitle: first.title, itemId: item.id };
  }

  const streamIndex = streams.findIndex((s) => s.id === from.streamId);
  if (streamIndex === -1) {
    // The open article's stream vanished (feed removed, hidden filter changed).
    // Falling back to the first item is honest; guessing a neighbour is not.
    const first = streams[0];
    return { kind: "item", streamId: first.id, streamTitle: first.title, itemId: first.items[0].id };
  }

  const current = streams[streamIndex];
  const itemIndex = current.items.findIndex((i) => i.id === from.itemId);
  const neighbour = itemIndex + direction;
  if (itemIndex !== -1 && neighbour >= 0 && neighbour < current.items.length) {
    return {
      kind: "item",
      streamId: current.id,
      streamTitle: current.title,
      itemId: current.items[neighbour].id,
    };
  }

  const nextStream = streams[streamIndex + direction];
  if (!nextStream) return { kind: "end" };
  return { kind: "stream", streamId: nextStream.id, streamTitle: nextStream.title, direction };
}

/**
 * Where to land after a stream has been opened for a handover: the first item in
 * the direction of travel, or the last one when reading backwards.
 */
export function landingItem(
  stream: OrderStream,
  direction: -1 | 1,
): string | null {
  if (stream.items.length === 0) return null;
  return direction === 1 ? stream.items[0].id : stream.items[stream.items.length - 1].id;
}
