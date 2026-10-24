/**
 * Throwaway: exercises the real layout store, not a copy of its arithmetic.
 */
import { layout } from "./state/layout.svelte";

const out: Record<string, unknown> = {};

function snap(tag: string) {
  out[tag] = {
    mode: layout.mode,
    desired: layout.desired,
    available: layout.available,
    shown: { ...layout.shown },
    panes: { ...layout.panes },
    thresholds: { ...layout.thresholds },
    widthFor: { 1: layout.widthFor(1), 2: layout.widthFor(2), 3: layout.widthFor(3) },
  };
}

// Start wide, in three panes (the shipped desktop default).
layout.setAvailable(1440);
layout.setMode(3);
snap("start");

// Widen the sidebar by dragging its divider, then let go.
layout.dragTo("sidebar", 520);
layout.commit();
snap("sidebar-520");

// The complaint: press 1 (collapses to its own width), then 2. The sidebar the
// user just widened must come back, and the window must be asked for the sum.
layout.setAvailable(layout.widthFor(1));
snap("after-1");
layout.setMode(2);
const ask2 = layout.widthFor(2);
layout.setAvailable(ask2);
snap("after-2");

// Three panes keep their own posts width, so shaping one does not shape the other.
layout.setMode(3);
layout.setAvailable(layout.widthFor(3));
layout.dragTo("list", 300);
layout.commit();
snap("mode3-list-300");
layout.setMode(2);
layout.setAvailable(layout.widthFor(2));
snap("back-to-2");
layout.setMode(3);
layout.setAvailable(layout.widthFor(3));
snap("back-to-3");

// A slider writes the panes, then the number it reports is the sum of them.
layout.setThreshold("two", 1100);
snap("slider-two-1100");

// Storage round trip, and the upgrade path from the old two-number save.
out.stored = JSON.parse(localStorage.getItem("hardlyreader.layout.v1") ?? "null");
out.ask2 = ask2;

(window as unknown as { __paneModel: unknown }).__paneModel = out;
document.querySelector("#out")!.textContent = JSON.stringify(out, null, 1);
