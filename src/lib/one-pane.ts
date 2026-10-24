/**
 * The one-column walk.
 *
 * Three columns show feeds, posts and the article side by side. On one column
 * the posts screen does not exist: a feed opens its posts underneath itself in
 * the feed list, so there are two levels — the list, with one feed unfolded, and
 * the article. Back and the crumb step between those two and nothing else.
 */

export type OnePaneLevel = "feeds" | "article";

export function levelOf(selectedId: string | null): OnePaneLevel {
  return selectedId === null ? "feeds" : "article";
}

/** Where back goes from a level; `null` means there is nowhere further out. */
export function stepBackTarget(level: OnePaneLevel): "close-article" | null {
  return level === "article" ? "close-article" : null;
}

/** The bar's one-line description of where you are. */
export function whereLabel(
  level: OnePaneLevel,
  feedTitle: string,
  articleTitle: string | null,
): string {
  if (level === "feeds") return "Feeds";
  return articleTitle === null ? feedTitle : `${feedTitle} › ${articleTitle}`;
}

/** The back button's tooltip, phrased as the destination rather than the action. */
export function backLabel(level: OnePaneLevel, feedTitle: string): string {
  return level === "article" ? `Back to ${feedTitle}` : "Already at feeds";
}
