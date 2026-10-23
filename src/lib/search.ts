/**
 * Searching the sidebar.
 *
 * Titles only, by default: a feed list is something you navigate by name, and a
 * name is cheap to match — no network, no index, no waiting. Searching *inside*
 * posts is the expensive half, so it is opt-in and works off text that has been
 * extracted and cached, never off a request made as you type.
 *
 * Fuzzy, not prefix: typing "ars" should find "Ars Technica", "at" should find
 * "Ars Technica" and "Art & Design", and a typo-ish subsequence should still rank
 * below a real word start. Everything here is pure so the ranking can be argued
 * with in a test rather than by eye.
 */

/** Case- and accent-insensitive form used for matching. */
export function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[a-z0-9]/.test(text[index - 1] ?? "");
}

/**
 * How well `text` matches `query`, or null when it does not.
 *
 * Higher is better. A contiguous hit beats a scattered one, a word start beats
 * the middle of a word, and early hits beat late ones — so a feed called
 * "Art" outranks one whose letters merely appear in that order somewhere.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalise(query).trim();
  const t = normalise(text);
  if (q === "") return 0;
  if (t === "") return null;

  const direct = t.indexOf(q);
  if (direct !== -1) {
    const start = isBoundary(t, direct) ? 40 : 0;
    const whole = t === q ? 25 : 0;
    return 100 + start + whole - Math.min(direct, 40) * 0.25;
  }

  let at = 0;
  let points = 0;
  let streak = 0;
  let first = -1;
  for (const character of q) {
    const found = t.indexOf(character, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    points += 1 + (isBoundary(t, found) ? 2 : 0) + Math.min(streak, 3);
    streak = found === at ? streak + 1 : 0;
    at = found + 1;
  }
  return points - Math.min(first, 40) * 0.05;
}

/** Ranks items by their title against the query, best first. */
export function rankByFuzzy<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
): { item: T; score: number }[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, textOf(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || textOf(a.item).localeCompare(textOf(b.item)));
  return scored;
}

/**
 * Post text, flattened for matching and for storage.
 *
 * Feed HTML is markup, entities and whitespace; none of that helps a search.
 * Truncated because this is a search hint, not an archive: the first couple of
 * thousand characters of a page is enough to remember what a feed is about.
 */
export function extractText(html: string | undefined, limit = 1600): string {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, limit);
}

/**
 * A short excerpt around the match, for the result row.
 *
 * Null when the query is not in the text — the caller should not invent a
 * snippet to fill a row.
 */
export function snippetAround(text: string, query: string, radius = 70): string | null {
  const q = normalise(query).trim();
  if (q === "") return null;
  const at = normalise(text).indexOf(q);
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);
  const slice = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/** What a feed looks like to the search: an id, a name, and nothing else. */
export interface SearchableFeed {
  id: string;
  title: string;
}

export interface SearchableGroup<F extends SearchableFeed> {
  label: string;
  feeds: readonly F[];
}

/** A group that knows its own id, which is what the sidebar has. */
export interface CategorisedGroup<F extends SearchableFeed> extends SearchableGroup<F> {
  id: string;
}

/**
 * Results under the category they live in.
 *
 * The category is the frame a feed list is read in, so a search keeps it: even
 * when only a feed's name matched, its category is drawn around it holding just
 * the feeds that matched. When the category's own name is what matched, every
 * feed in it is a result — that is what asking for a category means.
 */
export interface HitGroup<F extends SearchableFeed> {
  id: string;
  label: string;
  /** Feeds in the category, matched or not: the "2 of 7" in the heading. */
  total: number;
  /** Non-null when the query matched the category's own name. */
  categoryScore: number | null;
  hits: FeedHit<F>[];
}

/** Text that has been extracted from a feed's posts, keyed by feed id. */
export interface FeedText {
  posts: readonly { id: string; title: string; text: string }[];
}

export interface FeedHit<F extends SearchableFeed> {
  feed: F;
  score: number;
  /** Why it is in the list, which decides what the row says underneath. */
  via: "title" | "category" | "text";
  postTitle?: string;
  /** Null when the match was in the title rather than the body. */
  snippet?: string | null;
}

/**
 * The feeds that match a query, best first.
 *
 * A feed can match three ways: its own name, the name of the category it sits
 * in (typing a category should show what is in it), or — only when the caller
 * supplies extracted text — something written in one of its posts. Title hits
 * outrank category hits at equal fuzzy strength because a named feed is a more
 * direct answer than a feed that happens to be inside a named category.
 */
export function searchFeeds<F extends SearchableFeed>(
  query: string,
  groups: readonly SearchableGroup<F>[],
  textIndex: Record<string, FeedText> | null = null,
): FeedHit<F>[] {
  if (normalise(query).trim() === "") return [];
  const best = new Map<string, FeedHit<F>>();

  const keep = (hit: FeedHit<F>) => {
    const current = best.get(hit.feed.id);
    if (current === undefined || hit.score > current.score) best.set(hit.feed.id, hit);
  };

  for (const group of groups) {
    const categoryScore = fuzzyScore(query, group.label);
    for (const feed of group.feeds) {
      const titleScore = fuzzyScore(query, feed.title);
      if (titleScore !== null) keep({ feed, score: titleScore, via: "title" });
      else if (categoryScore !== null) {
        keep({ feed, score: categoryScore - 5, via: "category" });
      }
    }
  }

  if (textIndex !== null) {
    const q = normalise(query).trim();
    for (const feed of groups.flatMap((group) => group.feeds)) {
      const entry = textIndex[feed.id];
      if (entry === undefined) continue;
      for (const post of entry.posts) {
        const at = normalise(post.text).indexOf(q);
        const inTitle = normalise(post.title).indexOf(q);
        if (at === -1 && inTitle === -1) continue;
        keep({
          feed,
          // Text hits rank below names: you asked for a feed list, and a post is
          // a reason to open it rather than the thing you were looking for.
          score: 60,
          via: "text",
          postTitle: post.title,
          snippet: at === -1 ? undefined : snippetAround(post.text, query),
        });
        break;
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score || a.feed.title.localeCompare(b.feed.title));
}

/**
 * The same hits, arranged under their categories.
 *
 * A feed belongs to the first category the sidebar draws it in, which is the
 * one a result row would name, so the arrangement and the tree agree. Groups
 * whose own name matched come first — asking for "Art" should not bury the Art
 * category under a feed that happens to contain those letters — then the rest by
 * their best hit. A category with no hits is not drawn at all: the results are
 * the list, not the whole tree with things greyed out.
 */
export function groupHits<F extends SearchableFeed>(
  query: string,
  hits: readonly FeedHit<F>[],
  groups: readonly CategorisedGroup<F>[],
): HitGroup<F>[] {
  const home = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const feed of group.feeds) {
      if (!home.has(feed.id)) home.set(feed.id, index);
    }
  });

  const buckets = new Map<number, FeedHit<F>[]>();
  for (const hit of hits) {
    const index = home.get(hit.feed.id);
    if (index === undefined) continue;
    const bucket = buckets.get(index) ?? [];
    bucket.push(hit);
    buckets.set(index, bucket);
  }

  const out: HitGroup<F>[] = [];
  for (const [index, bucket] of buckets) {
    const group = groups[index];
    if (group === undefined) continue;
    out.push({
      id: group.id,
      label: group.label,
      total: group.feeds.length,
      categoryScore: fuzzyScore(query, group.label),
      hits: [...bucket].sort(
        (a, b) => b.score - a.score || a.feed.title.localeCompare(b.feed.title),
      ),
    });
  }

  return out.sort((a, b) => {
    const named = Number(b.categoryScore !== null) - Number(a.categoryScore !== null);
    if (named !== 0) return named;
    const score = (b.categoryScore ?? b.hits[0]?.score ?? 0) - (a.categoryScore ?? a.hits[0]?.score ?? 0);
    if (score !== 0) return score;
    return a.label.localeCompare(b.label);
  });
}
