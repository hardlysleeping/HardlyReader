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

/**
 * Below these a pane stops being usable: labels truncate, titles wrap to four
 * lines.
 *
 * The sidebar's 240 is the band's own floor, measured rather than guessed: two
 * equal halves around a 44px lock, with 6px gaps and the band's 8px side
 * margins, leave each half 82px at 240 — and the longest word either half can
 * hold ("Unpinned") is 56px of 10px uppercase plus 20px of padding, 78px. At the
 * old 200 the halves were 62px and the labels were already giving up their ends,
 * which is what made the band look squeezed before the rest of the sidebar was.
 */
export const MIN: Record<"sidebar" | "list" | "article", number> = {
  sidebar: 240,
  list: 260,
  article: 320,
};

export const DEFAULT_WIDTHS: PaneWidths = { sidebar: 280, list: 380 };

/**
 * The narrowest window in which each mode is honest, per device class.
 *
 * These are policy, not geometry. The geometric minimums above say a pane can
 * *exist*; these say it is still usable. Two panes at 466px technically fit
 * their minimums and leave a 34px content column, which is why the floor on a
 * desktop is 700, and three panes need 1000 rather than the 792 that would give
 * the article a strip.
 *
 * A phone in landscape is ~844px, which the desktop floor would refuse — yet
 * three narrow columns is exactly what was asked for there. So a phone gets its
 * own minimums and its own floors instead of pretending the desktop numbers
 * apply to it.
 */
export type Device = "phone" | "desktop";

export const MINIMUMS: Record<Device, Record<"sidebar" | "list" | "article", number>> = {
  desktop: MIN,
  phone: { sidebar: 150, list: 210, article: 240 },
};

export const NEEDED: Record<Device, Record<PaneMode, number>> = {
  desktop: { 1: 320, 2: 700, 3: 1000 },
  phone: { 1: 280, 2: 440, 3: 660 },
};

export function minimums(device: Device = "desktop") {
  return MINIMUMS[device];
}

export function needed(mode: PaneMode, device: Device = "desktop"): number {
  return NEEDED[device][mode];
}

/**
 * First-run mode. iPhone (and anything phone-sized) opens portrait in one
 * column and landscape in three; everything else follows the window. This is
 * only a default — the switch keeps all three available afterwards.
 */
export function defaultModeFor(input: {
  phone: boolean;
  width: number;
  height: number;
}): PaneMode {
  if (input.phone) return input.width > input.height ? 3 : 1;
  if (input.width >= 1200) return 3;
  if (input.width >= 840) return 2;
  return 1;
}

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
export function effectiveMode(
  desired: PaneMode,
  available: number,
  device: Device = "desktop",
): PaneMode {
  if (desired >= 3 && available >= NEEDED[device][3]) return 3;
  if (desired >= 2 && available >= NEEDED[device][2]) return 2;
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
export function clampWidths(
  widths: PaneWidths,
  mode: PaneMode,
  available: number,
  device: Device = "desktop",
): PaneWidths {
  const mins = MINIMUMS[device];
  const sidebarMax = Math.max(
    mins.sidebar,
    available - guttersFor(mode) - (mode >= 2 ? mins.list : 0) - (mode >= 3 ? mins.article : 0),
  );
  const sidebar = clamp(widths.sidebar, mins.sidebar, sidebarMax);
  if (mode < 2) return { sidebar, list: clamp(widths.list, mins.list, mins.list) };

  const listMax =
    mode === 3
      ? Math.max(mins.list, available - guttersFor(mode) - sidebar - mins.article)
      : Math.max(mins.list, available - guttersFor(mode) - sidebar);
  const list = clamp(widths.list, mins.list, listMax);
  return { sidebar, list };
}

/** A drag is a delta from where it started, so a fast drag cannot drift. */
export function dragPane(
  which: "sidebar" | "list",
  widths: PaneWidths,
  dx: number,
  mode: PaneMode,
  available: number,
  device: Device = "desktop",
): PaneWidths {
  const moved = { ...widths, [which]: widths[which] + dx };
  return clampWidths(moved, mode, available, device);
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
