/**
 * Feeds into the groups a sidebar draws, for an account that is not on screen.
 *
 * `reader.allCategories` builds this from the account being read, with the hidden
 * set, the pins and the drag order applied — all of which belong to one account and
 * one window's own keys. A second account's rows need the plain arrangement its
 * server sent: what label each feed carries, in the order the account lists them.
 * Deliberately no hiding, no pinning, no reordering, because none of those answers
 * are this window's to make for an account it is not reading.
 *
 * The shape matches `CategoryGroup` in the reader, so a caller can pass either.
 */
import type { Subscription } from "../api/freshrss";

export interface FeedGroup {
  id: string;
  label: string;
  feeds: Subscription[];
}

/** The label a feed lands under when its server gave it none. */
export const UNCATEGORIZED_ID = "user/-/label/Uncategorized";
export const UNCATEGORIZED_LABEL = "Uncategorized";

/**
 * One group per label, in the order the feeds arrived, each label's feeds in that
 * same order. A feed with no category goes to "Uncategorized" rather than being
 * dropped: a feed that exists and cannot be drawn is a feed the reader cannot reach.
 */
export function groupFeedList(feeds: readonly Subscription[]): FeedGroup[] {
  const groups = new Map<string, FeedGroup>();
  for (const feed of feeds) {
    const labels =
      feed.categories !== undefined && feed.categories.length > 0
        ? feed.categories
        : [{ id: UNCATEGORIZED_ID, label: UNCATEGORIZED_LABEL }];
    for (const category of labels) {
      const group = groups.get(category.id) ?? { id: category.id, label: category.label, feeds: [] };
      group.feeds.push(feed);
      groups.set(category.id, group);
    }
  }
  return [...groups.values()];
}

/** How many feeds a set of groups draws once, without counting a feed twice. */
export function countFeeds(groups: readonly FeedGroup[]): number {
  const seen = new Set<string>();
  for (const group of groups) for (const feed of group.feeds) seen.add(feed.id);
  return seen.size;
}
