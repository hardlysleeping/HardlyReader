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
  type PaneMode,
  type PaneWidths,
  clampWidths,
  effectiveMode,
  gridTemplate,
  nudge,
  resetPane,
} from "../lib/panes";

const STORAGE_KEY = "hardlyreader.layout.v1";

interface SavedLayout {
  mode: PaneMode;
  widths: PaneWidths;
}

function isMode(value: unknown): value is PaneMode {
  return value === 1 || value === 2 || value === 3;
}

/** First run: whatever this window looks like today, then it is the user's. */
function initialMode(width: number): PaneMode {
  if (width >= 1200) return 3;
  if (width >= 840) return 2;
  return 1;
}

class LayoutState {
  desired = $state<PaneMode>(1);
  widths = $state<PaneWidths>({ ...DEFAULT_WIDTHS });
  /** Width of the pane container, in CSS pixels. */
  available = $state(1440);

  /** What can actually be drawn at this width. */
  get mode(): PaneMode {
    return effectiveMode(this.desired, this.available);
  }

  /** True when the user asked for more panes than fit. */
  get squeezed(): boolean {
    return this.mode < this.desired;
  }

  get template(): string {
    return gridTemplate(this.mode, this.widths);
  }

  get gutters(): number {
    return this.mode === 1 ? 0 : 1;
  }

  load(): void {
    const width = typeof window === "undefined" ? 1440 : window.innerWidth;
    this.available = width;
    this.desired = initialMode(width);
    this.widths = clampWidths({ ...DEFAULT_WIDTHS }, this.mode, width);
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Partial<SavedLayout>;
      if (isMode(saved.mode)) this.desired = saved.mode;
      const widths = saved.widths;
      if (widths && typeof widths.sidebar === "number" && typeof widths.list === "number") {
        this.widths = clampWidths({ sidebar: widths.sidebar, list: widths.list }, this.mode, this.available);
      }
    } catch {
      // A corrupt setting is not worth a dialog: fall back to the defaults.
    }
  }

  setMode(mode: PaneMode): void {
    this.desired = mode;
    this.widths = clampWidths(this.widths, this.mode, this.available);
    this.save();
  }

  /** Called from a ResizeObserver on the pane container. */
  setAvailable(px: number): void {
    if (px === this.available || !Number.isFinite(px) || px <= 0) return;
    this.available = px;
    this.widths = clampWidths(this.widths, this.mode, px);
  }

  /** Absolute width during a drag: the gutter sends where the edge is, not a delta. */
  dragTo(which: "sidebar" | "list", width: number): void {
    this.widths = clampWidths({ ...this.widths, [which]: width }, this.mode, this.available);
  }

  reset(which: "sidebar" | "list"): void {
    this.widths = clampWidths({ ...this.widths, [which]: resetPane(which) }, this.mode, this.available);
    this.save();
  }

  nudge(which: "sidebar" | "list", direction: -1 | 1, big = false): void {
    this.widths = clampWidths(nudge(this.widths, which, direction, big), this.mode, this.available);
    this.save();
  }

  width(which: "sidebar" | "list"): number {
    return this.widths[which];
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: this.desired, widths: this.widths }));
    } catch {
      // Storage full or blocked: the layout still works for this session.
    }
  }
}

export const layout = new LayoutState();
