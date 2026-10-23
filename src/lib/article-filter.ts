/**
 * The global post filter for the article list.
 *
 * One setting for every stream — reading list, starred, category, single feed —
 * because "only unread" is a way of reading, not a property of one feed. It
 * filters what is already loaded: switching is instant, and it never asks the
 * server for a different list, so the cached stream and the reader's place in
 * it both survive the switch.
 *
 * Pure so the rules are inspectable without Svelte: `unread` is the absence of
 * the read state, `starred` is the starred state, `all` is everything, in the
 * order the server sent.
 */
import { isRead, isStarred, type StreamItem } from "../api/freshrss";

/** In the order the control draws them. */
export const ARTICLE_FILTERS = ["unread", "all", "starred"] as const;
export type ArticleFilter = (typeof ARTICLE_FILTERS)[number];

export const ARTICLE_FILTER_LABELS: Record<ArticleFilter, string> = {
  unread: "Unread",
  all: "All",
  starred: "Starred",
};

export function isArticleFilter(value: unknown): value is ArticleFilter {
  return typeof value === "string" && (ARTICLE_FILTERS as readonly string[]).includes(value);
}

/** The items the current filter lets through, in the server's order. */
export function filterItems(items: readonly StreamItem[], filter: ArticleFilter): StreamItem[] {
  switch (filter) {
    case "unread":
      return items.filter((item) => !isRead(item));
    case "starred":
      return items.filter((item) => isStarred(item));
    default:
      // Same array contents, new array: callers may sort or splice what they get.
      return items.slice();
  }
}
