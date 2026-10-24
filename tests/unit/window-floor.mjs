/**
 * Checks that the window can actually be the size a mode press asks for.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/window-floor.mjs
 *
 * The reported bug was one pane growing: pressing "1" asked for the sidebar's
 * own width, the window manager refused anything under its own floor, and the
 * single pane drew at the floor instead — so the pane was ~80px wider than the
 * column the user had shaped and every row inside it re-flowed. Only mode 1 was
 * affected because only mode 1 asks for a width below that floor.
 *
 * These checks tie the three numbers together so the mismatch cannot come back
 * quietly: the window's floor, the narrowest a sidebar may be dragged, and the
 * width the "1" button asks for.
 *
 * The second half is the other setting, "Keep window". Two rules, and they are
 * not the same rule:
 *
 *   - keeping widths, a press fits the window to that mode's own panes;
 *   - sharing the room, a press never resizes the window at all, except to grow
 *     a window too small for two or three honest columns — and then it grows to
 *     that mode's *floor*, never to the user's own widths, which are a
 *     preference the window may override.
 *
 * That last distinction was a bug in the field: with three columns shaped to
 * 1212 sitting in a 1100px window, pressing 3 grew the window to 1212 and the
 * shared-room answer then demoted the third pane — it "popped out" instead of
 * using the room that was already there.
 */
import { readFileSync } from "node:fs";

import {
  MIN,
  THRESHOLD_LIMITS,
  effectiveMode,
  fitTarget,
  floorThresholds,
  thresholdsFor,
  widthFor,
} from "../../src/lib/panes.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${JSON.stringify(detail)})`}`);
  }
}

const conf = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const floor = conf.app.windows[0].minWidth;

check("the window's floor is known", typeof floor === "number" && floor > 0, floor);
check(
  "and it never stops the one-pane width being reached",
  floor <= THRESHOLD_LIMITS.one.min,
  { floor, oneMin: THRESHOLD_LIMITS.one.min },
);
check("the one-pane floor is where a sidebar may be dragged to", THRESHOLD_LIMITS.one.min === MIN.sidebar);

const shaped = thresholdsFor({ sidebar: 280, list: 380 }, "desktop", 280);
check("a 280 sidebar is what pressing 1 asks for", widthFor(1, "desktop", shaped) === 280);
check(
  "a window wider than that is narrowed to it, not grown to the floor",
  fitTarget(1, 1000, "desktop", shaped, null, true) === 280,
);

for (const sidebar of [MIN.sidebar, 280, 320, 400]) {
  const t = thresholdsFor({ sidebar, list: 380 }, "desktop", sidebar);
  check(
    `a ${sidebar}px sidebar is asked for exactly (no growth on the way to one pane)`,
    fitTarget(1, 1000, "desktop", t, null, true) === sidebar,
    { asked: fitTarget(1, 1000, "desktop", t, null, true), sidebar },
  );
  check(`and ${sidebar}px is reachable in the window`, sidebar >= floor, { sidebar, floor });
}

check(
  "the request is never below the window's floor either",
  MIN.sidebar >= floor ? true : false,
  { minSidebar: MIN.sidebar, floor },
);

// The other modes were never affected, because their widths sit above the floor;
// this pins that they still ask for their own sums.
const wide = thresholdsFor({ sidebar: 280, list: 380 }, "desktop", 280);
check("two panes still asks for the pair's width", fitTarget(2, 1600, "desktop", wide, null, true) === wide.two);
check("three still asks for the trio's width", fitTarget(3, 1600, "desktop", wide, null, true) === wide.three);
check("and both are above the floor", wide.two > floor && wide.three > floor);

// ---------------------------------------------------------------------------
// Keep window: no press resizes the window
// ---------------------------------------------------------------------------

// This used to expect 280 for pane one — that was the bug, not the rule:
// "Keep window" shrank the window on the one press it was asked not to.
for (const mode of [1, 2, 3]) {
  check(
    `sharing the room, pressing ${mode} leaves a wide enough window alone`,
    fitTarget(mode, 1400, "desktop", wide, null, false) === null,
    { mode, target: fitTarget(mode, 1400, "desktop", wide, null, false) },
  );
}
check(
  "one column never grows the window, however narrow it is",
  fitTarget(1, 200, "desktop", wide, null, false) === null,
  { target: fitTarget(1, 200, "desktop", wide, null, false) },
);
check(
  "two panes in a window below the pair's floor grow to that floor",
  fitTarget(2, 600, "desktop", wide, null, false) === 700,
  { target: fitTarget(2, 600, "desktop", wide, null, false) },
);
check(
  "three panes below the trio's floor grow to that floor",
  fitTarget(3, 900, "desktop", wide, null, false) === 1000,
  { target: fitTarget(3, 900, "desktop", wide, null, false) },
);

// The other half of the rule is untouched: "Keep widths" still fits the window
// to each mode's own panes, one pane included.
for (const [mode, expected] of [[1, 280], [2, wide.two], [3, wide.three]]) {
  check(
    `keeping widths, pressing ${mode} still asks for its own panes`,
    fitTarget(mode, 1400, "desktop", wide, null, true) === expected,
    { mode, target: fitTarget(mode, 1400, "desktop", wide, null, true), expected },
  );
}

// ---------------------------------------------------------------------------
// Sharing: the user's own widths are a preference, not a demand
// ---------------------------------------------------------------------------

// Three columns shaped to 1212, sitting in a 1100px window: the case that grew
// the window and then dropped the third pane.
const tuned = { one: 300, two: 900, three: 1212 };

check(
  "three panes in a window narrower than the user's own three do not grow it",
  fitTarget(3, 1100, "desktop", tuned, null, false) === null,
  { target: fitTarget(3, 1100, "desktop", tuned, null, false) },
);
check(
  "two panes likewise",
  fitTarget(2, 800, "desktop", tuned, null, false) === null,
  { target: fitTarget(2, 800, "desktop", tuned, null, false) },
);
check(
  "and when the window really cannot hold three, it grows to the floor, not to 1212",
  fitTarget(3, 900, "desktop", tuned, null, false) === 1000,
  { target: fitTarget(3, 900, "desktop", tuned, null, false) },
);
check(
  "keeping widths, the same press still asks for the user's own 1212",
  fitTarget(3, 1100, "desktop", tuned, null, true) === 1212,
);
check(
  "sharing also means a 1100px window is judged wide enough for three",
  effectiveMode(3, 1100, "desktop", floorThresholds("desktop")) === 3,
);
check(
  "whereas the tuned sums would drop the third pane, which was the bug",
  effectiveMode(3, 1100, "desktop", tuned) === 2,
  { mode: effectiveMode(3, 1100, "desktop", tuned) },
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
