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
 * The two widths the user can tune: where a second pane appears and where a
 * third does.
 *
 * One pane has no threshold of its own — it is what is left when neither of
 * these is met, and its floor (`NEEDED[device][1]`) is the smallest honest
 * single column, the same shape as a phone. That one stays fixed; these two are
 * settings because "wide enough for two" is a taste, not a law.
 */
export interface PaneThresholds {
  two: number;
  three: number;
}

export const THRESHOLDS: Record<Device, PaneThresholds> = {
  desktop: { two: NEEDED.desktop[2], three: NEEDED.desktop[3] },
  phone: { two: NEEDED.phone[2], three: NEEDED.phone[3] },
};

/**
 * What the sliders may say. The floor on "two" is a window that can hold a
 * sidebar and a list and nothing else; "three" must stay clear of "two" by
 * enough that one drag cannot make them equal and flip the layout twice.
 */
export const THRESHOLD_LIMITS = {
  two: { min: 360, max: 2000 },
  three: { min: 440, max: 2600 },
  gap: 80,
};

/** Runtime values from storage, a slider or a corrupt string, made legal. */
export function clampThresholds(
  input: Partial<PaneThresholds>,
  device: Device = "desktop",
): PaneThresholds {
  const fallback = THRESHOLDS[device];
  const whole = (value: unknown, or: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : or;
  const { min: twoMin, max: twoMax } = THRESHOLD_LIMITS.two;
  const { max: threeMax } = THRESHOLD_LIMITS.three;
  const two = Math.min(Math.max(whole(input.two, fallback.two), twoMin), twoMax);
  const three = Math.min(
    Math.max(whole(input.three, fallback.three), two + THRESHOLD_LIMITS.gap),
    threeMax,
  );
  return { two, three };
}

/**
 * The narrowest window in which a mode is honest, under the current settings.
 * This is also the width the layout switch asks the window to become.
 */
export function widthFor(
  mode: PaneMode,
  device: Device = "desktop",
  thresholds: PaneThresholds = THRESHOLDS[device],
): number {
  if (mode === 3) return thresholds.three;
  if (mode === 2) return thresholds.two;
  return NEEDED[device][1];
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
  /** The user's own thresholds, when they have any. */
  thresholds?: PaneThresholds;
}): PaneMode {
  if (input.phone) return input.width > input.height ? 3 : 1;
  const thresholds = input.thresholds ?? THRESHOLDS.desktop;
  if (input.width >= thresholds.three) return 3;
  if (input.width >= thresholds.two) return 2;
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
  thresholds: PaneThresholds = THRESHOLDS[device],
): PaneMode {
  if (desired >= 3 && available >= thresholds.three) return 3;
  if (desired >= 2 && available >= thresholds.two) return 2;
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

/**
 * `grid-template-columns` for a mode, including the gutter tracks.
 *
 * `collapsed` is the first pane folded away: its column and its seam leave the
 * template instead of being set to zero, so the grids the other panes sit in
 * keep whole columns rather than a 0px track that still reports a gutter.
 */
export function gridTemplate(mode: PaneMode, widths: PaneWidths, collapsed = false): string {
  if (mode === 3) {
    return collapsed
      ? `${widths.list}px ${GUTTER}px minmax(0, 1fr)`
      : `${widths.sidebar}px ${GUTTER}px ${widths.list}px ${GUTTER}px minmax(0, 1fr)`;
  }
  if (mode === 2) {
    return collapsed
      ? "minmax(0, 1fr)"
      : `${widths.sidebar}px ${GUTTER}px minmax(0, 1fr)`;
  }
  return "minmax(0, 1fr)";
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(Math.max(rounded, min), Math.max(min, max));
}
