/**
 * Scratch probe: what would a stacked, Keep-window layout draw at various widths?
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/probe-stacked.mjs
 */
import {
  effectiveMode,
  floorThresholds,
  gridTemplate,
  paneSlots,
  thresholdsFor,
} from "../src/lib/panes.ts";

const widths = { sidebar: 280, list: 380 };
const tuned = thresholdsFor(widths, "desktop", 280);

function show(label, available, keepWidths, collapsed = false) {
  const limits = keepWidths ? tuned : floorThresholds("desktop");
  const mode = effectiveMode(3, available, "desktop", limits);
  const stacked = mode === 3;
  const slots = paneSlots({ mode, level: "feeds", stacked, collapsed });
  console.log(
    label.padEnd(30),
    `avail ${String(available).padStart(4)}`,
    `mode ${mode}`,
    `stacked ${stacked}`,
    `\n  limits two=${limits.two} three=${limits.three}  tuned two=${tuned.two} three=${tuned.three}`,
    `\n  slots ${JSON.stringify(slots)}`,
    `\n  cols  ${gridTemplate(mode, widths, { available, stacked, keepWidths, collapsed })}`,
    `\n  rows  ${stacked ? "stacked pair" : "flat"}`,
  );
}

for (const width of [700, 780, 900, 1000, 1100, 1400]) show("keep window", width, false);
console.log("");
for (const width of [780, 900, 1200]) show("keep widths", width, true);
console.log("");
show("keep window, collapsed", 1100, false, true);
show("keep widths, collapsed", 1200, true, true);
