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

/**
 * Where ↑/↓ land in a list of posts.
 *
 * -1 means "nothing selected yet": pressing ↓ enters at the first post and ↑ at
 * the last, which is the way into the list from either end. The ends themselves
 * hold — pressing ↓ on the last post stays on it rather than wrapping to the
 * top, because a list that jumps back to the beginning looks like a lost place.
 */
export function stepIndex(count: number, at: number, delta: -1 | 1): number | null {
  if (count <= 0) return null;
  if (at < 0 || at >= count) return delta === 1 ? 0 : count - 1;
  const next = at + delta;
  return next < 0 || next >= count ? null : next;
}

export function isListView(value: unknown): value is ListView {
  return typeof value === "string" && (LIST_VIEWS as readonly string[]).includes(value);
}

/**
 * How many tiles the grid draws per row.
 *
 * `auto` is what the grid has always done — as many 132px tiles as the column
 * fits — so it stays the default and nothing moves until it is asked to.
 * A number is a promise: four means four, whatever the width, and each tile is
 * then as big as a quarter of the column can be. The count is per device, like
 * every other reading setting: four across a 2400px monitor is a wall of small
 * squares on a 700px window.
 */
export const GRID_COLUMN_CHOICES = ["auto", 2, 3, 4, 5] as const;

export type GridColumns = (typeof GRID_COLUMN_CHOICES)[number];

export const GRID_COLUMNS_DEFAULT: GridColumns = "auto";

/** The width a tile falls back to when the count is `auto`, in pixels. */
export const GRID_TILE_MIN = 132;

export function isGridColumns(value: unknown): value is GridColumns {
  return (
    typeof value === "number"
      ? (GRID_COLUMN_CHOICES as readonly (string | number)[]).includes(value)
      : typeof value === "string" && (GRID_COLUMN_CHOICES as readonly (string | number)[]).includes(value)
  );
}

/** The grid's `grid-template-columns`, given the count. */
export function gridTemplate(columns: GridColumns): string {
  if (columns === "auto") return `repeat(auto-fill, minmax(${GRID_TILE_MIN}px, 1fr))`;
  const count = Math.max(1, Math.round(columns));
  return `repeat(${count}, minmax(0, 1fr))`;
}

/** A fixed count means square tiles, so "fewer per row" reads as "bigger". */
export function gridIsSquare(columns: GridColumns): boolean {
  return columns !== "auto";
}

/**
 * How tall a card's picture is.
 *
 * Cards have always capped it at 150px; the settings are that number, smaller
 * and larger, so the default is the way it looked before anyone asked.
 */
export const CARD_SIZES = ["auto", "small", "large"] as const;

export type CardSize = (typeof CARD_SIZES)[number];

export const CARD_SIZE_DEFAULT: CardSize = "auto";

export const CARD_LEAD: Record<CardSize, number> = { auto: 150, small: 108, large: 220 };

export const CARD_SIZE_LABELS: Record<CardSize, string> = { auto: "M", small: "S", large: "L" };

export const CARD_SIZE_TITLES: Record<CardSize, string> = {
  auto: "Card pictures at their usual height",
  small: "Smaller card pictures: more cards on screen",
  large: "Larger card pictures: fewer cards on screen",
};

export function isCardSize(value: unknown): value is CardSize {
  return typeof value === "string" && (CARD_SIZES as readonly string[]).includes(value);
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
