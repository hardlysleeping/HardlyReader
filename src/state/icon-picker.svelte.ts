/**
 * "Give this category an icon", asked for from the category's own menu.
 *
 * One piece of transient UI state: which label is being chosen for, and where the
 * press was. It lives outside the menu because the menu closes the moment an item
 * is chosen — the chooser is what the item opens, not part of it — and outside
 * the icons store because a choice is durable and this is not.
 *
 * Anchored to a point rather than to an element: the row can be scrolled,
 * re-sorted or hidden while the chooser is up, and a chooser that followed the
 * row would be a chooser over a different category.
 */

import type { Point } from "../lib/contextmenu";

export class IconPickerState {
  /** The label being chosen for, or null when the chooser is closed. */
  target = $state<{ label: string } | null>(null);
  point = $state<Point>({ x: 0, y: 0 });

  open(label: string, point: Point): void {
    this.target = { label };
    // A chooser that opens off the bottom of the window has to be reachable:
    // clamp once here rather than in CSS, so the whole panel is on screen.
    const width = Math.min(288, globalThis.innerWidth - 16);
    const height = Math.min(460, globalThis.innerHeight * 0.7);
    this.point = {
      x: Math.max(8, Math.min(point.x, globalThis.innerWidth - width - 8)),
      y: Math.max(8, Math.min(point.y, globalThis.innerHeight - height - 8)),
    };
  }

  close(): void {
    this.target = null;
  }
}

export const iconPicker = new IconPickerState();
