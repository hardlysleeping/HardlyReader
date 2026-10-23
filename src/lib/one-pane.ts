/**
 * The one-column walk.
 *
 * Three columns show feeds, posts and the article side by side. On one column
 * they are three screens stacked in that order, and navigation has to move
 * between them the way the panes sit: one step at a time, out and back. Jumping
 * from an article straight to the feed list skips a screen the reader was just
 * looking at, which feels like the app losing their place — so this module owns
 * the step, and nothing else decides it.
 */

export type OnePaneLevel = "feeds" | "posts" | "article";

export function levelOf(selectedId: string | null, showingPosts: boolean): OnePaneLevel {
  if (selectedId !== null) return "article";
  return showingPosts ? "posts" : "feeds";
}

/** Where back goes from a level; `null` means there is nowhere further out. */
export function stepBackTarget(level: OnePaneLevel): "close-article" | "show-feeds" | null {
  switch (level) {
    case "article":
      return "close-article";
    case "posts":
      return "show-feeds";
    case "feeds":
      return null;
  }
}

/** The bar's one-line description of where you are. */
export function whereLabel(
  level: OnePaneLevel,
  streamTitle: string,
  articleTitle: string | null,
): string {
  if (level === "feeds") return "Feeds";
  if (level === "posts") return streamTitle;
  return articleTitle === null ? streamTitle : `${streamTitle} › ${articleTitle}`;
}

/** The back button's tooltip, phrased as the destination rather than the action. */
export function backLabel(level: OnePaneLevel, streamTitle: string): string {
  if (level === "article") return `Back to ${streamTitle}`;
  if (level === "posts") return "Back to feeds";
  return "Already at feeds";
}
