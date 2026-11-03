/**
 * Which feeds' last page is worth keeping on this device.
 *
 * The write queue (`api/offline`) was built for decisions a reader makes and a
 * server can be told later. Going *into* the app with no network is the other
 * half: a feed that was never opened in this session has nothing to draw, so
 * tapping it on a train offers a spinner and then an error, which reads as the
 * app being broken rather than as the network being absent.
 *
 * This module is the arithmetic of fixing that, and nothing else: no requests,
 * no storage, no clock of its own. Give it the feeds, what is already kept, and
 * the time, and it answers which feeds are worth a request now. The reading side
 * turns the answer into requests (`ReaderState.warmOfflineCopy`) and keeps the
 * stamps; a suite runs the arithmetic with a `Map` and a number.
 *
 * Three rules, all of them about traffic:
 *
 * 1. **A feed that was kept recently is not asked again.** The same feed on every
 *    sync is a subscription's worth of requests for a page nobody has read.
 * 2. **A small page, not the stream's first page.** A page of fifty is the list
 *    the reader sees when they open a feed; eight is what they need to *start*
 *    reading on a train. Fetching fifty for every feed would be the app spending
 *    a reader's data for posts they may never see.
 * 3. **A ceiling on how many feeds one pass touches.** Twenty feeds is a change
 *    nobody notices; three hundred is a burst that a small server feels.
 */

/** What one pass keeps, and how long a kept feed is good for. */
export interface OfflineCopyPlan {
  /** Posts kept per feed. Small on purpose: enough to start reading. */
  perFeed: number;
  /** The most feeds one pass will fetch for. */
  maxFeeds: number;
  /** How old a kept feed must be before it is worth fetching again. */
  staleMs: number;
}

export const OFFLINE_COPY: OfflineCopyPlan = {
  perFeed: 8,
  maxFeeds: 20,
  staleMs: 12 * 60 * 60 * 1000,
};

/**
 * The feeds to fetch for, most stale first, and never more than the ceiling.
 *
 * A feed with no stamp has never been kept, so it is the stalest thing there is:
 * `missing` sorts before every age. Ties keep the order they arrived in, which is
 * the sidebar's, so a reader's own arrangement decides what gets kept when the
 * ceiling cuts the list short.
 */
export function feedsToWarm(
  feedIds: readonly string[],
  stamps: ReadonlyMap<string, number>,
  now: number,
  plan: OfflineCopyPlan = OFFLINE_COPY,
): string[] {
  const wanted: { id: string; age: number }[] = [];
  for (const id of feedIds) {
    if (id === "") continue;
    const at = stamps.get(id);
    const age = at === undefined ? Number.POSITIVE_INFINITY : now - at;
    if (age < plan.staleMs) continue;
    wanted.push({ id, age });
  }
  // Infinity minus Infinity is NaN, so equal-age ties are broken by the sort's
  // stability rather than arithmetic: the comparator has to answer 0.
  wanted.sort((left, right) => {
    if (left.age === right.age) return 0;
    return right.age > left.age ? 1 : -1;
  });
  return wanted.slice(0, Math.max(0, plan.maxFeeds)).map((entry) => entry.id);
}

/**
 * What a previous launch left behind, read for what it can be trusted for.
 *
 * Stored as `{ feedId: timestamp }`; anything else — a string, a list, a number,
 * a hand-edited value — reads as "nothing is kept", which costs requests rather
 * than correctness. A stamp in the future is clamped to now: a device clock that
 * went backwards must not stop the copy from ever updating again.
 */
export function parseKept(raw: string | null, now: number): Map<string, number> {
  const kept = new Map<string, number>();
  if (raw === null || raw === "") return kept;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return kept;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return kept;
  for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (id === "" || typeof at !== "number" || !Number.isFinite(at)) continue;
    kept.set(id, Math.min(at, now));
  }
  return kept;
}

/** The stamps as they are written back, with the ceiling applied. */
export function serializeKept(kept: ReadonlyMap<string, number>, plan: OfflineCopyPlan = OFFLINE_COPY): string {
  // Newest first, then trimmed: an account that lost feeds must not carry their
  // stamps forever in a key that is read on every launch.
  const entries = [...kept.entries()].sort((left, right) => right[1] - left[1]);
  return JSON.stringify(Object.fromEntries(entries.slice(0, Math.max(plan.maxFeeds * 4, 40))));
}

/**
 * A feed's page as the posts list wants it, from what the server just answered.
 *
 * Kept as a function so the *same* page is what gets written to disk and what a
 * suite checks: the reader stores `items` and `continuation` together, and a
 * continuation without its items is a feed that opens half empty.
 */
export function keptPage<T>(items: readonly T[], continuation: string | undefined): {
  items: T[];
  continuation: string | undefined;
} {
  return { items: [...items], continuation };
}
