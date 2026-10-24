/**
 * The sidebar arrangement, as a document that can travel.
 *
 * Two lists, the same two the app keeps: the order the categories were dragged
 * into and the order the feeds were dragged into. Ids, never labels — a renamed
 * category must not lose its place.
 *
 * The server keeps one copy per account (`GET`/`PUT /v1/positions`), so the
 * arrangement follows the user to another device. Local storage stays the render
 * source: it is what the sidebar reads, and the server copy is what makes a
 * second device agree. That ordering is deliberate — the app must work with an
 * adapter that predates this route, and a drag must never wait for a round trip
 * to look like it worked.
 *
 * Pure: merging and stamping are testable without a network or a DOM.
 */

export interface Positions {
  /** When the arrangement was last changed, in ms. Decides which copy wins. */
  updatedAt: number;
  /** Category ids, top to bottom. */
  categories: string[];
  /** Feed ids, in the order they were dragged. */
  feeds: string[];
}

export const EMPTY_POSITIONS: Positions = { updatedAt: 0, categories: [], feeds: [] };

/** True when two arrangements say the same thing, timestamps aside. */
export function samePositions(a: Positions, b: Positions): boolean {
  return sameList(a.categories, b.categories) && sameList(a.feeds, b.feeds);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/**
 * Which copy to keep.
 *
 * The newer stamp wins, and only the newer one: a device that has been offline
 * must not overwrite an arrangement made since, which is the same rule the
 * server enforces on the write. A tie goes to the local copy, because it is the
 * one the user is looking at.
 */
export function mergePositions(
  local: Positions,
  remote: Positions,
): { positions: Positions; source: "local" | "remote" } {
  if (remote.updatedAt > local.updatedAt) return { positions: remote, source: "remote" };
  return { positions: local, source: "local" };
}

/**
 * The stamp to write with.
 *
 * Strictly greater than the previous one even if the clock has not ticked (or
 * has gone backwards), so two drags in the same millisecond are two writes, not
 * one that is refused as stale.
 */
export function nextStamp(previous: number, now: number = Date.now()): number {
  return Math.max(Math.round(now), Math.round(previous) + 1);
}

/** Reads whatever the wire or storage held, discarding anything malformed. */
export function parsePositions(raw: unknown): Positions {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_POSITIONS, categories: [], feeds: [] };
  const value = raw as Record<string, unknown>;
  const list = (entries: unknown): string[] =>
    Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [];
  const stamp = value.updatedAt;
  return {
    updatedAt: typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
    categories: list(value.categories),
    feeds: list(value.feeds),
  };
}

/** The body a write sends: the two lists and the stamp that orders them. */
export function positionsBody(positions: Positions): Record<string, unknown> {
  return {
    updatedAt: positions.updatedAt,
    categories: [...positions.categories],
    feeds: [...positions.feeds],
  };
}
