/**
 * Colours and words the user owns.
 *
 * The accents are not decoration: the tone tells you what a control *is* — red
 * is hidden, blue is favourite/pin, yellow and orange are the lock — so the
 * meaningful ones are separately settable rather than derived from one hue.
 * `accent` is the fourth: the colour of focus, selection and "chosen" states.
 *
 * Everything here is pure. The CSS variables are produced as a plain map so a
 * test can assert the names, and the stored blob is validated field by field:
 * a half-written theme must never leave a control with `undefined` as a colour,
 * which CSS silently drops.
 */

export type ThemeMode = "dark" | "light" | "system";
export type Marker = "pin" | "star";
export type Vocabulary = "pinned" | "favourites";

export interface Theme {
  /** `system` follows the OS; the other two pin it. */
  mode: ThemeMode;
  /** Focus rings, selected rows, the "on" state of a filter. */
  accent: string;
  hidden: string;
  favourite: string;
  lockOpen: string;
  lockClosed: string;
  /** Glyph for a pinned row. */
  marker: Marker;
  /** What a pin is called: the app's own word, or the extension's. */
  vocabulary: Vocabulary;
}

export const DEFAULT_THEME: Theme = {
  mode: "system",
  accent: "#0078e0",
  hidden: "#e5484d",
  favourite: "#0078e0",
  lockOpen: "#e6b93f",
  lockClosed: "#f08c2e",
  marker: "pin",
  vocabulary: "pinned",
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

/** Reads a stored theme, keeping the default for anything missing or wrong. */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_THEME };
  const saved = raw as Record<string, unknown>;
  return {
    mode: THEME_MODES.includes(saved.mode as ThemeMode) ? (saved.mode as ThemeMode) : DEFAULT_THEME.mode,
    accent: colour(saved.accent, DEFAULT_THEME.accent),
    hidden: colour(saved.hidden, DEFAULT_THEME.hidden),
    favourite: colour(saved.favourite, DEFAULT_THEME.favourite),
    lockOpen: colour(saved.lockOpen, DEFAULT_THEME.lockOpen),
    lockClosed: colour(saved.lockClosed, DEFAULT_THEME.lockClosed),
    marker: saved.marker === "star" ? "star" : "pin",
    vocabulary: saved.vocabulary === "favourites" ? "favourites" : "pinned",
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
    "--tone-favourite": theme.favourite,
    "--tone-lock-open": theme.lockOpen,
    "--tone-lock-closed": theme.lockClosed,
  };
}

/** The SVG path for the row marker. */
export const MARKER_PATH: Record<Marker, string> = {
  // A push pin, drawn rather than the emoji, so it takes the theme's colour.
  pin: "M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8",
  // The same five points the starred list already uses.
  star: "M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z",
};

export interface Words {
  /** Footer count, e.g. "Pinned 3". */
  count: string;
  /** Menu item that adds the mark. */
  add: string;
  /** Menu item that removes it. */
  remove: string;
  /** How the server-backed extension favourite is labelled when the local mark
   * has taken the word "favourite" for itself. */
  server: string;
}

export function pinWords(vocabulary: Vocabulary): Words {
  return vocabulary === "favourites"
    ? { count: "Favourites", add: "Favourite", remove: "Unfavourite", server: "Favourite (synced)" }
    : { count: "Pinned", add: "Pin", remove: "Unpin", server: "Favourite" };
}
