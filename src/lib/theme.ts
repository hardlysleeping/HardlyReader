/**
 * Colours and words the user owns.
 *
 * The accents are not decoration: the tone tells you what a control *is* — red
 * is hidden, blue is pinned, yellow and orange are the lock, green is
 * sync — so the
 * meaningful ones are separately settable rather than derived from one hue.
 * `accent` is the fourth: the colour of focus, selection and "chosen" states.
 *
 * Everything here is pure. The CSS variables are produced as a plain map so a
 * test can assert the names, and the stored blob is validated field by field:
 * a half-written theme must never leave a control with `undefined` as a colour,
 * which CSS silently drops.
 */

export type ThemeMode = "dark" | "light" | "system";

export interface Theme {
  /** `system` follows the OS; the other two pin it. */
  mode: ThemeMode;
  /** Focus rings, selected rows, the "on" state of a filter. */
  accent: string;
  /**
   * Whether the lines between panes take a little of the accent.
   *
   * On, because a window with three panes is four grey lines and the accent is
   * the only thing that says they belong to one chosen theme. Off restores the
   * plain borders for anyone who wants the panels to disappear into each other.
   */
  accentEdges: boolean;
  hidden: string;
  /** The pinned mark: one blue, because there is one mark. */
  pinned: string;
  lockOpen: string;
  lockClosed: string;
  /** The unlock confirmation: green, the opposite of the red that hides. */
  unlock: string;
  /** The sync control: its glyph, its ring and its progress fill. */
  sync: string;
  /**
   * The trim: the quiet edge colour a row's end is marked with, and the colour
   * of the read toggle. Exposed rather than derived, because it is the one tone
   * that is a shade before it is a signal.
   */
  trim: string;
  /** A post's own page: the colour of the open-at-source mark. */
  link: string;
  /** The starred mark. Gold unless the theme says otherwise. */
  star: string;
  /**
   * Draw the three row actions in one quiet ink instead of their own colours.
   *
   * Colour is a signal in the rest of the app, and three coloured glyphs on
   * every row is a lot of signal for a place the eye passes through. Off by
   * default — the star, the read mark and the link say what they are — and on
   * for anyone who wants the rows to stay one grey.
   */
  monotoneActions: boolean;
  /**
   * The page itself, or `null` for the mode's own colour.
   *
   * `null` is the important case: dark and light each have a page colour that
   * was chosen to sit under their ink, and a theme that has never picked one
   * keeps following the mode instead of freezing whichever was on screen when
   * it was set. Clearing it is how you get back.
   */
  bg: string | null;
  /** A picture behind everything, already downscaled, as a data URL. */
  bgImage: string | null;
  /** How far the picture is out of focus, in px. */
  bgBlur: number;
  /** A veil of the page colour over the picture, as a percentage. */
  bgDim: number;
  /**
   * Let the panels show the page through them.
   *
   * With a picture behind it, an opaque panel is a card laid on a photo; with
   * the panels thinned and the picture already blurred, the whole window reads
   * as one surface. Off by default: text on a photograph is a reading problem
   * before it is a look.
   */
  bgGlass: boolean;
}

export const DEFAULT_THEME: Theme = {
  mode: "system",
  accent: "#0078e0",
  accentEdges: true,
  hidden: "#e5484d",
  pinned: "#0078e0",
  lockOpen: "#e6b93f",
  lockClosed: "#f08c2e",
  unlock: "#3fbf6f",
  sync: "#28a06b",
  trim: "#7c8492",
  link: "#0078e0",
  star: "#e8b93c",
  monotoneActions: false,
  bg: null,
  bgImage: null,
  bgBlur: 0,
  bgDim: 0,
  bgGlass: false,
};

/** The page each mode uses when the theme has not picked one. */
export const PAGE_COLOURS: Record<"dark" | "light", string> = {
  dark: "#0c0c0e",
  light: "#fdfdfd",
};

export const THEME_KEY = "hardlyreader.theme.v1";

export const THEME_MODES: ThemeMode[] = ["system", "dark", "light"];
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "Auto",
  dark: "Dark",
  light: "Light",
};

/** `#rgb` or `#rrggbb`, the two forms `input type="color"` can produce. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function colour(value: unknown, fallback: string): string {
  return isHexColor(value) ? value.trim().toLowerCase() : fallback;
}

export const MAX_BG_BLUR = 24;
export const MAX_BG_DIM = 60;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Reads a stored theme, keeping the default for anything missing or wrong. */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_THEME };
  const saved = raw as Record<string, unknown>;
  return {
    mode: THEME_MODES.includes(saved.mode as ThemeMode) ? (saved.mode as ThemeMode) : DEFAULT_THEME.mode,
    accent: colour(saved.accent, DEFAULT_THEME.accent),
    accentEdges: typeof saved.accentEdges === "boolean" ? saved.accentEdges : DEFAULT_THEME.accentEdges,
    hidden: colour(saved.hidden, DEFAULT_THEME.hidden),
    // Pins used to be called favourites and the key changed with the word.
    pinned: colour(saved.pinned ?? saved.favourite, DEFAULT_THEME.pinned),
    lockOpen: colour(saved.lockOpen, DEFAULT_THEME.lockOpen),
    lockClosed: colour(saved.lockClosed, DEFAULT_THEME.lockClosed),
    unlock: colour(saved.unlock, DEFAULT_THEME.unlock),
    sync: colour(saved.sync, DEFAULT_THEME.sync),
    trim: colour(saved.trim, DEFAULT_THEME.trim),
    link: colour(saved.link, DEFAULT_THEME.link),
    star: colour(saved.star, DEFAULT_THEME.star),
    monotoneActions:
      typeof saved.monotoneActions === "boolean"
        ? saved.monotoneActions
        : DEFAULT_THEME.monotoneActions,
    bg: isHexColor(saved.bg) ? saved.bg.trim().toLowerCase() : null,
    // Only an image the app itself produced: a data URL, so the stored theme
    // never points at a file that has since moved.
    bgImage:
      typeof saved.bgImage === "string" && saved.bgImage.startsWith("data:image/")
        ? saved.bgImage
        : null,
    bgBlur: clamp(saved.bgBlur, 0, MAX_BG_BLUR, DEFAULT_THEME.bgBlur),
    bgDim: clamp(saved.bgDim, 0, MAX_BG_DIM, DEFAULT_THEME.bgDim),
    bgGlass: typeof saved.bgGlass === "boolean" ? saved.bgGlass : DEFAULT_THEME.bgGlass,
  };
}

/**
 * The CSS custom properties a theme sets.
 *
 * Only the *choices* are written; the derived shades live in `app.css` as
 * `color-mix()` against these, so one colour change reaches every hover, fill
 * and glow without the app recomputing a palette in JavaScript.
 */
export function themeVariables(theme: Theme): Record<string, string> {
  return {
    "--accent": theme.accent,
    "--tone-hidden": theme.hidden,
    "--tone-pinned": theme.pinned,
    "--tone-lock-open": theme.lockOpen,
    "--tone-lock-closed": theme.lockClosed,
    "--tone-unlock": theme.unlock,
    "--tone-sync": theme.sync,
    "--tone-trim": theme.trim,
    "--tone-link": theme.link,
    // The three row actions, resolved here so the stylesheet never has to know
    // whether it is drawing in colour: one switch, three names.
    "--act-star": theme.monotoneActions ? "var(--muted)" : theme.star,
    "--act-read": theme.monotoneActions ? "var(--muted)" : theme.trim,
    "--act-link": theme.monotoneActions ? "var(--muted)" : theme.link,
    // The page: a colour the user picked, or nothing at all, so the mode's own
    // --bg stands (see state/theme.svelte.ts, which removes the property).
    ...(theme.bg ? { "--bg": theme.bg } : {}),
    "--bg-image": theme.bgImage ? `url("${theme.bgImage}")` : "none",
    "--bg-blur": `${theme.bgBlur}px`,
    "--bg-dim": (theme.bgDim / 100).toFixed(2),
    /** Panels are as solid as the theme wants them; 100% is the plain surface. */
    "--glass": theme.bgGlass ? "82%" : "100%",
    // Derived here rather than in CSS because it is a choice, not a shade:
    // `var(--border)` follows the mode, and the mix has to land on top of it.
    "--edge": theme.accentEdges ? "color-mix(in srgb, var(--accent) 24%, var(--border))" : "var(--border)",
    "--edge-soft": theme.accentEdges
      ? "color-mix(in srgb, var(--accent) 15%, var(--border-soft))"
      : "var(--border-soft)",
  };
}

/**
 * The SVG path for the pinned mark: a push pin, drawn rather than the emoji so
 * it takes the theme's colour. There is one mark, so there is one path.
 */
export const MARKER_PATH = "M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8";

export interface Words {
  /** Footer count, e.g. "Pinned 3". */
  count: string;
  /** Menu item that adds the mark. */
  add: string;
  /** Menu item that removes it. */
  remove: string;
}

export function pinWords(): Words {
  return { count: "Pinned", add: "Pin", remove: "Unpin" };
}
