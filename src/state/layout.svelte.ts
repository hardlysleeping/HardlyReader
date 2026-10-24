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
  DEFAULT_WIDTHS,
  THRESHOLDS,
  THRESHOLD_LIMITS,
  type Device,
  type PaneLayout,
  type PaneMode,
  type PaneThresholds,
  type PaneWidths,
  clampThresholds,
  clampWidths,
  defaultModeFor,
  effectiveMode,
  fitTarget,
  extendToThree,
  gridTemplate,
  intentLayout,
  layoutFromWidths,
  layoutWidths,
  minimums,
  neededWidth,
  nudge,
  resetPane,
  scaleLayout,
  settleRequirement,
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
  keepWidths = $state(true);

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

  /** One resize at a time, in press order: see `chooseMode()`. */
  private resizing: Promise<unknown> = Promise.resolve();

  /**
   * Recompute the drawn mode. `banded` is false where the answer should be
   * immediate — an explicit choice, or the first paint — and true everywhere a
   * number can pass through the boundary by accident.
   */
  private settle(banded = true): void {
    const before = this.mode;
    this.mode = effectiveMode(
      this.desired,
      this.available,
      this.device,
      this.thresholds,
      banded ? this.mode : undefined,
    );
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
    this.thresholds = thresholdsFor(this.panes, this.device, this.panes.sidebar);
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
    return neededWidth(this.panes, mode, this.device);
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
    if (mode === 3 && this.mode === 2 && this.available < this.thresholds.three) {
      this.panes = extendToThree(this.panes, this.available, this.device, limit);
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
    if (target === null) return false;
    // Armed before the resize travels, not after it resolves. The measurement
    // usually arrives while the call is still in flight; a banded one would see
    // the old mode, decide the window is too narrow, and leave the widened
    // window drawing one stretched pane.
    this.pressUntil = Date.now() + PRESS_GRACE_MS;
    // Presses are answered in order. Two overlapping setSize calls are finished
    // in whichever order the window manager gets to them and the last to arrive
    // owns the width, so the window could keep the size of a superseded press.
    const ask = this.resizing.then(() => fitWindowTo(target));
    this.resizing = ask.catch(() => false);
    return await ask;
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
      );
      this.syncThresholds();
    } else {
      const mode: PaneMode = which === "three" ? 3 : 2;
      const scaled = scaleLayout(this.panes, mode, legal, this.device);
      this.panes = settleRequirement(scaled, mode, this.available, this.device);
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
    this.panes = settleRequirement(intentLayout(next, this.device), mode, this.available, this.device);
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

  get template(): string {
    return gridTemplate(this.mode, this.shown, this.collapsed);
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
    return clampWidths(layoutWidths(this.panes, this.mode), this.mode, this.available, this.device);
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
    this.save();
  }

  /** The setting itself: written at once, like every other choice here. */
  setKeepWidths(value: boolean): void {
    if (this.keepWidths === value) return;
    this.keepWidths = value;
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
    this.thresholds = { ...THRESHOLDS[this.device] };
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
      if (typeof saved.keepWidths === "boolean") this.keepWidths = saved.keepWidths;
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
    this.save();
  }

  /** Called from a ResizeObserver on the pane container, and on rotation. */
  setAvailable(px: number): void {
    if (!Number.isFinite(px) || px <= 0) return;
    this.available = px;
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
    this.panes = settleRequirement(this.panes, this.mode, this.available, this.device);
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
          keepWidths: this.keepWidths,
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
