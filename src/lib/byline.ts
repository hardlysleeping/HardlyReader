/**
 * Who wrote a post, as the list should say it.
 *
 * The list used to show the feed's title on the byline for everything, which
 * reads as the author's name — a blog called "Ada Lovelace" and a post by
 * someone else both looked like they were by whoever the feed is named after.
 * The reader pane has always shown the item's own `author` beside the feed; this
 * is the same answer for the row, with the feed title kept as the fallback,
 * because a feed that publishes no author still has to say where the post came
 * from.
 *
 * Pure, so the rule can be checked without a DOM.
 */

export interface BylineSource {
  author?: string;
  origin?: { title?: string };
}

/** The name to put on the row, or an empty string when neither is known. */
export function bylineOf(item: BylineSource): string {
  const author = clean(item.author);
  const feed = clean(item.origin?.title);
  if (author !== "" && !same(author, feed)) return author;
  return feed !== "" ? feed : author;
}

/**
 * The sentence for the tooltip: both names when they differ, because a row can
 * only show one of them and the other is still worth knowing.
 */
export function bylineTitle(item: BylineSource): string {
  const author = clean(item.author);
  const feed = clean(item.origin?.title);
  if (author !== "" && feed !== "" && !same(author, feed)) return `${author} — ${feed}`;
  return bylineOf(item);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function same(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** The feed's own name, or an empty string when the item does not carry one. */
export function feedNameOf(item: BylineSource): string {
  return clean(item.origin?.title);
}

/** The post's own author, or an empty string when the feed publishes none. */
export function authorOf(item: BylineSource): string {
  return clean(item.author);
}
