/**
 * The pane layout, as a setting rather than a consequence of the window size.
 *
 * The mode the user picked is kept even when the window is too narrow to draw
 * it: the app renders what fits and says it is squeezed, so widening the window
 * restores the layout with no click. Widths are per device and re-clamped on
 * resize, because a width saved on a 27" screen would otherwise leave a 40px
 * article column on a laptop.
 */

import {
  DEFAULT_WIDTHS,
  THRESHOLDS,
  type Device,
  type PaneMode,
  type PaneThresholds,
  type PaneWidths,
  clampThresholds,
  clampWidths,
  defaultModeFor,
  effectiveMode,
  gridTemplate,
  minimums,
  nudge,
  resetPane,
  widthFor,
} from "../lib/panes";

const STORAGE_KEY = "hardlyreader.layout.v1";

interface SavedLayout {
  mode: PaneMode;
  widths: PaneWidths;
  /** Where the second and third pane appear, in CSS pixels. */
  thresholds?: Partial<PaneThresholds>;
  /** True once the user has picked a mode themselves. */
  chosen?: boolean;
  /** The first pane folded away. */
  collapsed?: boolean;
}

/** Phone, for layout purposes: a coarse pointer and a small shortest side. */
function detectDevice(): Device {
  if (typeof window === "undefined" || typeof matchMedia !== "function") return "desktop";
  const coarse = matchMedia("(pointer: coarse)").matches;
  const shortest = Math.min(window.screen?.width ?? 1440, window.screen?.height ?? 900);
  return coarse && shortest <= 500 ? "phone" : "desktop";
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
  widths = $state<PaneWidths>({ ...DEFAULT_WIDTHS });
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

  /** What can actually be drawn at this width. */
  get mode(): PaneMode {
    return effectiveMode(this.desired, this.available, this.device, this.thresholds);
  }

  /** The window width a mode needs, under the current thresholds. */
  widthFor(mode: PaneMode): number {
    return widthFor(mode, this.device, this.thresholds);
  }

  /** One threshold, or both when the other has to move out of the way. */
  setThreshold(which: keyof PaneThresholds, px: number): void {
    this.thresholds = clampThresholds({ ...this.thresholds, [which]: px }, this.device);
    this.widths = clampWidths(this.widths, this.mode, this.available, this.device);
    this.save();
  }

  resetThresholds(): void {
    this.thresholds = { ...THRESHOLDS[this.device] };
    this.widths = clampWidths(this.widths, this.mode, this.available, this.device);
    this.save();
  }

  /** True when the user asked for more panes than fit. */
  get squeezed(): boolean {
    return this.mode < this.desired;
  }

  get template(): string {
    return gridTemplate(this.mode, this.widths, this.collapsed);
  }

  /** True only where there is a sidebar to fold: never in one column. */
  get collapsed(): boolean {
    return this.sidebarCollapsed && this.mode !== 1;
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.save();
  }

  get gutters(): number {
    return this.mode === 1 ? 0 : 1;
  }

  load(): void {
    const size = windowSize();
    this.device = detectDevice();
    this.available = size.width;
    this.thresholds = { ...THRESHOLDS[this.device] };
    this.desired = defaultModeFor({
      phone: this.device === "phone",
      ...size,
      thresholds: this.thresholds,
    });
    this.widths = clampWidths(defaultWidths(this.device), this.mode, size.width, this.device);
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Partial<SavedLayout>;
      if (saved.chosen === true && isMode(saved.mode)) {
        this.chosen = true;
        this.desired = saved.mode;
      }
      if (typeof saved.collapsed === "boolean") this.sidebarCollapsed = saved.collapsed;
      if (saved.thresholds !== undefined) {
        this.thresholds = clampThresholds(saved.thresholds, this.device);
      }
      const widths = saved.widths;
      if (widths && typeof widths.sidebar === "number" && typeof widths.list === "number") {
        this.widths = clampWidths(
          { sidebar: widths.sidebar, list: widths.list },
          this.mode,
          this.available,
          this.device,
        );
      }
    } catch {
      // A corrupt setting is not worth a dialog: fall back to the defaults.
    }
  }

  setMode(mode: PaneMode): void {
    this.desired = mode;
    this.chosen = true;
    this.widths = clampWidths(this.widths, this.mode, this.available, this.device);
    this.save();
  }

  /** Called from a ResizeObserver on the pane container, and on rotation. */
  setAvailable(px: number): void {
    if (!Number.isFinite(px) || px <= 0) return;
    const changed = px !== this.available;
    this.available = px;
    // On a phone that has not been told otherwise, the orientation decides:
    // portrait one column, landscape three.
    if (!this.chosen && this.device === "phone") {
      const size = windowSize();
      const next = defaultModeFor({ phone: true, ...size, thresholds: this.thresholds });
      if (next !== this.desired) {
        this.desired = next;
        this.widths = clampWidths(this.widths, this.mode, px, this.device);
        return;
      }
    }
    if (changed) this.widths = clampWidths(this.widths, this.mode, px, this.device);
  }

  /** Absolute width during a drag: the gutter sends where the edge is, not a delta. */
  dragTo(which: "sidebar" | "list", width: number): void {
    this.widths = clampWidths({ ...this.widths, [which]: width }, this.mode, this.available, this.device);
  }

  reset(which: "sidebar" | "list"): void {
    const fallback = defaultWidths(this.device)[which];
    this.widths = clampWidths(
      { ...this.widths, [which]: this.device === "phone" ? fallback : resetPane(which) },
      this.mode,
      this.available,
      this.device,
    );
    this.save();
  }

  nudge(which: "sidebar" | "list", direction: -1 | 1, big = false): void {
    this.widths = clampWidths(
      nudge(this.widths, which, direction, big),
      this.mode,
      this.available,
      this.device,
    );
    this.save();
  }

  get minSidebar(): number {
    return minimums(this.device).sidebar;
  }

  width(which: "sidebar" | "list"): number {
    return this.widths[which];
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mode: this.desired,
          widths: this.widths,
          thresholds: this.thresholds,
          chosen: this.chosen,
          collapsed: this.sidebarCollapsed,
        }),
      );
    } catch {
      // Storage full or blocked: the layout still works for this session.
    }
  }
}

export const layout = new LayoutState();
