/**
 * How the posts column draws itself: four shapes, one setting.
 *
 * The point of the four is that they answer different questions about the same
 * list — `regular` is the tuned row (dot, title, two lines of preview, byline,
 * picture on the side), `list` fits twice as many headlines into the same
 * height, `cards` gives the picture room and `grid` scans a wall of them at
 * once. They are not four code paths: one row is drawn, and the view decides
 * which parts of it are shown and how it is arranged.
 *
 * Starring and marking read are not part of the view. Every shape offers both,
 * because a shape you cannot act in is a shape you have to leave to use.
 */

export const LIST_VIEWS = ["regular", "list", "cards", "grid"] as const;

export type ListView = (typeof LIST_VIEWS)[number];

/** The tuned row: the one that was there before the choice existed. */
export const LIST_VIEW_DEFAULT: ListView = "regular";

export const LIST_VIEW_LABELS: Record<ListView, string> = {
  regular: "Regular",
  list: "List",
  cards: "Cards",
  grid: "Grid",
};

/** Longer wording for the tooltip, so the pill stays short. */
export const LIST_VIEW_TITLES: Record<ListView, string> = {
  regular: "Regular rows: preview, byline and the feed's picture",
  list: "One line per post: headline, feed and time",
  cards: "Cards: the picture above the headline, one per row",
  grid: "Grid: tiles side by side, headline only",
};

export function isListView(value: unknown): value is ListView {
  return typeof value === "string" && (LIST_VIEWS as readonly string[]).includes(value);
}

/** Two lines of the post body: the shapes that have room for them. */
export function showsPreview(view: ListView): boolean {
  return view === "regular" || view === "cards";
}

/**
 * Where the picture sits in each shape: beside the row, above the text, above
 * the tile, or nowhere. `regular` is the only one that honours the left/right
 * setting — the other two are vertical by definition.
 */
export function picturePlacement(view: ListView): "side" | "top" | "none" {
  if (view === "regular") return "side";
  if (view === "cards" || view === "grid") return "top";
  return "none";
}
