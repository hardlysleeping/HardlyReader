/**
 * Pane geometry, as arithmetic rather than as media queries.
 *
 * The layout used to be decided by `@media` rules, so a wide window could not
 * be asked for two columns and a narrow one silently rearranged itself. Here
 * the mode is the user's choice and this module answers two questions: what can
 * actually be shown at this width, and where does a dragged gutter stop.
 */

export type PaneMode = 1 | 2 | 3;

export interface PaneWidths {
  sidebar: number;
  list: number;
}

export const GUTTER = 6;

/** Below these a pane stops being usable: labels truncate, titles wrap to four lines. */
export const MIN: Record<"sidebar" | "list" | "article", number> = {
  sidebar: 200,
  list: 260,
  article: 320,
};

export const DEFAULT_WIDTHS: PaneWidths = { sidebar: 280, list: 380 };

/**
 * The narrowest window in which each mode is honest.
 *
 * These are policy, not geometry. The geometric minimums above say a pane can
 * *exist*; these say it is still usable. Two panes at 466px technically fit
 * their minimums and leave a 34px content column, which is why the floor here
 * is 700 — the same reason three panes need 1000, not the 792 that would
 * satisfy the minimums and give the article a strip.
 */
export const NEEDED: Record<PaneMode, number> = {
  1: 320,
  2: 700,
  3: 1000,
};

/** The sum of hard minimums: what `clampWidths` can never go below. */
export function geometricMinimum(mode: PaneMode): number {
  if (mode === 3) return MIN.sidebar + GUTTER + MIN.list + GUTTER + MIN.article;
  if (mode === 2) return MIN.sidebar + GUTTER + MIN.list;
  return 0;
}

/**
 * What the window can show. The caller keeps the mode the user chose and
 * reports that it is squeezed, rather than quietly overwriting the choice.
 */
export function effectiveMode(desired: PaneMode, available: number): PaneMode {
  if (desired >= 3 && available >= NEEDED[3]) return 3;
  if (desired >= 2 && available >= NEEDED[2]) return 2;
  return 1;
}

export function guttersFor(mode: PaneMode): number {
  return mode === 3 ? GUTTER * 2 : mode === 2 ? GUTTER : 0;
}

/**
 * Keeps widths legal for the current mode and window. Called after a drag, on
 * mount (a width saved on a 27" screen must not leave a 40px article on a
 * laptop) and on resize.
 */
export function clampWidths(widths: PaneWidths, mode: PaneMode, available: number): PaneWidths {
  const sidebarMax = Math.max(
    MIN.sidebar,
    available - guttersFor(mode) - (mode >= 2 ? MIN.list : 0) - (mode >= 3 ? MIN.article : 0),
  );
  const sidebar = clamp(widths.sidebar, MIN.sidebar, sidebarMax);
  if (mode < 2) return { sidebar, list: clamp(widths.list, MIN.list, MIN.list) };

  const listMax =
    mode === 3
      ? Math.max(MIN.list, available - guttersFor(mode) - sidebar - MIN.article)
      : Math.max(MIN.list, available - guttersFor(mode) - sidebar);
  const list = clamp(widths.list, MIN.list, listMax);
  return { sidebar, list };
}

/** A drag is a delta from where it started, so a fast drag cannot drift. */
export function dragPane(
  which: "sidebar" | "list",
  widths: PaneWidths,
  dx: number,
  mode: PaneMode,
  available: number,
): PaneWidths {
  const moved = { ...widths, [which]: widths[which] + dx };
  return clampWidths(moved, mode, available);
}

/** Double-click on a gutter restores the mode's default for that pane. */
export function resetPane(which: "sidebar" | "list"): number {
  return DEFAULT_WIDTHS[which];
}

/** Keyboard resizing: 16px, or 64px with Shift. */
export function nudge(widths: PaneWidths, which: "sidebar" | "list", direction: -1 | 1, big = false): PaneWidths {
  const step = (big ? 64 : 16) * direction;
  return { ...widths, [which]: widths[which] + step };
}

/** `grid-template-columns` for a mode, including the gutter tracks. */
export function gridTemplate(mode: PaneMode, widths: PaneWidths): string {
  if (mode === 3) {
    return `${widths.sidebar}px ${GUTTER}px ${widths.list}px ${GUTTER}px minmax(0, 1fr)`;
  }
  if (mode === 2) {
    return `${widths.sidebar}px ${GUTTER}px minmax(0, 1fr)`;
  }
  return "minmax(0, 1fr)";
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(Math.max(rounded, min), Math.max(min, max));
}
