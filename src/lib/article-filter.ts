/**
 * The global post filter for the article list.
 *
 * Two independent switches rather than one of four choices: `read` says which
 * half of the read state to show (unread, read, or neither), and `star` says
 * the same for the star. Each is a three-state toggle — a press moves it one
 * step round and the third state is "off", which filters nothing — so the two
 * combine instead of replacing one another, and "unread starred posts" is a
 * state the control can reach.
 *
 * One setting for every stream — reading list, starred, category, single feed —
 * because "only unread" is a way of reading, not a property of one feed. It
 * filters what is already loaded: switching is instant, and it never asks the
 * server for a different list, so the cached stream and the reader's place in
 * it both survive the switch.
 *
 * Pure so the rules are inspectable without Svelte.
 */
import { isRead, isStarred, type StreamItem } from "../api/freshrss";
import { authorNameOf } from "./people";

/**
 * The read half, in the order a press walks it: off, unread, read.
 *
 * `off` is the default — a filter that hides posts on first launch would look
 * like a feed that had lost them — and `read` is the exact other half of
 * `unread`, so a feed with nothing new is one press from showing what it has.
 */
export const READ_FILTERS = ["off", "unread", "read"] as const;
export type ReadFilter = (typeof READ_FILTERS)[number];

/**
 * The star half, walked the same way: off, not favourited, favourited.
 *
 * `unstarred` comes first because it is the quieter half: the reader reaches for
 * the star to see favourites, and passing through "what I have not marked" on
 * the way costs one press rather than landing on it.
 */
export const STAR_FILTERS = ["off", "unstarred", "starred"] as const;
export type StarFilter = (typeof STAR_FILTERS)[number];

/**
 * Nothing is filtered until the reader says so: both switch starts off, because
 * the app opens on the whole list — a first launch that silently hid posts would
 * read as a feed that lost them, and the choice is remembered from there on.
 */
export const READ_FILTER_DEFAULT: ReadFilter = "off";
export const STAR_FILTER_DEFAULT: StarFilter = "off";

/** Both halves at once: what the list is filtered by, everywhere. */
export interface ArticleFilter {
  read: ReadFilter;
  star: StarFilter;
}

export const FILTER_OFF: ArticleFilter = { read: "off", star: "off" };

/** The words a screen reader hears, and the words a narrow list quotes. */
export const READ_FILTER_LABELS: Record<ReadFilter, string> = {
  off: "All posts",
  unread: "Unread",
  read: "Read",
};

/**
 * The star half in the reader's words.
 *
 * It is a favourite: "starred" is the server's name for the state, not the
 * reader's, and "Favourites" is free again now that a pinned feed is called
 * pinned — the two used to be one word and were read as one thing.
 */
export const STAR_FILTER_LABELS: Record<StarFilter, string> = {
  off: "All posts",
  starred: "Favourites",
  unstarred: "Not favourited",
};

/**
 * What each button says in its title: what is showing now, and what the next
 * press asks for.
 *
 * There is one button per switch, so the words have to carry both facts — the
 * button is never labelled for a state it is not in — and the third press lands
 * back on everything rather than on a fourth control that says "All".
 */
export const READ_FILTER_TITLES: Record<ReadFilter, string> = {
  off: "Showing every post — press for unread",
  unread: "Showing unread posts — press for read",
  read: "Showing read posts — press for every post",
};

export const STAR_FILTER_TITLES: Record<StarFilter, string> = {
  off: "Showing every post — press for not favourited",
  unstarred: "Showing posts you have not favourited — press for favourites",
  starred: "Showing favourite posts — press for every post",
};

export function isReadFilter(value: unknown): value is ReadFilter {
  return typeof value === "string" && (READ_FILTERS as readonly string[]).includes(value);
}

export function isStarFilter(value: unknown): value is StarFilter {
  return typeof value === "string" && (STAR_FILTERS as readonly string[]).includes(value);
}

/**
 * What one press on the read switch asks for: the next state in its own order.
 *
 * The cycle is the whole control — off, unread, read, off — so there is no
 * "All" button beside it and no second pill competing for the same question.
 * A value that is not a state (an old build's, or a corrupted blob) restarts at
 * off rather than throwing.
 */
export function nextReadFilter(filter: ReadFilter): ReadFilter {
  const index = READ_FILTERS.indexOf(filter);
  if (index === -1) return "off";
  return READ_FILTERS[(index + 1) % READ_FILTERS.length] ?? "off";
}

/** The star switch, walked the same way: off, not favourited, favourited. */
export function nextStarFilter(filter: StarFilter): StarFilter {
  const index = STAR_FILTERS.indexOf(filter);
  if (index === -1) return "off";
  return STAR_FILTERS[(index + 1) % STAR_FILTERS.length] ?? "off";
}

/** True when neither half is filtering. */
export function isFilterOff(filter: ArticleFilter): boolean {
  return filter.read === "off" && filter.star === "off";
}

/** The words for what is on, for an empty list that has to explain itself. */
export function filterWords(filter: ArticleFilter): string {
  const words = [
    filter.read === "off" ? null : READ_FILTER_LABELS[filter.read],
    filter.star === "off" ? null : STAR_FILTER_LABELS[filter.star],
  ].filter((word): word is string => word !== null);
  return words.length === 0 ? "everything" : words.join(" · ");
}

/** The items the current filter lets through, in the server's order. */
export function filterItems(items: readonly StreamItem[], filter: ArticleFilter): StreamItem[] {
  return items.filter((item) => {
    if (filter.read === "unread" && isRead(item)) return false;
    if (filter.read === "read" && !isRead(item)) return false;
    if (filter.star === "starred" && !isStarred(item)) return false;
    if (filter.star === "unstarred" && isStarred(item)) return false;
    return true;
  });
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
