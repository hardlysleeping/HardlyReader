/**
 * Pane geometry, as arithmetic rather than as media queries.
 *
 * The layout used to be decided by `@media` rules, so a wide window could not
 * be asked for two columns and a narrow one silently rearranged itself. Here
 * the mode is the user's choice and this module answers two questions: what can
 * actually be shown at this width, and where does a dragged gutter stop.
 */

import type { OnePaneLevel } from "./one-pane";

export type PaneMode = 1 | 2 | 3;

export interface PaneWidths {
  sidebar: number;
  list: number;
}

export const GUTTER = 6;

/**
 * The divider between the posts and the article when they are stacked.
 *
 * The same 6px seam as a column, because it is the same device seen from the
 * other side: a gutter between two panes.
 */
export const STACK_GUTTER = GUTTER;

/**
 * The strip a folded feeds pane leaves in two panes.
 *
 * Folding the feeds there does not hand the frame to the posts: the two panes
 * that remain — the posts and the article — sit side by side, and the seam the
 * feeds used to hold becomes this rail, which is where the way back lives. It
 * is the gutter's width on purpose, so the five tracks still add up to the
 * frame and folding is a change inside it rather than a resize.
 */
export const RAIL = GUTTER;

/**
 * How much of the right column the pane in the top slot takes, when stacked.
 *
 * A fraction, not a width: a resized window then keeps the split instead of
 * turning "half" into 412px of a 900px column. Measured from the top of the
 * column rather than from the post list, so swapping the two panes leaves the
 * seam exactly where the user put it (see `stackTopPane`).
 */
export const STACK_SHARE = { min: 0.25, max: 0.75, fallback: 0.5 } as const;

/** The shortest either stacked pane may be drawn, in pixels. */
export const STACK_MIN_PANE = 160;

/**
 * The one width a stacked right column has: the wider of its two panes.
 *
 * Side by side, the posts and the article have a width each. Stacked they
 * share one column, and it has to be the wider of the pair — anything narrower
 * and the other pane is the one that suffers.
 */
export function stackWidth(widths: PaneWidths, articleMin: number = MIN.article): number {
  return Math.max(widths.list, articleMin);
}

/** The window a stacked three needs: the feeds, the seam, and that column. */
export function stackNeeded(widths: PaneWidths, articleMin: number = MIN.article): number {
  return widths.sidebar + GUTTER + stackWidth(widths, articleMin);
}

/**
 * A stacked share, made legal for a column `height` pixels tall.
 *
 * The fraction is what is stored; the pixel floor is applied here, so a short
 * window cannot leave the article — or the posts — a sliver. When the window is
 * too short for both floors the split becomes half, which is the least wrong
 * answer available.
 */
/**
 * Where a stacked drag puts the seam.
 *
 * `start` is the share the drag began at, `dy` the pixels the pointer has
 * travelled, and `height` the column the rows are a percentage *of* — the same
 * number `stackTemplate` divides, because the seam's top edge is drawn at
 * `share × height`. That identity is the whole point: moving the pointer 1px
 * moves the seam 1px, so the handle stays under the finger. Dividing by
 * anything else (the seam's own track, the column less the gutter) makes the
 * seam run away from the pointer or crawl behind it, which reads as a drag that
 * cannot be controlled.
 */
export function shareFromDrag(start: number, dy: number, height: number): number {
  if (!Number.isFinite(start)) return STACK_SHARE.fallback;
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(dy)) return start;
  return start + dy / height;
}

export function clampShare(share: number, height: number, gutter = STACK_GUTTER): number {
  if (!Number.isFinite(share)) return STACK_SHARE.fallback;
  const bounded = (value: number): number =>
    Math.min(Math.max(value, STACK_SHARE.min), STACK_SHARE.max);
  const room = Math.max(0, height - gutter);
  if (room <= 0) return bounded(share);
  const floor = Math.min(0.5, STACK_MIN_PANE / room);
  const ceiling = Math.max(0.5, 1 - STACK_MIN_PANE / room);
  return Math.min(Math.max(share, Math.max(STACK_SHARE.min, floor)), Math.min(STACK_SHARE.max, ceiling));
}

/* ------------------------------------------------------------------------- *
 * Which half is which.
 *
 * The stack is two panes and one seam between them. Which of the two sits on
 * top is a preference about the arrangement, not a property of either pane: the
 * post list stays the post list and the article stays the article, and only
 * their order in the column changes. The split is therefore a number about the
 * *column* (how much of it is above the seam), which is what lets a swap move
 * neither pane's edge — the seam stays exactly where the user put it.
 *
 * A tuck is the other, temporary half of the same idea: one pane takes the
 * whole column for a moment while the other is put away. It is deliberately not
 * a stored preference — it is undone by pressing the same control again — and
 * only one pane may be away at a time, because a column with both halves hidden
 * is an empty panel with nothing left in it to explain itself.
 * ------------------------------------------------------------------------- */

export type StackPane = "posts" | "article";

/** A slot in the column, which is what the two tuck controls act on. */
export type StackSide = "top" | "bottom";

/** The half of the column currently put away, if any. */
export type StackTuck = StackSide | null;

/** The pane in the top slot. Unswapped, that is the post list. */
export function stackTopPane(swapped: boolean): StackPane {
  return swapped ? "article" : "posts";
}

/** The pane below the seam: the other one. */
export function stackBottomPane(swapped: boolean): StackPane {
  return swapped ? "posts" : "article";
}

/**
 * A tuck press: the same side again puts its pane back, the other side takes
 * that half instead.
 *
 * Never two at once. Replacing rather than adding is what answers "show the
 * other one without leaving a hole": the press that would hide the second half
 * restores the first, so the column always holds at least one pane.
 */
export function nextTuck(tuck: StackTuck, side: StackSide): StackTuck {
  return tuck === side ? null : side;
}

/* ------------------------------------------------------------------------- *
 * The slide between layouts.
 *
 * A mode press changes which panes are on screen and how wide their columns
 * are. That change is drawn, not rebuilt (see `paneSlots` and the one grid in
 * `Main.svelte`), and the columns move over a short, spring-like curve so the
 * frame does not jump. Three feels, and the model is here rather than in the
 * component because the drawn duration and the guard that stops a *resize* from
 * animating have to agree with the text on the setting.
 *
 * `off` is the honest first option, not a hidden fallback: a reader who has
 * asked the system for `prefers-reduced-motion: reduce` starts here.
 * ------------------------------------------------------------------------- */

export type PaneMotion = "off" | "quick" | "smooth";

export const DEFAULT_MOTION: PaneMotion = "quick";

export const PANE_MOTIONS: readonly PaneMotion[] = ["off", "quick", "smooth"];

/**
 * Duration and curve per feel.
 *
 * Both durations are inside the 160–250ms a press is allowed: long enough to
 * read as movement, short enough that the mode still feels instant — and now
 * that the content of a pane is laid out once per press rather than once per
 * frame (`Main.svelte`), a little longer buys smoothness instead of costing
 * frames. The curve is where the difference lives — `quick` leaves at once and
 * lands briskly, `smooth` starts softer and takes its time settling — so the
 * three do not just differ by a delay.
 *
 * Neither curve overshoots, and that is a rule rather than a taste: the content
 * inside a column is laid out at the width the column will end at, so a track
 * that travelled past that width would either stretch the laid-out text (a
 * reflow in the last frames of the slide) or leave a strip of the pane's
 * background between its content and the seam. A spring that goes past 1 is a
 * spring over empty space; over rows and article text it is a pop. The curves
 * therefore decelerate into the target (`y` control points at most 1) and the
 * settle is what carries the weight: 185ms and 250ms, the second with a longer
 * tail rather than a bounce.
 *
 * Both also leave from rest (`y1` near 0). The first curves left at speed —
 * `y1` 0.86 put 42% of the travel in the first tenth of the time — and a press
 * then opened with a jolt whose size was whatever the frame timing made it,
 * which is why the same button sometimes slid and sometimes snapped: the first
 * painted frame was anywhere from a tenth to a third of the way across. A
 * column that starts still and lands early reads as the frame opening.
 */
export const PANE_MOTION: Record<PaneMotion, { ms: number; ease: string }> = {
  off: { ms: 0, ease: "linear" },
  quick: { ms: 185, ease: "cubic-bezier(0.2, 0, 0.2, 1)" },
  smooth: { ms: 250, ease: "cubic-bezier(0.25, 0.1, 0.2, 1)" },
};

export function isPaneMotion(value: unknown): value is PaneMotion {
  return value === "off" || value === "quick" || value === "smooth";
}

/**
 * What a phone held upright draws: the one-pane walk, or the sliding stack.
 *
 * Here rather than in `state/mobile-nav.svelte.ts`, because the layout has to be
 * able to read and store it without importing a runes module: `layout.svelte.ts`
 * is compiled on its own by several unit suites, and a dependency on signals it
 * does not own turns a plain import into a compiler question. It is layout
 * vocabulary — a shape the layout draws — so it lives with the pane types.
 */
export type MobilePortraitMode = "single" | "stack";

/** Whether a stored or typed value is one of the two portrait modes. */
export function isMobilePortraitMode(value: unknown): value is MobilePortraitMode {
  return value === "single" || value === "stack";
}

/**
 * The elastic on the pane that arrives, and only on that one.
 *
 * The columns themselves never overshoot: a track pushed past the width its
 * content was laid out at re-stretches the text in the last frames, which is
 * exactly the artefact that made the first attempt at this look wrong. So the
 * bounce lives one layer out, on a transform: the arriving pane comes in from a
 * little off its side, passes its home by a fraction of that, and settles. Text
 * is laid out once, at its final width, and never reflows.
 */
export const ARRIVE = {
  /** Pixels the arriving pane travels from its side. */
  offset: 14,
  /** How far past home it goes, as a fraction of that travel. */
  overshoot: 0.18,
} as const;

export interface ArriveFrame {
  transform: string;
  offset?: number;
  easing?: string;
}

/**
 * Three frames: in from the side, a small overshoot the other way, home.
 *
 * `from` is -1 for a pane arriving from the left (the feeds) and 1 for one
 * arriving from the right (the posts, the article).
 */
export function arriveKeyframes(
  from: -1 | 1,
  offset: number = ARRIVE.offset,
  overshoot: number = ARRIVE.overshoot,
): ArriveFrame[] {
  const travel = Math.abs(offset);
  const past = travel * Math.min(Math.max(overshoot, 0), 0.4);
  // Each frame carries its own curve, and the animation's own easing stays
  // linear. An effect-level ease-out on the whole thing front-loads the travel —
  // measured: the pane was past home 20% into the run — which reads as a late
  // jiggle rather than something arriving.
  return [
    { transform: `translateX(${from * travel}px)`, easing: "cubic-bezier(0.4, 0.05, 0.3, 1)" },
    { transform: `translateX(${-from * past}px)`, offset: 0.7, easing: "cubic-bezier(0.4, 0, 0.5, 1)" },
    { transform: "translateX(0px)" },
  ];
}

/** How long the columns take, in milliseconds. Zero means "draw it now". */
export function motionMs(motion: PaneMotion): number {
  return PANE_MOTION[motion].ms;
}

/** The curve the columns are drawn with. */
export function motionEase(motion: PaneMotion): string {
  return PANE_MOTION[motion].ease;
}

/**
 * `grid-template-rows` for the stacked column.
 *
 * Four tracks in every arrangement, because a track list of a different length
 * cannot be interpolated: `0, the top pane, the seam, the rest` when stacked and
 * `0, the whole column, 0, 0` when the panes sit side by side, which is how the
 * split can slide open and shut instead of snapping. All four are lengths or
 * percentages that sum to exactly the column height.
 *
 * A tuck no longer changes this string: the pane that stayed spans every row
 * (see `paneSlots`), and the seam is drawn over it by `PaneGutter` at the share
 * below, so the split it will come back to stays visible while the pane is away.
 */
export function stackTemplate(share: number): string {
  const top = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : STACK_SHARE.fallback;
  const percent = (top * 100).toFixed(2);
  return `${track(0)} ${percent}% ${STACK_GUTTER}px calc(100% - ${percent}% - ${STACK_GUTTER}px)`;
}

/** The same four tracks with nothing split: one column, no seam. */
export const FLAT_ROWS = `${track(0)} 100% ${track(0)} ${track(0)}`;

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

/**
 * The widths a fresh install opens with: the owner's own.
 *
 * His drawer sits at its own minimum and the posts column stays narrow enough
 * that three columns of an ordinary laptop window are all readable without
 * dragging anything — 240 + 6 + 260 + 6 + article. These were 280/380, which is
 * a comfortable two-pane pair and a cramped three-pane row.
 */
export const DEFAULT_WIDTHS: PaneWidths = { sidebar: MIN.sidebar, list: MIN.list };

/**
 * The narrowest the window itself may be, which is not the narrowest a pane may
 * be.
 *
 * The window's floor is the bar's, not the columns': below 280 the brand and the
 * sync button together are wider than the window and the button is pushed off
 * the right edge — measured, with the compact bar already in force, 264 is the
 * point where it starts to leave. 280 is that with a few pixels of slack, and it
 * sits under every pane floor above, so no mode is ever drawn in a window its
 * columns cannot honour.
 *
 * A sidebar may still be dragged to 240 inside a wider window; only a window
 * that narrow is refused, which is why the one-pane ask is clamped up to this
 * number rather than the sidebar's floor being raised to meet it.
 */
export const WINDOW_FLOOR = 280;

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

/**
 * The narrowest window a stacked three can be drawn honestly in.
 *
 * Not the two-pane floor: the pair spends one content column instead of two, so
 * a window that cannot hold feeds and a post list side by side can still hold
 * feeds beside a column that is a post list above an article. Computed from the
 * minimums rather than the shaped widths, because this is a floor and the shaped
 * widths are a preference.
 */
export function stackFloor(device: Device = "desktop"): number {
  const mins = MINIMUMS[device];
  return mins.sidebar + GUTTER + Math.max(mins.list, mins.article);
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
 * The thresholds a layout that *shares* the window should be judged by.
 *
 * The tuned ones say "this window is wide enough for the panes I shaped", which
 * is the right question when the window is following the panes. It is the wrong
 * question when the panes follow the window: pressing three in a 1100px window
 * must not be refused because the user's own three columns once added up to
 * 1212, and it must not grow the window to 1212 either — the frames squeeze and
 * the window keeps what it has. Only a window too small for three honest
 * columns refuses, and that is the floor.
 */
export function floorThresholds(device: Device = "desktop", stacked = false): PaneThresholds {
  const base = THRESHOLDS[device];
  if (!stacked) return base;
  // Three panes drawn as a stack are a two-pane *window*: one content column,
  // not two. So the floor they are judged by is the two-pane floor, exactly —
  // not the third column's price, and not some cheaper number of its own. The
  // owner's words: stacked, "it should follow 2 panes minimum layout setting not
  // 3 panes". A stack in a 700px window is honest; refusing it there is what
  // made the third pane jump out instead of stacking.
  //
  // `two` is the pair's own arithmetic floor rather than the tuned number, so
  // the two modes do not share an edge: with both at 700 a window narrowed from
  // a stack fell straight to one pane at 699, because two panes were refused at
  // the same pixel the third was. One at a time, in order — three columns, the
  // stack, two panes, one pane — is what the owner asked for, and each step
  // needs its own width to happen at.
  return { ...base, two: pairFloor(device), three: base.two };
}

/**
 * The narrowest honest window with the feeds pane and one content column.
 *
 * The geometric sum, not the tuned `two`: that number is where a second pane
 * *appears* when a window grows, which is a preference. This is where two panes
 * stop being drawable at all, and it is what a window shrinking through the
 * modes is judged by.
 */
export function pairFloor(device: Device = "desktop"): number {
  const mins = MINIMUMS[device];
  return mins.sidebar + GUTTER + mins.list;
}

/**
 * What the sliders may say. The floor on "two" is a window that can hold a
 * sidebar and a list and nothing else; "three" must stay clear of "two" by
 * enough that one drag cannot make them equal and flip the layout twice.
 */
export const THRESHOLD_LIMITS = {
  // `one` starts where a sidebar may actually be dragged to (`MIN.sidebar`),
  // not at a wider number: a margin dragged to 240 and then the "1" button used
  // to disagree by 40px, which is the same "it grew on me" jump as the window
  // floor caused from the other side.
  // The layout sliders' minimums, given by the owner: one pane from 250, two
  // from 500, three from 750. These were 240 / 360 / 440 — the sliders could be
  // dragged down to widths the panes themselves could not honour, and the mode
  // floors above were a different set of numbers entirely, which is what made
  // "why is the two-pane minimum 700" a fair question.
  one: { min: 250, max: 2000 },
  two: { min: 500, max: 2000 },
  three: { min: 750, max: 2600 },
  gap: 80,
};

/**
 * The slider minimums for one device.
 *
 * A phone's own floors are narrower than the desktop's — 280 / 440 / 660 — and a
 * phone may not be dragged below the width its panes can be drawn at, so each
 * device takes the narrower of its own floor and the owner's desktop number.
 */
export function thresholdLimits(device: Device = "desktop") {
  const narrow = (slider: number, floor: number) => Math.min(slider, floor);
  return {
    one: { min: narrow(THRESHOLD_LIMITS.one.min, NEEDED[device][1]), max: THRESHOLD_LIMITS.one.max },
    two: { min: narrow(THRESHOLD_LIMITS.two.min, NEEDED[device][2]), max: THRESHOLD_LIMITS.two.max },
    three: { min: narrow(THRESHOLD_LIMITS.three.min, NEEDED[device][3]), max: THRESHOLD_LIMITS.three.max },
    gap: THRESHOLD_LIMITS.gap,
  };
}

/** Runtime values from storage, a slider or a corrupt string, made legal. */
export function clampThresholds(
  input: Partial<PaneThresholds>,
  device: Device = "desktop",
): PaneThresholds {
  const fallback = THRESHOLDS[device];
  const whole = (value: unknown, or: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : or;
  const limits = thresholdLimits(device);
  const { min: oneMin, max: oneMax } = limits.one;
  const { min: twoMin, max: twoMax } = limits.two;
  const { min: threeMin, max: threeMax } = limits.three;
  const { gap } = limits;
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
  const want = mode === 3 ? thresholds.three : mode === 2 ? thresholds.two : thresholds.one ?? NEEDED[device][1];
  // One pane is the sidebar's own width, and a dragged sidebar may sit under the
  // window's floor — a width no window can be. The answer here is the width the
  // layout switch asks the window for, so it carries the same floor `fitTarget`
  // applies; otherwise the press drew 280 while `widthFor` said 240 and the two
  // numbers disagreed about the frame that was on screen.
  return device === "desktop" ? Math.max(WINDOW_FLOOR, want) : want;
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
  // The ask is never for a window the window cannot be. A sidebar may be
  // dragged to 240 and one pane fills the window, so the old ask was 240 — a
  // width the window refuses, which meant the pane drew at the floor and every
  // row re-flowed. The floor here is the bar's; a phone has no window manager
  // to refuse anything, so its own numbers stand.
  const want = device === "desktop"
    ? Math.max(WINDOW_FLOOR, widthFor(mode, device, thresholds))
    : widthFor(mode, device, thresholds);
  // Keeping pane widths, a press asks for the sum of this mode's own panes in
  // both directions: 3 → 2 takes the article's width away with the article
  // instead of pouring it into the posts column. Sharing the room, only growth
  // is asked for and a window already wider keeps its extra width.
  // Sharing the room, no press resizes the window at all: not 1, not 2, not 3.
  // `mode === 1` used to be forced into the fitting branch, so "Keep window"
  // still shrank the window whenever one pane was pressed — the one setting that
  // promises not to touch the window was the one that touched it most. The only
  // exception is a window too narrow for the mode asked for, which grows.
  // Sharing the room, the width to beat is the mode's own floor — not the sum
  // of the widths the user shaped, which are a preference the window may
  // override. Asking for `want` here grew the window every time a press asked
  // for more room than the user's panes happened to total.
  // One column never grows the window: it is the mode that fits anywhere, so a
  // narrow window keeps its size and the pane squeezes into it. Two and three
  // grow only as far as their floor, never as far as the user's own widths.
  const floor = mode === 1 ? 0 : needed(mode, device);
  const target = keepWidths ? want : Math.max(available, floor);
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
  // A mode is entered at its edge — the width the window needs to draw it — and
  // left once the window is a band below it. The band is for a window being
  // dragged across a boundary, so it must not flicker between two layouts; it is
  // not a price of admission. Charging it on the way in as well meant a window
  // with exactly the width three panes need still drew two, and the press that
  // sized the window to that number landed on a layout that refused to draw
  // itself — so "resize until it fits" never arrived.
  if (next > current) return next;
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
  stacked = false,
): PaneWidths {
  const mins = MINIMUMS[device];
  // Stacked three panes are one content column beside the feeds, so they cost
  // one seam rather than two and the feeds may take everything the stack does
  // not need — the side-by-side reservation of a posts *and* an article column
  // is what stopped the sidebar being dragged in a narrow stacked window.
  if (mode === 3 && stacked) {
    const sidebar = clamp(widths.sidebar, mins.sidebar, available - GUTTER - mins.list);
    return { sidebar, list: clamp(widths.list, mins.list, available - GUTTER - sidebar) };
  }
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
  stacked = false,
): PaneLayout {
  const mins = MINIMUMS[device];
  const drawn = clampWidths(layoutWidths(layout, 2), 2, available, device);
  const sidebar = clamp(drawn.sidebar, mins.sidebar, Math.max(mins.sidebar, available - GUTTER - mins.list));
  // Two panes draw the posts column as `1fr`, so its width is the remainder and
  // not the remembered number: ask the window, not the storage.
  let list = Math.max(mins.list, available - GUTTER - sidebar);
  // Stacked, the posts column becomes the top half of the column it is already
  // filling, so there is no third column to make room for and nothing to take
  // from the screen: the window keeps its width and only the split is new.
  if (!stacked && typeof limit === "number" && limit > 0) {
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

/**
 * The three-pane posts column ships wider than the two-pane one, which is the
 * owner's own pair of numbers: in three panes the list is showing titles and a
 * page thumbnail next to a 780px measure, and 260 there truncates every headline
 * to two words. Two panes keep 260, because there the list shares the frame
 * with the article alone.
 */
export const DEFAULT_LIST3 = 366;

export const DEFAULT_LAYOUT: PaneLayout = {
  sidebar: DEFAULT_WIDTHS.sidebar,
  list2: DEFAULT_WIDTHS.list,
  list3: DEFAULT_LIST3,
  article: MIN.article,
};

/* ------------------------------------------------------------------------- *
 * A phone's own proportions.
 *
 * A phone shipped on the desktop's numbers — a 168px drawer and a 240px list —
 * and on a landscape phone those are not small, they are *wrong*: 168 is a
 * fifth of an 844px frame, so the feeds were drawn narrower than the phone in
 * portrait draws them, and the article — which on a phone is often showing
 * nothing at all — held half the width. The answer is not a smaller version of
 * a desktop's pair of numbers; it is a proportion of the frame the phone
 * actually has, so the same phone in portrait, in landscape and in a split view
 * divides what it is given.
 *
 * The shares are of the *frame*, not of what is left after the two seams: 28%
 * of 844 is 237, and a fifth of that frame is the complaint. Each column is
 * still floored at the phone's own text minimum (`MINIMUMS.phone`), so a frame
 * that is too narrow for the proportions gets read-able columns rather than
 * three slivers — `clampWidths` then fits the result to the frame it is in,
 * exactly as it does for a width the user dragged.
 * ------------------------------------------------------------------------- */

/** The share of the frame a phone's feeds and posts columns ask for. */
export const PHONE_SHARES = { feeds: 0.28, posts: 0.33 } as const;

/**
 * The posts width a phone's *two*-pane shape ships with.
 *
 * Unchanged from 0.6.0 on purpose: two panes draw the posts as the elastic
 * column (`1fr`), so there the number is a preference nothing is drawn from,
 * and only the three-pane row — the one that was wrong — is re-profiled.
 */
export const PHONE_PAIR_LIST = 240;

/**
 * A phone's shipped layout, from the frame it is drawing in.
 *
 * 28% feeds, 33% posts, and the article takes the remainder. Both shares round
 * *up*: 0.28 of 844 is 236.32, and a feeds pane rounded down to 236 is a column
 * sitting under the share it was given, which is the one thing a proportion
 * must not do.
 *
 * The article is stored as the remainder rather than as its own proportion, so
 * the four numbers sum to the frame the profile was taken from — which is also
 * what makes the three-pane requirement derived from them the frame itself
 * rather than a number beside it.
 */
export function phoneLayout(available: number): PaneLayout {
  const mins = MINIMUMS.phone;
  const frame = Number.isFinite(available) && available > 0 ? available : 0;
  const room = Math.max(0, frame - GUTTER * 2);
  const sidebar = Math.max(mins.sidebar, Math.ceil(frame * PHONE_SHARES.feeds));
  const list3 = Math.max(mins.list, Math.round(frame * PHONE_SHARES.posts));
  const article = Math.max(mins.article, room - sidebar - list3);
  return { sidebar, list2: Math.max(mins.list, PHONE_PAIR_LIST), list3, article };
}

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
export function neededWidth(
  layout: PaneLayout,
  mode: PaneMode,
  device: Device = "desktop",
  stacked = false,
): number {
  const floor = NEEDED[device][mode];
  if (mode === 1) return floor;
  // Stacked, a third pane is not a third column: the posts and the article
  // share one, so the window three panes need is the two-pane one — 1000px was
  // the price of the third column, and there is no third column.
  if (mode === 3 && stacked) {
    const panes = stackNeeded(layoutWidths(layout, 3), MINIMUMS[device].article);
    return Math.max(NEEDED[device][2], Math.round(panes));
  }
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
  stacked = false,
): PaneThresholds {
  // Derived, not entered: the panes decide these, so the sliders' own floors do
  // not apply. They still have to be ordered — a stacked three legitimately comes
  // out under the three-column slider's minimum, which is the whole point of
  // stacking — so only the ordering and the gap are enforced here.
  // A layout missing the pane this mode needs is not a requirement, it is a
  // fallback: the old numbers came out of `clampThresholds`, which threw NaN away
  // in favour of the device's defaults, and that tolerance is kept here.
  const needTwo = neededWidth(layout, 2, device);
  const needThree = neededWidth(layout, 3, device, stacked);
  const two = Math.max(Number.isFinite(needTwo) ? needTwo : THRESHOLDS[device].two, NEEDED[device][1]);
  const three = Math.max(Number.isFinite(needThree) ? needThree : THRESHOLDS[device].three, two + THRESHOLD_LIMITS.gap);
  const oneWant = Math.round(one ?? THRESHOLDS[device].one);
  return { one: Math.min(oneWant, two - THRESHOLD_LIMITS.gap), two, three };
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
  stacked = false,
): PaneLayout {
  if (mode === 1) return layout;
  const mins = MINIMUMS[device];
  if (mode === 2) {
    const room = available - GUTTER - layout.sidebar;
    return room >= layout.list2 ? layout : { ...layout, list2: clamp(room, mins.list, intentCeiling(device)) };
  }
  // Stacked, the article is not a column to be trimmed: what gives way when the
  // feed list is dragged wide is the width the stack asks for, which is only a
  // floor under the drawn column anyway.
  if (stacked) {
    const room = available - GUTTER - layout.sidebar;
    if (room >= stackWidth(layoutWidths(layout, 3), mins.article)) return layout;
    return { ...layout, list3: clamp(room, mins.list, intentCeiling(device)) };
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
 * Five tracks, in every mode: the feeds, its seam, the posts, their seam, the
 * article. Only their widths change. That is not decoration — a track list with
 * a different number of tracks, or with a `1fr` in one state and a length in the
 * next, cannot be interpolated, so the columns would snap instead of sliding.
 * Every track here is a length, and the five of them sum to `available`.
 *
 * `collapsed` is the first pane folded away: its column and its seam are drawn
 * at 0 instead of leaving the template, so the fold is a move too. The panes
 * keep their slots (see `paneSlots`), which is why the list can stay in the
 * third track whether or not there is a sidebar beside it.
 *
 * Two panes are the exception, because folding the feeds there must not leave a
 * single stretched column: the rail takes the seam's place, the posts keep the
 * width they were shaped to, and the article takes the remainder. Same five
 * tracks, same sum — the frame never grows by folding.
 *
 * `stacked` is how three panes are drawn: not three columns but the feeds and
 * one right-hand column, which the caller splits into rows with
 * `stackTemplate`. The posts keep no track of their own — their width becomes
 * that column's floor (`stackWidth`), not a reservation in this template.
 *
 * `keepWidths` is mode 1's own honesty problem. One column is the whole frame
 * when a press fits the window to it, but with "Keep window" the frame stays the
 * size the user chose and the pane keeps the width it was given — the sidebar's
 * width, pinned left — with the rest of the frame simply empty.
 *
 * `articleless` is the phone's: three columns where the third has nothing in it
 * hands that column to the posts rather than to the background.
 */
export interface PaneTemplate {
  /** The pane container's width, in CSS pixels. */
  available: number;
  collapsed?: boolean;
  stacked?: boolean;
  keepWidths?: boolean;
  /**
   * Nothing is open in the article column, so the column has nothing to show.
   *
   * A phone sets this and nothing else does: a landscape phone at three panes
   * is 844px wide, and a third of that held by a pane that reads "Select an
   * article" is the largest thing on the screen being the emptiest. The
   * article's share goes to the posts, and its seam with it, so the list is as
   * wide as the phone allows until a post is opened.
   *
   * It is a *width*, not a mode: the five tracks stay five lengths, so opening
   * a post is the same change of widths — and therefore the same slide — as
   * every other layout change, and `paneSlots` is untouched. A desktop frame
   * keeps the column, empty or not, because a desktop has the room for it.
   */
  articleless?: boolean;
}

/**
 * The five column tracks, in pixels, for a mode.
 *
 * This is the geometry itself; `gridTemplate` only writes it down. Both are
 * needed: the tracks are what the grid is drawn from, and the numbers are also
 * what a sliding press hands each pane as the width to lay its content out at
 * (`--t1`…`--t5` in `Main.svelte`), so that the content is laid out once per
 * press instead of once per frame of the slide.
 */
export function tracks(mode: PaneMode, widths: PaneWidths, template: PaneTemplate): number[] {
  const total =
    Number.isFinite(template.available) && template.available > 0 ? template.available : 0;
  const collapsed = template.collapsed === true;
  const stacked = template.stacked === true;
  if (mode === 1) {
    // One column always fills the frame. Fitting the window to the pane gives the
    // same picture from the other side (the window is the pane's width), and a
    // shared window must not leave a strip of nothing beside the column: pressing
    // 1 hands the whole frame to that one pane, whatever its shaped width was.
    return [size(total), 0, 0, 0, 0];
  }
  const lead = collapsed ? 0 : widths.sidebar;
  const gap = collapsed ? 0 : GUTTER;
  if (mode === 2) {
    if (!collapsed) {
      // Two panes: the posts column is the elastic one, so it takes the frame.
      return [size(lead), size(gap), size(total - lead - gap), 0, 0];
    }
    // Folded, the pane that left leaves a rail rather than a hole: the rail
    // takes the seam's place at the far left, the posts keep the width they
    // were shaped to, and the article takes what is left over. Five lengths
    // again, summing to the frame — so this is a change of what is drawn
    // inside the frame, not of the frame itself.
    const room = Math.max(0, total - RAIL - GUTTER);
    const shaped = Number.isFinite(widths.list) ? widths.list : 0;
    const list = Math.min(Math.max(0, shaped), room);
    return [0, size(RAIL), size(list), size(GUTTER), size(total - RAIL - list - GUTTER)];
  }
  if (stacked) {
    // Feeds, seam, one right-hand column split into rows by `stackTemplate`.
    return [size(lead), size(gap), size(total - lead - gap), 0, 0];
  }
  if (template.articleless === true) {
    // A phone with nothing open: the article's column and its seam go to the
    // posts, so the row is the feeds and one list as wide as the frame allows.
    // Five lengths again, in the same order, so this is a change of widths and
    // the third column slides back in when a post is opened.
    return [size(lead), size(gap), size(total - lead - gap), 0, 0];
  }
  return [size(lead), size(gap), size(widths.list), size(GUTTER), size(total - lead - gap - widths.list - GUTTER)];
}

/** The same geometry as `grid-template-columns` wants to hear it. */
export function gridTemplate(mode: PaneMode, widths: PaneWidths, template: PaneTemplate): string {
  return tracks(mode, widths, template)
    .map((value) => `${value}px`)
    .join(" ");
}

/* ------------------------------------------------------------------------- *
 * Which panes are on screen.
 *
 * One grid holds every pane in every mode (see `Main.svelte`), so a press never
 * destroys one: the panes that are not drawn are hidden, not unmounted, and the
 * list they hold keeps its rows, its images and its scroll. That only works if
 * "drawn" is a value the markup can ask about, which is this.
 *
 * The rules are the ones the {@code {#if}} branches used to spell out, moved into
 * one place so the walk, the two-pane swap and the stack cannot drift apart:
 *
 *   - one column is a walk: the feeds (with their posts inline), then the
 *     article — or, stacked, the pair on one surface.
 *   - two panes: the feeds beside one column that is the posts, or the article
 *     while one is open. Folded, the rail stands where the feeds were and the
 *     two panes that are left — the posts and the article — are drawn together.
 *   - three panes: all three side by side, or the feeds beside the stack, and
 *     either way one pane can be tucked away for a moment.
 * ------------------------------------------------------------------------- */

export interface PaneSlots {
  /** The feed list. */
  sidebar: boolean;
  /** The seam between the feeds and the rest of the frame. */
  seam: boolean;
  /**
   * The strip a folded feeds pane leaves in two panes, holding the way back.
   *
   * It takes the seam's slot in the template, so exactly one of `seam` and
   * `rail` is ever drawn.
   */
  rail: boolean;
  /** The post list. */
  posts: boolean;
  /** The seam between the posts and the article, when they sit side by side. */
  seamPosts: boolean;
  /** The article. */
  article: boolean;
  /** The seam between them when they are stacked, and its swap/tuck controls. */
  seamStack: boolean;
}

export interface SlotsInput {
  mode: PaneMode;
  /** Where the walk is: one column has two levels, and nothing else has any. */
  level: OnePaneLevel;
  /** The pair is drawn: three panes, or the phone's two panes on one surface. */
  stacked: boolean;
  /** The feeds pane is folded away (two panes and three; one has no fold). */
  collapsed: boolean;
  tuck: StackTuck;
  swapped: boolean;
}

const NO_SLOTS: PaneSlots = {
  sidebar: false,
  seam: false,
  rail: false,
  posts: false,
  seamPosts: false,
  article: false,
  seamStack: false,
};

export function paneSlots(input: SlotsInput): PaneSlots {
  const { mode, level, collapsed, tuck, swapped } = input;
  const stacked = input.stacked === true;
  if (mode === 1) {
    // One column does not stack: a stack is two panes sharing a column, and there
    // is no second pane to share it with. A post opened here is the whole pane,
    // and the list comes down over it as the view's drawer — so the article is
    // the only slot, and `stacked` is a three-pane question.
    if (level === "feeds") return { ...NO_SLOTS, sidebar: true };
    return { ...NO_SLOTS, article: true };
  }
  if (mode === 2) {
    if (collapsed) {
      // The feeds are folded: the rail stands where their seam was, and the two
      // panes that remain — the posts and the article — are drawn together.
      // Not one stretched column: two panes side by side is the whole point of
      // folding the third away, and it is what the rail restores them from.
      return { ...NO_SLOTS, rail: true, posts: true, article: true, seamPosts: true };
    }
    // The feeds stay, and the one column beside them is whichever of the two
    // panes belongs there right now — a post list, or the post that was opened.
    return {
      ...NO_SLOTS,
      sidebar: true,
      seam: true,
      posts: level !== "article",
      article: level === "article",
    };
  }
  const base = { ...NO_SLOTS, sidebar: !collapsed, seam: !collapsed };
  if (!stacked) return { ...base, posts: true, article: true, seamPosts: true };
  // The blank map inside `stackedSlots` must not take the feeds pane with it.
  return { ...base, ...stackedSlots(tuck, swapped), sidebar: base.sidebar, seam: base.seam };
}

/** The two panes of a column, less whichever half is tucked away. */
// Only the two stacked panes and their own seam. The caller owns the feeds pane:
// spreading a blank slot map here would switch pane 1 off in every stacked draw,
// which is exactly how it disappeared once already.
function stackedSlots(tuck: StackTuck, swapped: boolean): PaneSlots {
  const top = stackTopPane(swapped);
  const bottom = top === "posts" ? "article" : "posts";
  return {
    ...NO_SLOTS,
    seamStack: true,
    posts: (top === "posts" && tuck !== "top") || (bottom === "posts" && tuck !== "bottom"),
    article: (top === "article" && tuck !== "top") || (bottom === "article" && tuck !== "bottom"),
  };
}

/** A track size in pixels, trimmed: the fifth decimal place is not a layout. */
function size(value: number): number {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Math.round(safe * 100) / 100;
}

function track(value: number): string {
  return `${size(value)}px`;
}


function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(Math.max(rounded, min), Math.max(min, max));
}
