/**
 * The pane layout, as a setting rather than a consequence of the window size.
 *
 * The mode the user picked is kept even when the window is too narrow to draw
 * it: the app renders what fits and says it is squeezed, so widening the window
 * restores the layout with no click. Widths are per device and re-clamped on
 * resize, because a width saved on a 27" screen would otherwise leave a 40px
 * article column on a laptop.
 */

import { capabilitiesFor, detectShape, isTauri, type Capabilities } from "../lib/platform";
import {
  DEFAULT_LAYOUT,
  DEFAULT_MOTION,
  DEFAULT_WIDTHS,
  FLAT_ROWS,
  STACK_SHARE,
  THRESHOLDS,
  THRESHOLD_LIMITS,
  isPaneMotion,
  type Device,
  type PaneLayout,
  type PaneMode,
  type PaneMotion,
  type PaneThresholds,
  type PaneWidths,
  type StackPane,
  type StackSide,
  type StackTuck,
  clampThresholds,
  clampWidths,
  defaultModeFor,
  effectiveMode,
  fitTarget,
  extendToThree,
  floorThresholds,
  gridTemplate,
  intentLayout,
  layoutFromWidths,
  layoutWidths,
  minimums,
  neededWidth,
  nextTuck,
  nudge,
  resetPane,
  scaleLayout,
  settleRequirement,
  stackBottomPane,
  stackTemplate,
  stackTopPane,
  thresholdsFor,
  widthFor,
} from "../lib/panes";
import { fitWindowTo, screenWidth } from "../lib/window-fit";

const STORAGE_KEY = "hardlyreader.layout.v1";

/**
 * How long a press owns the measurements that follow it.
 *
 * A resize crosses the window manager and an IPC boundary, and the observer's
 * report is what proves it happened; half a second covers a slow compositor
 * without letting a press colour a drag that starts later.
 */
const PRESS_GRACE_MS = 500;

/**
 * The widest frame a remembered "Keep window" width may be.
 *
 * A stored width is a number from an older screen as easily as from this one, so
 * it is clamped rather than trusted: 8k of CSS pixels is wider than any window
 * this app will be asked for, and anything beyond it is a stale or corrupt save.
 */
const KEEP_WINDOW_MAX = 8192;

interface SavedLayout {
  mode: PaneMode;
  /** What the panes remember. The source of truth for the thresholds. */
  panes?: Partial<PaneLayout>;
  /** Older saves: one sidebar and one posts width, shared by two and three. */
  widths?: PaneWidths;
  /** Where the second and third pane appear, in CSS pixels. */
  thresholds?: Partial<PaneThresholds>;
  /** True once the user has picked a mode themselves. */
  chosen?: boolean;
  /** The first pane folded away. */
  collapsed?: boolean;
  /** Whether a mode press keeps pane widths or shares the window. */
  keepWidths?: boolean;
  /**
   * The frame "Keep window" last had, so the toggle can put it back.
   *
   * Each sizing mode remembers its own frame: keeping the panes and sharing the
   * window want different windows for the same layout, and the one that is not
   * in force has to be remembered rather than derived. It is never used at
   * launch — the window there is the OS or Tauri's to size — only when the
   * toggle is used.
   */
  keepWindowWidth?: number;
  /** How the columns move when a press changes the layout. */
  motion?: PaneMotion;
  /** Three panes drawn as posts above the article. */
  stacked?: boolean;
  /**
   * Which of the two stacked panes is on top. A tuck is deliberately absent:
   * it is temporary, and a save that started with half a column would read as
   * a broken layout rather than as something the user asked for.
   */
  stackSwapped?: boolean;
  /** How much of the stacked right column is above the seam. */
  stackShare?: number;
}

/**
 * Phone, for layout purposes: a coarse pointer and a small shortest side.
 *
 * The rule itself lives in `lib/platform.ts` so the settings panel and the panes
 * cannot drift apart about what device they are on.
 */
function detectDevice(): Device {
  return detectShape();
}

function isTauriWindow(): boolean {
  return isTauri();
}

/** Narrower default columns on a phone: 380px of a 390px screen is not a sidebar. */
function defaultWidths(device: Device): PaneWidths {
  return device === "phone" ? { sidebar: 168, list: 240 } : { ...DEFAULT_WIDTHS };
}

function isMode(value: unknown): value is PaneMode {
  return value === 1 || value === 2 || value === 3;
}

function windowSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Whether the user asked their system not to animate things.
 *
 * Read at load only, to pick the *starting* feel: someone who asked the system
 * for less motion should not be given a bounce they did not ask for, but the
 * setting stays on the panel and stays theirs — an explicit choice is stored and
 * honoured, reduced motion or not.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

class LayoutState {
  desired = $state<PaneMode>(1);
  /**
   * What the panes remember, and the only number the layout is derived from.
   *
   * The sidebar is shared by two and three panes, the posts column is kept per
   * mode, and the article keeps a width of its own. `thresholds` below is
   * arithmetic on this, not a separate setting, so a drag and a slider can never
   * disagree about where the panes are.
   */
  panes = $state<PaneLayout>({ ...DEFAULT_LAYOUT });
  /** Width of the pane container, in CSS pixels. */
  available = $state(1440);
  /** Height of the window, in CSS pixels: what makes a frame portrait. */
  height = $state(900);
  /**
   * The width at which a second and a third pane appear. Device-local, like the
   * pane widths themselves: "wide enough for three" on a 27" screen is not wide
   * enough on a laptop.
   */
  thresholds = $state<PaneThresholds>({ ...THRESHOLDS.desktop });
  device = $state<Device>("desktop");
  /**
   * False until the user picks a mode. While it is false the mode follows the
   * device — portrait phone opens in one column, landscape in three — and a
   * rotation is free to change it. Once they choose, rotation leaves it alone.
   */
  chosen = $state(false);

  /**
   * The first pane folded away.
   *
   * A preference, not a width: collapsing leaves the dragged widths untouched,
   * so opening it again puts the sidebar back exactly as it was. One column has
   * nothing to fold into, so the flag is ignored there.
   */
  sidebarCollapsed = $state(false);

  /**
   * What a mode press does with the width a pane no longer needs.
   *
   * True (the default): the window is the sum of the panes that mode draws, so
   * 3 → 2 slides the article out and takes its width with it, and every pane
   * keeps the width it was given. False: the window stays where it is and the
   * posts column takes the difference, which is what two panes sharing a wide
   * window looks like. Both are honest; they are just different answers.
   */
  private keepWidthsWanted = $state(true);

  /**
   * Whether the frame follows the panes that are left.
   *
   * The panel's answer, except in a portrait frame — a phone held upright, a
   * tablet upright, a window dragged taller than it is wide. There is no spare
   * width beside a portrait frame to give a pane, and asking the window for it
   * is asking it to become landscape; so a portrait frame shares what it has,
   * which is the "Keep window" answer, and chooses again the moment it is turned
   * or widened. The setting itself is untouched, so the shape you left is the
   * shape you come back to in a frame wide enough to draw it.
   */
  get keepWidths(): boolean {
    return this.keepWidthsWanted && !this.portrait;
  }

  /** A frame taller than it is wide. */
  private get portrait(): boolean {
    return this.height > this.available;
  }

  /**
   * The frame "Keep window" last had, remembered across a toggle.
   *
   * `null` until the setting is switched on for the first time, which is the
   * honest answer for a fresh install: there is no other mode's frame to go
   * back to, so switching off leaves the window where it is. Persisted with the
   * rest of the layout, but never applied at launch (see `SavedLayout`).
   */
  keepWindowWidth = $state<number | null>(null);

  /**
   * How a press moves the columns.
   *
   * A preference, saved with the layout: the mode state changes the instant the
   * button is pressed either way, and this only decides whether the drawn
   * columns catch up in one frame or over ~150ms. `off` is a real option, and
   * the starting point for a reader whose system asks for reduced motion.
   */
  motion = $state<PaneMotion>(DEFAULT_MOTION);

  /**
   * Bumped by every press that moves the panes.
   *
   * The view watches this counter to know that a layout change was *asked for*,
   * and may therefore be drawn over time. A change that arrives from a window
   * resize, a threshold slider or a divider drag does not bump it, so those
   * still land in a single frame — animating a resize the user is making by hand
   * would be lag on the thing they are dragging.
   */
  pressSeq = $state(0);

  /**
   * Draw three panes as posts above the article instead of beside it.
   *
   * A different arrangement of the same mode, not a fourth one: the mode press,
   * the widths and `keepWidths` keep their meaning, and only the grid and the
   * width three panes need change. Saved with the rest of the layout, so the
   * shape you left is the shape you come back to.
   */
  stacked = $state(false);

  /**
   * How much of the stacked right column is the post list.
   *
   * A fraction rather than a height: the split survives a window resize, and a
   * short window is handled where it is applied (`clampShare`), not by
   * rewriting the stored number.
   */
  stackShare = $state<number>(STACK_SHARE.fallback);

  /**
   * The article above the post list instead of below it.
   *
   * The two panes keep their identities and only trade places, so this is a
   * saved layout preference like `stacked` itself — the shape you left is the
   * shape you come back to. The split is measured from the top of the column,
   * so a swap moves no edge: half stays half.
   */
  stackSwapped = $state(false);

  /**
   * The half of the stacked column that is tucked away, if any.
   *
   * Deliberately temporary: never written to storage. A start with half the
   * column missing would read as a bug rather than as something the user asked
   * for a minute ago and forgot, which is exactly what a tuck is. It also lives
   * and dies with the arrangement — `settle()` puts the pane back as soon as no
   * stacked pair is on screen — because a tuck you cannot see is a pane that
   * comes back hidden for no reason.
   */
  stackTuck = $state<StackTuck>(null);

  /**
   * What this device can be offered.
   *
   * One named list instead of `if (mobile)` in each panel: the settings panel,
   * the pane switch and the gutter all ask the same question, and the answer has
   * to be the same in all three.
   */
  get caps(): Capabilities {
    return capabilitiesFor(this.device, isTauriWindow());
  }

  /**
   * What is actually drawn at this width.
   *
   * Held in state rather than computed on the spot, because the answer has to
   * remember what it was: `effectiveMode` only changes it once the window is
   * past the boundary by `MODE_HYSTERESIS`, which is what stops a resize from
   * stuttering across a threshold and stops the threshold sliders from
   * rearranging the panes while they are still being dragged.
   */
  mode = $state<PaneMode>(1);

  /**
   * Until when a measurement belongs to a mode press.
   *
   * A press asks the window for a width. The ResizeObserver reports that width
   * whenever the window manager gets round to it — before the resize call
   * resolves as often as after — and with two presses in flight the reports can
   * arrive in either order. Every measurement inside this window is answered at
   * once instead of being banded, so a press is never undone by the 120px dead
   * zone it just moved into. A timestamp rather than a single mode, because a
   * second press must not take the first one's pending measurement away.
   */
  private pressUntil = 0;

  /**
   * The width a press asked the window for, while the window is still on its way.
   *
   * A press that fits the window to the panes changes the frame's width, and the
   * ResizeObserver reports that change over several ticks — one per step the
   * window manager takes. Drawing from the measured width meant recomputing the
   * track list on every tick, and under a transition each of those is a new
   * target: the columns fly towards the width of the old frame, then turn round
   * and come back. So while a press is in flight the drawn width is the one the
   * press asked for, which makes the track list change exactly once, and the
   * measurement is taken as the truth again when it arrives (or when the grace
   * window runs out, so a refused resize cannot leave the frame drawing a width
   * it never reached). `null` means "nothing in flight: the frame is what it is".
   */
  private pressTarget: number | null = null;

  /**
   * The width to draw at: the width a press asked for, until the window agrees.
   *
   * `available` is what the frame measures right now — the truth, but a truth
   * that travels. Everything that *draws* reads this instead, so a slide has one
   * geometry to aim at, and everything that *measures* (a drag's delta, a
   * threshold's band) keeps reading `available`.
   */
  get drawn(): number {
    return this.pressTarget ?? this.available;
  }

  /** One resize at a time, in press order: see `chooseMode()`. */
  private resizing: Promise<unknown> = Promise.resolve();

  /**
   * Recompute the drawn mode. `banded` is false where the answer should be
   * immediate — an explicit choice, or the first paint — and true everywhere a
   * number can pass through the boundary by accident.
   */
  private settle(banded = true): void {
    const before = this.mode;
    // Which widths decide whether a mode fits depends on which is following
    // which. Keeping the panes, the window is fitted to them, so the tuned
    // thresholds are the honest test. Sharing the window, the panes squeeze and
    // only the mode's floor can refuse — testing the tuned sums demoted three
    // panes in a window that has room for three, which is what made the third
    // pane pop out and the window grow instead.
    const limits = this.keepWidths ? this.thresholds : floorThresholds(this.device);
    this.mode = effectiveMode(
      this.desired,
      this.drawn,
      this.device,
      limits,
      banded ? this.mode : undefined,
    );
    // A tuck belongs to a stacked pair that is actually on screen — the
    // three-pane column, or the one-pane walking surface that draws the same
    // pair on a phone. Anywhere else (side by side, or the stack switched off)
    // it is a hidden pane with nothing left to explain why, so the pane comes
    // back rather than waiting to surprise the next visit.
    if (this.stackTuck !== null && (!this.stacked || this.mode === 2)) this.stackTuck = null;
  }

  /**
   * Re-derive the thresholds from the panes.
   *
   * Called after every width change — a drag, a nudge, a reset, a slider — so
   * the settings panel is a read-out of the layout that exists rather than a
   * second opinion about it.
   */
  private syncThresholds(): void {
    // `one` is pane one's own width, not a third number: the slider and a
    // dragged divider write the same value, so the settings panel and the
    // layout cannot disagree about how wide the first column is.
    // `stacked` is part of the question: how wide three panes have to be
    // depends on whether they are three columns or a column and a stack.
    this.thresholds = thresholdsFor(this.panes, this.device, this.panes.sidebar, this.stacked);
  }

  /**
   * The window width a mode needs: the panes the user shaped, floored by the
   * mode's own minimum. This is what a mode button asks for.
   */
  widthFor(mode: PaneMode): number {
    return widthFor(mode, this.device, this.thresholds);
  }

  /** What the panes themselves come to, before the threshold floors. */
  paneWidthFor(mode: PaneMode): number {
    return neededWidth(this.panes, mode, this.device, this.stacked);
  }

  /**
   * The monitor's width, once known. `null` until asked.
   *
   * It caps two things that would otherwise be lies: a slider that offers a
   * width the screen cannot show, and a mode press that grows the window past
   * the edge of the display.
   */
  monitor = $state<number | null>(null);

  /** What a threshold slider may say here: the setting's own ceiling, or the screen. */
  limitFor(which: keyof PaneThresholds): number {
    const ceiling = THRESHOLD_LIMITS[which].max;
    return this.monitor === null ? ceiling : Math.min(ceiling, this.monitor);
  }

  /**
   * The slider's range. The top is the screen, except when the setting already
   * sits above it — a window can be wider than the display it is judged by
   * (another monitor, a stale setting), and a slider whose maximum is below its
   * own value renders as a thumb pinned at the end and a number that cannot be
   * typed. The value stays representable; new values still stop at the screen.
   */
  rangeFor(which: keyof PaneThresholds): { min: number; max: number } {
    const min = THRESHOLD_LIMITS[which].min;
    return { min, max: Math.max(this.limitFor(which), this.thresholds[which] ?? min) };
  }

  /** Ask the screen how wide it is. Cheap, and idempotent. */
  async loadMonitor(): Promise<number | null> {
    if (this.monitor !== null) return this.monitor;
    const width = await screenWidth();
    // Only if nothing answered while this was asking: the answer crosses an IPC
    // boundary in the native build, and a value that arrived in the meantime is
    // the newer truth, not a duplicate.
    if (width !== null && this.monitor === null) this.monitor = width;
    return this.monitor;
  }

  /**
   * A mode button: record the choice, then ask the window to fit it.
   *
   * The record comes first so the panes change even where the window cannot —
   * a browser tab, a phone — and the press is never silently swallowed. After a
   * real resize the observer's settle would be banded and could hold the old
   * mode for another 120px, so the mode we asked for is remembered and the next
   * measurement is answered without the band.
   */
  async chooseMode(mode: PaneMode): Promise<boolean> {
    // Asked for in the background, never awaited: a press has to change the mode
    // now. Awaiting it here put the state change behind an IPC round trip, and
    // two fast clicks could write their modes in the order the calls resolved.
    void this.loadMonitor();
    const limit = this.monitor;
    // Two panes to three extends what is on screen: the columns keep the widths
    // they are drawing and the article goes to their right, with the window
    // growing by exactly that much. Without this the posts column jumped to its
    // remembered three-pane width and the article took the remainder, so a
    // layout you had shaped by hand came back rearranged.
    // Only when the window is too narrow for the three columns it already has:
    // a window that is wide enough keeps its panes and the slack goes to the
    // article, which is what makes 2 ↔ 3 repeatable instead of marching the
    // window rightwards on every press.
    if (
      mode === 3 &&
      this.mode === 2 &&
      this.keepWidths &&
      this.available < this.thresholds.three
    ) {
      this.panes = extendToThree(this.panes, this.available, this.device, limit, this.stacked);
      this.syncThresholds();
    }
    this.setMode(mode);
    const target = fitTarget(
      mode,
      this.available,
      this.device,
      this.thresholds,
      limit,
      this.keepWidths,
    );
    if (target === null) {
      // Nothing to resize to, so nothing to hold — and a hold left over from an
      // earlier press would otherwise draw a frame this press never asked for.
      this.pressTarget = null;
      this.settle(false);
      return false;
    }
    // Armed before the resize travels, not after it resolves. The measurement
    // usually arrives while the call is still in flight; a banded one would see
    // the old mode, decide the window is too narrow, and leave the widened
    // window drawing one stretched pane.
    this.pressUntil = Date.now() + PRESS_GRACE_MS;
    // And the width to draw at is the one being asked for, from this moment: the
    // slide has one geometry to aim at instead of one per resize tick (see
    // `drawn`). A press that does not resize never sets this, so a fold, a swap
    // and a press in a window that is already the right size still draw from the
    // frame they are in.
    this.pressTarget = target;
    this.holdFor(target);
    // Presses are answered in order. Two overlapping setSize calls are finished
    // in whichever order the window manager gets to them and the last to arrive
    // owns the width, so the window could keep the size of a superseded press.
    const ask = this.resizing.then(() => fitWindowTo(target));
    this.resizing = ask.catch(() => false);
    // A resize that comes back refused corrects the frame at once instead of
    // waiting out the grace window: nothing is on its way.
    void ask.then(
      (ok) => {
        if (!ok) this.release(target);
      },
      () => this.release(target),
    );
    return await ask;
  }

  /**
   * Let go of a press's width: the frame it asked for is not coming.
   *
   * A refused resize, a window manager that ignores `setSize`, a phone, a
   * browser tab: the measurement that releases the hold (`setAvailable`) never
   * arrives, and the frame would keep drawing a width it does not have. Called
   * by the watchdog below and by a resize call that comes back false, so the
   * layout corrects itself at once rather than half a second later.
   */
  private release(target: number): void {
    if (this.pressTarget !== target) return;
    this.pressTarget = null;
    // The frame is whatever it measures now, so re-answer the mode question and
    // the tracks at once rather than at the next resize.
    this.settle(false);
  }

  /** The watchdog for a press whose resize is never reported. */
  private holdFor(target: number): void {
    setTimeout(() => this.release(target), PRESS_GRACE_MS + 60);
  }

  /**
   * A slider.
   *
   * `one` is pane one's width, so writing it moves the sidebar — the same value
   * a dragged divider writes, which is what keeps the panel and the layout from
   * disagreeing. The other two are sums of the panes, so writing one has to move
   * the panes: the posts column (and, in three panes, the article in proportion)
   * takes the difference, and the sidebar is left alone. Anything the window
   * cannot hold is trimmed by `settleRequirement`, so the slider can never leave
   * behind a layout that demotes itself.
   */
  setThreshold(which: keyof PaneThresholds, px: number): void {
    // A width wider than the screen is a number with no effect except a window
    // that cannot honour it, so the slider cannot write one.
    const legal = Math.min(px, this.limitFor(which));
    if (which === "one") {
      const mins = minimums(this.device);
      const width = Math.min(Math.max(Math.round(legal), mins.sidebar), this.limitFor("one"));
      this.panes = settleRequirement(
        { ...this.panes, sidebar: width },
        this.mode,
        this.available,
        this.device,
        this.stacked,
      );
      this.syncThresholds();
    } else {
      const mode: PaneMode = which === "three" ? 3 : 2;
      const scaled = scaleLayout(this.panes, mode, legal, this.device);
      this.panes = settleRequirement(scaled, mode, this.available, this.device, this.stacked);
      this.syncThresholds();
    }
    // Banded: the slider changes a number the layout reads, and the panes must
    // not rearrange while the pointer is still on the track.
    this.settle();
    this.save();
  }

  /**
   * One mode back to the shipped columns, keeping the sidebar and the other
   * mode's posts width: the reset button on that row, not a reset of everything.
   */
  resetWidths(mode: 2 | 3): void {
    const defaults = defaultWidths(this.device);
    const next: PaneLayout =
      mode === 3
        ? { ...this.panes, list3: defaults.list, article: DEFAULT_LAYOUT.article }
        : { ...this.panes, list2: defaults.list };
    this.panes = settleRequirement(intentLayout(next, this.device), mode, this.available, this.device, this.stacked);
    this.syncThresholds();
    this.settle();
    this.save();
  }

  /** Whether a mode's columns differ from the shipped ones. */
  paneEdited(mode: 2 | 3): boolean {
    const defaults = defaultWidths(this.device);
    return mode === 3
      ? this.panes.list3 !== defaults.list || this.panes.article !== DEFAULT_LAYOUT.article
      : this.panes.list2 !== defaults.list;
  }

  /** Back to the shipped shape: default panes, and the default one-pane width. */
  resetThresholds(): void {
    const defaults = defaultWidths(this.device);
    this.panes = intentLayout(
      { ...DEFAULT_LAYOUT, sidebar: defaults.sidebar, list2: defaults.list, list3: defaults.list },
      this.device,
    );
    this.thresholds = { ...THRESHOLDS[this.device] };
    this.syncThresholds();
    this.settle();
    this.save();
  }

  /**
   * True when the user asked for more panes than fit.
   *
   * Gated on `chosen` so a narrow window on a fresh install — which opens
   * wanting three by default — does not announce that it is squeezed. Nothing
   * was squeezed: the default simply does not fit yet.
   */
  get squeezed(): boolean {
    return this.chosen && this.mode < this.desired;
  }

  /**
   * The column tracks, for the arrangement actually on screen.
   *
   * `drawnStack` is passed by the view because the stack is not only a property
   * of the layout: in one column the pair is drawn on the *article* level, and
   * the layout cannot see the walk. The default keeps the getter usable from
   * anywhere else.
   */
  columns(drawnStack = this.stacked): string {
    return gridTemplate(this.mode, this.shown, {
      available: this.drawn,
      collapsed: this.collapsed,
      stacked: drawnStack,
      keepWidths: this.keepWidths,
    });
  }

  get template(): string {
    return this.columns();
  }

  /**
   * The rows of the stacked column: posts, seam, article.
   *
   * Four tracks whether or not the stack is drawn, so the split can slide open
   * instead of snapping (`FLAT_ROWS` is the same list with no seam in it). One
   * string for the only place that draws it, so a dragged split and the phone
   * cannot disagree about how much of the column the posts take.
   */
  rows(drawnStack: boolean): string {
    if (!drawnStack) return FLAT_ROWS;
    return stackTemplate(this.stacked ? this.stackShare : STACK_SHARE.fallback);
  }

  get stackRows(): string {
    return this.rows(this.stacked);
  }

  /** Which pane is drawn above the seam. Posts unless the order is swapped. */
  get stackTop(): StackPane {
    return stackTopPane(this.stackSwapped);
  }

  /** Which pane is drawn below it. */
  get stackBottom(): StackPane {
    return stackBottomPane(this.stackSwapped);
  }

  /**
   * The widths to draw: the stored intent, fitted to this window and mode.
   *
   * `widths` is what the user asked for and is only ever changed by them. This
   * is what fits. Keeping the two apart is what stops a narrow window, or a
   * visit to one column, from rewriting the layout — the intent survives and the
   * panes come back the way they were left when there is room again.
   */
  get shown(): PaneWidths {
    return clampWidths(
      layoutWidths(this.panes, this.mode),
      this.mode,
      this.drawn,
      this.device,
      this.stacked,
    );
  }

  /**
   * True only in three panes.
   *
   * Folding the feeds pane in two columns leaves a single full-width column,
   * which is what one-pane mode already is — and it arrives without the
   * one-pane surface that walks feeds → posts → article with a way back. So the
   * fold is offered where it has something to leave behind: the posts list.
   */
  get collapsed(): boolean {
    return this.sidebarCollapsed && this.mode === 3;
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.press();
    this.save();
  }

  /**
   * The sizing mode: keep the pane widths (and fit the window to them) or share
   * the window (and let the panes fit it).
   *
   * Both are settings about the *window*, so the frame on screen belongs to the
   * one being left and the one being entered has to ask for its own. Without
   * that, turning this on drew the tuned widths into a window still sized by the
   * other mode, and turning it off fitted the panes into a frame that was the
   * tuned sum: for a moment the layout belonged to neither sizing mode, and only
   * a later press or resize put it right.
   *
   * The two remember different things, which is why only one of them needs a
   * number kept: keeping the panes, the frame is their own sum and `fitTarget`
   * can rebuild it from the layout at any time. Sharing the window, the frame is
   * whatever the user last had, and nothing else in the app knows it — so it is
   * written down, and `keepWindowWidth` is what the toggle comes back to.
   */
  setKeepWidths(value: boolean): void {
    if (this.keepWidthsWanted === value) return;
    // Leaving "Keep window": the frame it is in is the one to come back to.
    // Written before the flag flips, because the flag is what decides which
    // width the panes are drawn at from here.
    // A frame that has not been measured yet is not a frame to come back to.
    if (value && this.available > 0) this.keepWindowWidth = Math.round(this.available);
    this.keepWidthsWanted = value;
    // The frame being entered, through the same queue, the same press and the
    // same grace window a mode button uses: this names what it wants, so the
    // band must not hold the mode it is leaving.
    const target = this.sizingFrame(value);
    this.pressTarget = target;
    if (target !== null) {
      this.pressUntil = Date.now() + PRESS_GRACE_MS;
      this.holdFor(target);
    }
    this.settle(false);
    // One press per toggle, so the columns move rather than snap — and one, not
    // one per resize tick: the tracks are drawn from `drawn` while the window
    // travels.
    this.press();
    this.save();
    if (target === null) return;
    const ask = this.resizing.then(() => fitWindowTo(target));
    this.resizing = ask.catch(() => false);
    void ask.then(
      (ok) => {
        if (!ok) this.release(target);
      },
      () => this.release(target),
    );
  }

  /**
   * The frame the sizing mode being entered wants, or `null` when there is none.
   *
   * Entering "Keep widths" it is the tuned sum — exactly what a press asks for
   * in that mode — and entering "Keep window" it is the frame that mode last
   * had. Capped at the screen the way a press is: a remembered frame from a
   * larger display would be moved onto this one by the window manager.
   */
  private sizingFrame(value: boolean): number | null {
    if (value) {
      return fitTarget(
        this.desired,
        this.available,
        this.device,
        this.thresholds,
        this.monitor,
        true,
      );
    }
    const remembered = this.keepWindowWidth;
    if (remembered === null) return null;
    const cap = this.monitor === null ? Number.POSITIVE_INFINITY : this.monitor;
    const target = Math.round(
      remembered > this.available ? Math.min(remembered, cap) : remembered,
    );
    if (!Number.isFinite(target) || target <= 0) return null;
    if (Math.abs(target - this.available) <= 1) return null;
    return target;
  }

  /**
   * How the columns move when a press changes the layout.
   *
   * Written at once and saved: it is a preference about drawing, not a mode, and
   * nothing about the layout changes with it. It is offered even to a reader
   * whose system asks for reduced motion — they start at `off`, and the choice
   * from there is theirs.
   */
  setMotion(next: PaneMotion): void {
    if (!isPaneMotion(next) || this.motion === next) return;
    this.motion = next;
    this.save();
  }

  /** A press that moves the panes: the view may draw the change over time. */
  private press(): void {
    this.pressSeq += 1;
  }

  /**
   * Side by side or stacked, for three panes.
   *
   * The thresholds are re-derived first, because the window three panes need is
   * not the same number in both arrangements — stacked three fit where side by
   * side three do not — and then the drawn mode is settled without the band: a
   * press that names an arrangement is a choice, not the accident the dead zone
   * exists for. Nothing is resized here: the window is the user's, and the mode
   * that now fits is simply drawn.
   */
  setStacked(on: boolean): void {
    if (this.stacked === on) return;
    this.stacked = on;
    this.syncThresholds();
    this.settle(false);
    this.press();
    this.save();
  }

  /**
   * Trade the two panes' places in the column.
   *
   * Not a re-division: the share is a fraction of the *column*, so it is left
   * alone and the seam does not move. Half stays half, and a 70/30 split stays
   * a 70/30 split with the other pane above it — which is what "swap" means
   * when the split belongs to the column rather than to one of the panes.
   */
  toggleStackSwap(): void {
    this.stackSwapped = !this.stackSwapped;
    this.save();
  }

  /**
   * Put one half of the column away, or bring it back.
   *
   * `side` is the slot, not the pane, because that is what the controls in the
   * seam name: "whichever is on top". Pressing the same side again restores it;
   * pressing the other side replaces it, so exactly one pane is ever away.
   *
   * No `save()`: a tuck is temporary by definition, and nothing else about the
   * layout changes — the window, the sidebar and the share are all untouched,
   * so the pane comes back exactly the size it left.
   */
  tuckStack(side: StackSide): void {
    this.stackTuck = nextTuck(this.stackTuck, side);
  }

  /**
   * Absolute share during a stacked drag, 0–1.
   *
   * Like `dragTo`, no write: this runs once per frame while the pointer moves.
   * The pixel floors are applied by the gutter, which knows how tall the column
   * is; this only keeps the fraction in the range the setting allows.
   */
  dragShare(share: number): void {
    if (!Number.isFinite(share)) return;
    this.stackShare = Math.min(Math.max(share, STACK_SHARE.min), STACK_SHARE.max);
  }

  /** The write for a stacked drag, called once when it ends. */
  commitShare(): void {
    this.dragShare(this.stackShare);
    this.save();
  }

  /** A keyboard nudge on the stacked seam: 2%, or 8% with Shift. */
  nudgeShare(delta: number): void {
    this.dragShare(this.stackShare + delta);
    this.save();
  }

  /** Double-click on the stacked seam: half, the shape it ships with. */
  resetShare(): void {
    this.dragShare(STACK_SHARE.fallback);
    this.save();
  }

  get gutters(): number {
    return this.mode === 1 ? 0 : 1;
  }

  load(): void {
    void this.loadMonitor();
    const size = windowSize();
    this.device = detectDevice();
    this.available = size.width;
    this.height = size.height;
    this.thresholds = { ...THRESHOLDS[this.device] };
    // Reduced motion picks the starting feel, not the available ones: a press
    // that moves no pixels is the honest default for someone who asked the
    // system for less movement, and the row stays on the panel for them.
    this.motion = prefersReducedMotion() ? "off" : DEFAULT_MOTION;
    this.desired = defaultModeFor({
      phone: this.device === "phone",
      ...size,
      thresholds: this.thresholds,
    });
    const defaults = defaultWidths(this.device);
    this.panes = intentLayout(
      { ...DEFAULT_LAYOUT, sidebar: defaults.sidebar, list2: defaults.list, list3: defaults.list },
      this.device,
    );
    this.syncThresholds();
    if (typeof localStorage === "undefined") {
      this.settle(false);
      return;
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) {
        this.settle(false);
        return;
      }
      const saved = JSON.parse(raw) as Partial<SavedLayout>;
      // Any stored mode is honoured, not only one the user picked deliberately.
      // Opening at the layout you left is the promise; requiring a mode-button
      // press to qualify meant a dragged-to-fits window came back changed.
      if (isMode(saved.mode)) {
        this.desired = saved.mode;
        this.chosen = saved.chosen === true;
      }
      if (typeof saved.collapsed === "boolean") this.sidebarCollapsed = saved.collapsed;
      if (typeof saved.keepWidths === "boolean") this.keepWidthsWanted = saved.keepWidths;
      // The frame the other sizing mode had. Read, clamped, and deliberately not
      // acted on: the window at launch is the OS's to size, so this is only used
      // when the toggle is used — including after a relaunch.
      if (typeof saved.keepWindowWidth === "number" && Number.isFinite(saved.keepWindowWidth)) {
        const floor = minimums(this.device).sidebar;
        this.keepWindowWidth = Math.min(Math.max(Math.round(saved.keepWindowWidth), floor), KEEP_WINDOW_MAX);
      }
      // A saved feel is theirs, reduced motion or not: the system only chose the
      // default they started from.
      if (isPaneMotion(saved.motion)) this.motion = saved.motion;
      // A save from before the stack existed simply loads side by side, which is
      // what it was looking at.
      this.stacked = saved.stacked === true;
      // Saved with the rest of the arrangement: an order the user picked is a
      // preference, so it comes back with the layout. Only an explicit `true`
      // swaps — an older save, or anything malformed, is the shipped order.
      this.stackSwapped = saved.stackSwapped === true;
      this.stackShare =
        typeof saved.stackShare === "number" && Number.isFinite(saved.stackShare)
          ? Math.min(Math.max(saved.stackShare, STACK_SHARE.min), STACK_SHARE.max)
          : STACK_SHARE.fallback;
      const panes = saved.panes;
      if (panes && typeof panes.sidebar === "number" && typeof panes.list3 === "number") {
        this.panes = intentLayout(
          {
            sidebar: panes.sidebar,
            list2: typeof panes.list2 === "number" ? panes.list2 : panes.list3,
            list3: panes.list3,
            article: typeof panes.article === "number" ? panes.article : DEFAULT_LAYOUT.article,
          },
          this.device,
        );
      } else {
        const widths = saved.widths;
        if (widths && typeof widths.sidebar === "number" && typeof widths.list === "number") {
          // A save from before the panes remembered themselves: one sidebar, one
          // posts width. Its three-pane threshold becomes the article's width, so
          // the window the user had already chosen survives the upgrade.
          this.panes = layoutFromWidths(widths, saved.thresholds?.three, this.device);
        }
      }
      // `one` is the only threshold that is still a setting; the other two are
      // derived, so an older saved value for them is deliberately ignored.
      if (typeof saved.thresholds?.one === "number") {
        this.thresholds = clampThresholds({ ...this.thresholds, one: saved.thresholds.one }, this.device);
      }
      this.syncThresholds();
    } catch {
      // A corrupt setting is not worth a dialog: fall back to the defaults.
    }
    // First paint: the window is what it is, so the band has nothing to decide.
    this.settle(false);
  }

  /**
   * One column to the left, as the Left key asks: 3 → 2 → 1, stopping at one.
   *
   * No window resize: the buttons own that. A key that changed the window's size
   * would be a change you cannot undo with the same key.
   */
  collapseOne(): boolean {
    if (this.mode <= 1) return false;
    this.setMode((this.mode - 1) as PaneMode);
    return true;
  }

  setMode(mode: PaneMode): void {
    this.desired = mode;
    this.chosen = true;
    // Asked for, so answered at once: the band is for accidents, not for a
    // press that named the mode it wanted.
    this.settle(false);
    // The panes may now draw the difference over a moment rather than in one
    // frame — but the mode above has already changed, so the press itself is
    // never waiting on the drawing.
    this.press();
    this.save();
  }

  /** Called from a ResizeObserver on the pane container, and on rotation. */
  setAvailable(px: number): void {
    if (!Number.isFinite(px) || px <= 0) return;
    this.available = px;
    this.height = windowSize().height;
    // The window has arrived, or given up: either way the measurement is the
    // truth again from here, so a resize the user makes is followed at once
    // instead of being held at the width of a press that is over.
    if (this.pressTarget !== null) {
      const landed = Math.abs(px - this.pressTarget) <= 2;
      const expired = Date.now() >= this.pressUntil;
      if (landed || expired) this.pressTarget = null;
    }
    if (Date.now() < this.pressUntil) {
      // A press asked for this width: answer at once rather than making the
      // mode wait out a band that exists for accidental drags.
      this.settle(false);
      this.save();
      return;
    }
    // On a phone that has not been told otherwise, the orientation decides:
    // portrait one column, landscape three.
    if (!this.chosen && this.device === "phone") {
      const size = windowSize();
      const next = defaultModeFor({ phone: true, ...size, thresholds: this.thresholds });
      if (next !== this.desired) {
        this.desired = next;
        this.settle(false);
        return;
      }
    }
    this.settle();
    // A resize changes what is drawn, never what was asked for. `shown` fits the
    // stored widths to the new width on every read, so there is nothing to write
    // here — which is why shrinking a window no longer shrinks the layout.
  }

  /**
   * Absolute width during a drag: the gutter sends where the edge is, not a delta.
   *
   * Deliberately does not write storage — this runs once per frame while the
   * pointer moves. `commit()` is the write, called when the drag ends.
   */
  dragTo(which: "sidebar" | "list", width: number): void {
    // The gutter sends the absolute edge, measured from the drawn width, so the
    // intent becomes exactly where the edge was let go. Mid-drag the thresholds
    // are re-derived but nothing is trimmed: a drag out and back must come back
    // to the same posts width, so the giving-way happens once, on release.
    this.write(which, width);
    this.syncThresholds();
  }

  /**
   * Where a drag lands: the sidebar always, the posts column of the mode being
   * dragged. Three panes and two panes keep their own posts width, so narrowing
   * the middle column beside an article does not narrow it alone.
   */
  private write(which: "sidebar" | "list", width: number): void {
    const key: keyof PaneLayout =
      which === "sidebar" ? "sidebar" : this.mode === 3 ? "list3" : "list2";
    this.panes = intentLayout({ ...this.panes, [key]: width }, this.device);
  }

  /**
   * Persist the current layout: after a drag, so a resize survives a restart.
   *
   * This is also where a requirement that outgrew the window is trimmed back to
   * it — the flexible pane gives way, and the button later asks for exactly the
   * window the panes were shaped in.
   */
  commit(): void {
    this.panes = settleRequirement(this.panes, this.mode, this.available, this.device, this.stacked);
    this.syncThresholds();
    this.save();
  }

  reset(which: "sidebar" | "list"): void {
    const fallback = this.device === "phone" ? defaultWidths(this.device)[which] : resetPane(which);
    this.write(which, fallback);
    this.commit();
  }

  nudge(which: "sidebar" | "list", direction: -1 | 1, big = false): void {
    const widths = nudge(this.shown, which, direction, big);
    this.write(which, widths[which]);
    this.commit();
  }

  get minSidebar(): number {
    return minimums(this.device).sidebar;
  }

  /** The drawn width of a pane, which is what a gutter drag starts from. */
  width(which: "sidebar" | "list"): number {
    return this.shown[which];
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mode: this.desired,
          panes: this.panes,
          // Only the one-pane width is a setting; two and three are sums the
          // panes already carry.
          thresholds: { one: this.thresholds.one },
          chosen: this.chosen,
          collapsed: this.sidebarCollapsed,
          keepWidths: this.keepWidthsWanted,
          keepWindowWidth: this.keepWindowWidth,
          motion: this.motion,
          stacked: this.stacked,
          stackSwapped: this.stackSwapped,
          stackShare: this.stackShare,
        }),
      );
    } catch {
      // Storage full or blocked: the layout still works for this session.
    }
  }
}

export const layout = new LayoutState();

// Read before the first paint: the panes are in the first frame, so a layout
// loaded in `onMount` would draw the default shape and then jump to the saved
// one. This is the same reason `chrome` loads at module scope.
layout.load();
