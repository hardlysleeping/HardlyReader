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
import { authorNameOf } from "./people";

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

/**
 * The posts one author wrote, in the order they arrived.
 *
 * A filter over what is loaded, like the one above it: no request, no re-sort.
 * The name a post is filed under comes from `authorNameOf` — the same judgement
 * the author index was built with — so a filtered list cannot disagree with the
 * row that filtered it, and a post carrying only its feed's name is never
 * offered as that feed's author. Matching is case-insensitive because the index
 * de-duplicates that way; `null` (or blank) is no filter at all, not "the posts
 * with no author".
 */
export function filterByAuthor(items: readonly StreamItem[], author: string | null): StreamItem[] {
  const wanted = author === null ? "" : author.trim().toLocaleLowerCase();
  if (wanted === "") return items.slice();
  return items.filter((item) => authorNameOf(item).toLocaleLowerCase() === wanted);
}
