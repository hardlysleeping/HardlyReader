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
  /** Where the "1" button takes the window: its own floor, and now a setting. */
  one: number;
  two: number;
  three: number;
}

export const THRESHOLDS: Record<Device, PaneThresholds> = {
  desktop: { one: NEEDED.desktop[1], two: NEEDED.desktop[2], three: NEEDED.desktop[3] },
  phone: { one: NEEDED.phone[1], two: NEEDED.phone[2], three: NEEDED.phone[3] },
};

/**
 * What the sliders may say. The floor on "two" is a window that can hold a
 * sidebar and a list and nothing else; "three" must stay clear of "two" by
 * enough that one drag cannot make them equal and flip the layout twice.
 */
export const THRESHOLD_LIMITS = {
  one: { min: 280, max: 2000 },
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
  const { min: oneMin, max: oneMax } = THRESHOLD_LIMITS.one;
  const { min: twoMin, max: twoMax } = THRESHOLD_LIMITS.two;
  const { min: threeMin, max: threeMax } = THRESHOLD_LIMITS.three;
  const { gap } = THRESHOLD_LIMITS;
  const two = Math.min(Math.max(whole(input.two, fallback.two), twoMin), twoMax);
  const three = Math.min(Math.max(whole(input.three, fallback.three), threeMin), threeMax);
  // Each mode needs its own width, and they have to stay in order: if "one"
  // grew past "two", pressing 1 would resize the window to a width that shows
  // two panes — a button that names one thing and does another.
  const one = Math.min(
    Math.min(Math.max(whole(input.one, fallback.one), oneMin), oneMax),
    two - gap,
  );
  return { one, two, three: Math.max(three, two + gap) };
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
  return thresholds.one ?? NEEDED[device][1];
}

/**
 * The window width a mode press should ask for, or `null` when the window is
 * already right.
 *
 * A mode you cannot see reads as a broken button, so pressing 3 in a window too
 * narrow for three columns grows the window to fit them. Underneath that, there
 * are two honest answers to what a press does with the room it no longer needs,
 * and `keepWidths` picks between them:
 *
 *   - kept (the default): the window is the sum of that mode's own panes, so
 *     every pane keeps the width it was given. 3 → 2 leaves with the article and
 *     takes its width along, instead of pouring it into the posts column; a
 *     maximised window becomes the panes' sum, because slack with nowhere to go
 *     is exactly what stretches a pane.
 *   - shared: the window keeps whatever room it had and the flexible pane takes
 *     the difference, which is what a maximised window does at every press.
 *
 * `monitor` caps the request at what the screen can actually show: asking for
 * 1000px on an 800px display would move the window off the edge or be silently
 * clamped by the window manager, and both read as the button doing nothing.
 */
export function fitTarget(
  mode: PaneMode,
  available: number,
  device: Device = "desktop",
  thresholds: PaneThresholds = THRESHOLDS[device],
  monitor?: number | null,
  keepWidths = true,
): number | null {
  const want = widthFor(mode, device, thresholds);
  // Keeping pane widths, a press asks for the sum of this mode's own panes in
  // both directions: 3 → 2 takes the article's width away with the article
  // instead of pouring it into the posts column. Sharing the room, only growth
  // is asked for and a window already wider keeps its extra width.
  const target = keepWidths || mode === 1 ? want : Math.max(available, want);
  const cap = typeof monitor === "number" && monitor > 0 ? monitor : Number.POSITIVE_INFINITY;
  // The cap is a limit on growing, never a reason to take room away: a window
  // wider than the display it is judged by keeps its width, and a narrowed
  // window is never squeezed to the screen it was dragged past.
  const capped = Math.round(target > available ? Math.min(target, cap) : target);
  if (!Number.isFinite(capped) || capped <= 0) return null;
  if (Math.abs(capped - available) <= 1) return null;
  return capped;
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
  // A phone still follows its orientation: portrait has no room for two columns
  // and pretending otherwise would open a 390px screen "squeezed" every time.
  if (input.phone) return input.width > input.height ? 3 : 1;
  /**
   * A desktop opens in three panes, whatever the window width.
   *
   * It used to be width-derived — a 1000px window opened with two, a 900px one
   * with a single column — which meant the app's shape on a fresh install was a
   * guess about the window rather than a decision. Three is the shape this
   * reader is built around; `effectiveMode` still draws only what fits, so a
   * narrow window shows fewer panes without pretending the layout was chosen.
   */
  return 3;
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
/**
 * How far past a boundary the window has to be before the panes change.
 *
 * Without a band the layout flips the instant a number is crossed, so a window
 * dragged across 700px stutters between one and two panes, and dragging the
 * threshold slider changes the layout while the pointer is still moving. The
 * band is a dead zone either side of every boundary: gaining a pane needs the
 * window this far past the new mode's width, losing one needs it this far past
 * the old mode's.
 *
 * An explicit mode choice passes no `current`, so nothing here can make the
 * switch feel broken — it is only the automatic transitions that wait.
 */
export const MODE_HYSTERESIS = 120;

/**
 * What the window can show. The caller keeps the mode the user chose and
 * reports that it is squeezed, rather than quietly overwriting the choice.
 *
 * `current` is the mode on screen now. When it is given, the answer only
 * changes once the window is `MODE_HYSTERESIS` past the boundary being crossed.
 */
export function effectiveMode(
  desired: PaneMode,
  available: number,
  device: Device = "desktop",
  thresholds: PaneThresholds = THRESHOLDS[device],
  current?: PaneMode,
): PaneMode {
  const fit = (width: number): PaneMode => {
    if (desired >= 3 && width >= thresholds.three) return 3;
    if (desired >= 2 && width >= thresholds.two) return 2;
    return 1;
  };
  const next = fit(available);
  if (current === undefined || next === current) return next;
  // The boundary each mode is entered through, and the band either side of it.
  const edge = (mode: PaneMode): number =>
    mode === 3 ? thresholds.three : mode === 2 ? thresholds.two : 0;
  if (next > current) return available >= edge(next) + MODE_HYSTERESIS ? next : current;
  return available <= edge(current) - MODE_HYSTERESIS ? next : current;
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

/**
 * Two panes to three, as an extension rather than a re-division.
 *
 * In two panes the posts column is the flexible one, so its width *is* whatever
 * the window has left. Three panes give it a width of its own and hand the
 * remainder to the article — so entering from two panes quietly narrowed the
 * posts column to its remembered three-pane width and crushed the article into
 * what was left. A button that promised a third column rearranged the two you had.
 *
 * So the posts width you can see becomes the width three panes use, the article
 * keeps its own, and the window then needs the sum: it grows by exactly the
 * article, and the columns on screen do not move.
 */
export function extendToThree(
  layout: PaneLayout,
  available: number,
  device: Device = "desktop",
  limit?: number | null,
): PaneLayout {
  const mins = MINIMUMS[device];
  const drawn = clampWidths(layoutWidths(layout, 2), 2, available, device);
  const sidebar = clamp(drawn.sidebar, mins.sidebar, Math.max(mins.sidebar, available - GUTTER - mins.list));
  // Two panes draw the posts column as `1fr`, so its width is the remainder and
  // not the remembered number: ask the window, not the storage.
  let list = Math.max(mins.list, available - GUTTER - sidebar);
  if (typeof limit === "number" && limit > 0) {
    // The screen is the hard stop. The posts column keeps everything it is
    // drawing as long as the article still fits beside it, and gives way only on
    // a display that cannot hold all three: without this the window would be
    // asked for a width it can never reach and the press would do nothing.
    list = Math.max(mins.list, Math.min(list, limit - sidebar - GUTTER * 2 - layout.article));
  }
  return intentLayout({ ...layout, list3: list }, device);
}

/**
 * The user's own widths, made merely sane: a floor at the hard minimum and a
 * rounding. No ceiling that depends on the window or the mode.
 *
 * This is what belongs in storage. `clampWidths` answers a different question —
 * what this window can draw *right now* — and storing its answer is what made
 * the layout wander: passing through one-pane forced the list to its minimum,
 * and narrowing the window permanently narrowed the panes.
 */
export function intentWidths(widths: PaneWidths, device: Device = "desktop"): PaneWidths {
  const mins = MINIMUMS[device];
  const ceiling = Math.max(mins.sidebar, mins.list) * 8;
  return {
    sidebar: clamp(widths.sidebar, mins.sidebar, ceiling),
    list: clamp(widths.list, mins.list, ceiling),
  };
}

/* ------------------------------------------------------------------------- *
 * What the panes remember.
 *
 * The widths are the source of truth and the thresholds are arithmetic done
 * on them: "the window two panes need" is the width of the two panes the user
 * shaped, not a number in a panel that a later drag can silently contradict.
 * A drag moves the panes, the thresholds follow, and a mode button asks the
 * window for the sum — which is why pressing 2 after widening the sidebar
 * cannot hand back a narrower sidebar.
 *
 * The sidebar is shared between two and three panes on purpose: it is one
 * column, and widening it once should not have to be repeated per mode. The
 * posts column is kept per mode, because three panes have an article beside it
 * and two do not, and the article keeps a width of its own so that "three
 * panes" is a number with a meaning rather than a floor.
 * ------------------------------------------------------------------------- */

export interface PaneLayout {
  sidebar: number;
  /** Posts, as a two-pane layout leaves them. */
  list2: number;
  /** Posts, beside an article. */
  list3: number;
  /** The article's own width; what it is *given* is whatever is left over. */
  article: number;
}

export const DEFAULT_LAYOUT: PaneLayout = {
  sidebar: DEFAULT_WIDTHS.sidebar,
  list2: DEFAULT_WIDTHS.list,
  list3: DEFAULT_WIDTHS.list,
  article: MIN.article,
};

/** The two widths the grid and the drag arithmetic want, for one mode. */
export function layoutWidths(layout: PaneLayout, mode: PaneMode): PaneWidths {
  return { sidebar: layout.sidebar, list: mode === 3 ? layout.list3 : layout.list2 };
}

/**
 * The window a mode needs to show the panes as they were shaped.
 *
 * Never below the mode's own floor: a layout dragged to slivers still needs a
 * window that can hold three usable columns. Never above `available` either —
 * that is the caller's job (`settleRequirement`), because a requirement larger
 * than the window would demote the layout the moment it was dragged.
 */
export function neededWidth(layout: PaneLayout, mode: PaneMode, device: Device = "desktop"): number {
  const floor = NEEDED[device][mode];
  if (mode === 1) return floor;
  const panes =
    mode === 3
      ? layout.sidebar + GUTTER + layout.list3 + GUTTER + layout.article
      : layout.sidebar + GUTTER + layout.list2;
  return Math.max(floor, Math.round(panes));
}

/**
 * The sliders, derived. `one` is the exception and stays a setting: it is not a
 * sum of anything, it is where the "1" button puts the window.
 */
export function thresholdsFor(
  layout: PaneLayout,
  device: Device = "desktop",
  one?: number,
): PaneThresholds {
  return clampThresholds(
    {
      one: one ?? THRESHOLDS[device].one,
      two: neededWidth(layout, 2, device),
      three: neededWidth(layout, 3, device),
    },
    device,
  );
}

/**
 * The sliders' other direction: fit the panes into a window of `total`.
 *
 * Dragging a threshold is asking for a wider layout, so the panes that are
 * flexible take the difference — the posts column alone in two panes, and the
 * posts/article pair in proportion in three, with the sidebar untouched. That
 * keeps the slider honest in both directions instead of turning it into a
 * read-out.
 */
export function scaleLayout(
  layout: PaneLayout,
  mode: PaneMode,
  total: number,
  device: Device = "desktop",
): PaneLayout {
  const mins = MINIMUMS[device];
  const room = Math.max(0, Math.round(total));
  if (mode === 2) {
    const list2 = clamp(room - GUTTER - layout.sidebar, mins.list, intentCeiling(device));
    return { ...layout, list2 };
  }
  if (mode === 3) {
    const free = Math.max(room - GUTTER * 2 - layout.sidebar, mins.list + mins.article);
    const pair = Math.max(1, layout.list3 + layout.article);
    const list3 = clamp((free * layout.list3) / pair, mins.list, free - mins.article);
    return { ...layout, list3, article: free - list3 };
  }
  return layout;
}

/**
 * A requirement is not allowed to outgrow the window it was dragged in.
 *
 * Dragging the sidebar wider in two panes squeezes the posts column down to its
 * floor; if the stored requirement kept the old, wider posts width, the sum
 * would pass the window and the layout would demote itself to one column mid
 * drag. So the flexible pane gives way here too: the requirement ends up as the
 * window it was shaped in, and the button later asks for exactly that.
 */
export function settleRequirement(
  layout: PaneLayout,
  mode: PaneMode,
  available: number,
  device: Device = "desktop",
): PaneLayout {
  if (mode === 1) return layout;
  const mins = MINIMUMS[device];
  if (mode === 2) {
    const room = available - GUTTER - layout.sidebar;
    return room >= layout.list2 ? layout : { ...layout, list2: clamp(room, mins.list, intentCeiling(device)) };
  }
  let article = layout.article;
  let list = layout.list3;
  let over = layout.sidebar + GUTTER + list + GUTTER + article - available;
  if (over > 0) {
    const taken = Math.max(0, Math.min(over, article - mins.article));
    article -= taken;
    over -= taken;
  }
  if (over > 0) list = Math.max(mins.list, list - over);
  return { ...layout, list3: Math.round(list), article: Math.round(article) };
}

/** Storage hygiene: floors only, like `intentWidths`. */
export function intentLayout(layout: PaneLayout, device: Device = "desktop"): PaneLayout {
  const mins = MINIMUMS[device];
  const ceiling = intentCeiling(device);
  return {
    sidebar: clamp(layout.sidebar, mins.sidebar, ceiling),
    list2: clamp(layout.list2, mins.list, ceiling),
    list3: clamp(layout.list3, mins.list, ceiling),
    article: clamp(layout.article, mins.article, ceiling),
  };
}

/**
 * A layout from the two numbers older versions stored, keeping the three-pane
 * window the user had already chosen as the article's width.
 */
export function layoutFromWidths(widths: PaneWidths, three?: number, device: Device = "desktop"): PaneLayout {
  const mins = MINIMUMS[device];
  const article =
    typeof three === "number" && Number.isFinite(three)
      ? three - widths.sidebar - widths.list - GUTTER * 2
      : DEFAULT_LAYOUT.article;
  return intentLayout(
    { sidebar: widths.sidebar, list2: widths.list, list3: widths.list, article },
    device,
  );
}

function intentCeiling(device: Device): number {
  const mins = MINIMUMS[device];
  return Math.max(mins.sidebar, mins.list) * 8;
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
