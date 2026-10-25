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
  regular: "Rows",
  list: "Tree",
  cards: "Cards",
  grid: "Grid",
};

/**
 * What each of those four words means, in as few words as it takes — this is the
 * line under the pointer, not a paragraph, and it is the only place the views
 * are described at all.
 */
export const LIST_VIEW_TITLES: Record<ListView, string> = {
  regular: "Rows: picture, headline and byline, one post per line",
  list: "Tree: the same posts filed under their month, week and day",
  cards: "Cards: each picture above its headline, scrolled sideways",
  grid: "Grid: pictures as tiles, headline only, many at once",
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

/**
 * How a regular row's end is shaped.
 *
 * `pill` is the row as it stood: both corners on its right turn, so the row
 * stops in a half-pill and the accent runs down the edge and round the two
 * right-hand turns. `half` turns only the bottom — bottom right, and bottom left
 * to match it — and thickens the foot to the width of the right edge, so the
 * accent is one piece along the bottom and round both corners instead of a thick
 * edge beside a hairline.
 *
 * A stored choice rather than a replacement: the old shape is one press away,
 * so this can be dropped again without the look it replaced being lost.
 */
export const ROW_ENDS = ["half", "pill"] as const;

export type RowEnd = (typeof ROW_ENDS)[number];

export const ROW_END_DEFAULT: RowEnd = "half";

export function isRowEnd(value: unknown): value is RowEnd {
  return typeof value === "string" && (ROW_ENDS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
 * The turn's radius
 * ------------------------------------------------------------------------- */

/**
 * How far a row's end is rounded, in pixels.
 *
 * Zero is a square corner; thirty is the shape the rows had before this was a
 * setting; the top of the range is where a short row's end becomes a full
 * semicircle, so one slider runs from squared to round without leaving the
 * shape. Two numbers, not one: the pill turns the two right-hand corners and the
 * foot turns the two bottom ones, and liking a soft pill does not mean wanting
 * a soft foot.
 */
export const ROW_CURVE = { min: 0, max: 60, step: 2, initial: 30 } as const;

/** What each shape starts at. The pill came down with the slider. */
export const CURVE_DEFAULT: Record<RowEnd, number> = { pill: 24, half: 30 };

/**
 * Does the picture in a footed row fill the corner, or sit inside it?
 *
 * Filled, it is as tall as the row and the row's own turn cuts its lower-left
 * corner — the picture is part of the shape rather than a tile beside the text.
 * Inset, it keeps the smaller square and its own margin, level with the title.
 * Inset is what a fresh install gets: the filled corner is a shape you ask for,
 * not one you are given, and the toggle is on the bar of the view it changes.
 */
export const FLUSH_THUMB_DEFAULT = false;

/** A stored radius, or the default for a value that is not a number. */
export function clampCurve(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ROW_CURVE.initial;
  return Math.min(ROW_CURVE.max, Math.max(ROW_CURVE.min, Math.round(value)));
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
export const GRID_COLUMN_MIN = 2;
export const GRID_COLUMN_MAX = 8;

/** Where the slider sits while the grid is still `auto`. */
export const GRID_COLUMN_PREVIEW = 4;

export type GridColumns = "auto" | number;

export const GRID_COLUMNS_DEFAULT: GridColumns = "auto";

/** The width a tile falls back to when the count is `auto`, in pixels. */
export const GRID_TILE_MIN = 132;

/**
 * A count is any whole number of tiles the slider can reach.
 *
 * It used to be one of four fixed choices; a slider between two and eight means a
 * saved value can be any of those nine, and an older saved 3 or 5 is still one
 * of them, so nothing on disk has to be migrated.
 */
export function isGridColumns(value: unknown): value is GridColumns {
  if (value === "auto") return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= GRID_COLUMN_MIN &&
    value <= GRID_COLUMN_MAX
  );
}

/** The number the slider shows: the count, or where `auto` would sit. */
export function gridColumnValue(columns: GridColumns): number {
  return columns === "auto" ? GRID_COLUMN_PREVIEW : columns;
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
 * How wide a card's picture is.
 *
 * The picture is capped at a comic page's height (see `CARD_WINDOW`), so the
 * the control sets and its height follows: 340px wide is a 510px-tall page. The
 * numbers are widths, not the old 16:9 heights — a 150px-tall band cannot hold a
 * page, and a page is what the card is for.
 */
export const CARD_SIZES = ["auto", "small", "large"] as const;

export type CardSize = (typeof CARD_SIZES)[number];

export const CARD_SIZE_DEFAULT: CardSize = "auto";

/**
 * The card's picture window: the most height a picture may take, per unit of the
 * column's width. 1.5 is a 2:3 page — the shape a comic page has — so a page fills
 * the width exactly, a photograph keeps its own shorter height, and anything
 * taller than that is fitted into the window with bars either side.
 *
 * Every card draws the same window at the column's full width and fits the
 * picture inside it with `contain`, so nothing is cropped and nothing has to be
 * measured when an image decodes. S/M/L changes the window's height: a shorter
 * window makes a page smaller (contained by height, bars beside it), a taller one
 * keeps a very tall page at full width instead of shrinking it, and the default
 * is a 2:3 page filling the width exactly.
 */
export const CARD_WINDOW: Record<CardSize, number> = { auto: 1.5, small: 1.12, large: 1.9 };

export const CARD_SIZE_LABELS: Record<CardSize, string> = { auto: "M", small: "S", large: "L" };

export const CARD_SIZE_TITLES: Record<CardSize, string> = {
  auto: "Card pictures at a comic page's size",
  small: "Smaller card pictures: more cards on screen",
  large: "Larger card pictures: fewer cards on screen",
};

/**
 * The shape of a card's picture window: 5 × 7.5, the digest size a comic has
 * been printed at for decades, which is also where a page of it lands.
 *
 * The picture is fitted inside that window instead of being cropped into it, so
 * a page is whole — the card's job here is to show the post, not a slice of it.
 * A wide photograph letterboxes inside the same window rather than losing its
 * sides, because a shape that is right for one post and eats another is not a
 * shape, it is a coin toss.
 */

export function isCardSize(value: unknown): value is CardSize {
  return typeof value === "string" && (CARD_SIZES as readonly string[]).includes(value);
}

/**
 * How the cards arrange themselves: one per row, or Pinterest columns.
 *
 * This is a pick *inside* Cards rather than a fifth view. Cards is the only
 * shape whose picture can take its own aspect ratio without being cropped into
 * a square tile, and a picture at its own height is exactly what makes the
 * columns stagger — so masonry belongs here, next to S/M/L, and nowhere else.
 *
 * `rows` is the default because it is the card view that already shipped: a
 * stored value that is anything else falls back to it.
 */
export const CARD_LAYOUTS = ["rows", "masonry"] as const;

export type CardLayout = (typeof CARD_LAYOUTS)[number];

export const CARD_LAYOUT_DEFAULT: CardLayout = "rows";

/** What the one toggle in the sizer group says it will do. */
export const CARD_LAYOUT_TITLES: Record<CardLayout, string> = {
  rows: "Masonry: pictures at their own height, in columns",
  masonry: "Back to one card per row",
};

export function isCardLayout(value: unknown): value is CardLayout {
  return typeof value === "string" && (CARD_LAYOUTS as readonly string[]).includes(value);
}

/**
 * How many columns masonry draws.
 *
 * Three, and only three: two is for a phone in a narrow pane, four is for a
 * tablet held sideways, and every count between or beyond them is a worse
 * answer than the ones offered. A stored count that is not one of these falls
 * back to two.
 */
export const MASONRY_COLUMN_CHOICES = [2, 3, 4] as const;

export type MasonryColumns = (typeof MASONRY_COLUMN_CHOICES)[number];

export const MASONRY_COLUMNS_DEFAULT: MasonryColumns = 2;

/** The gutter between columns, in pixels. Also the cards' own bottom margin. */
export const MASONRY_GAP = 10;

export function isMasonryColumns(value: unknown): value is MasonryColumns {
  return (
    typeof value === "number" &&
    (MASONRY_COLUMN_CHOICES as readonly number[]).includes(value)
  );
}

/** A stored or clicked column count, made usable: anything else is the default. */
export function masonryColumns(value: unknown): MasonryColumns {
  return isMasonryColumns(value) ? value : MASONRY_COLUMNS_DEFAULT;
}

/**
 * The `columns` value the container is given, as a string.
 *
 * A string rather than a number because it travels as a CSS custom property,
 * and `columns: 3` needs a count, not a length in pixels.
 */
export function masonryTrack(value: unknown): string {
  return String(masonryColumns(value));
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


