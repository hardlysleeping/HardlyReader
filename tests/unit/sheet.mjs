// The sheet's arithmetic, and the two things a phone must keep: the rows come up
// from the bottom, and the window keeps the popover it already had.
//
// No DOM: `sheet.ts` is pure, and the component's own behaviour is asserted from
// its source the way `phone-header.mjs` does it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISMISS_FLICK,
  DISMISS_FRACTION,
  MAX_LIFT,
  scrimOpacity,
  sheetOffset,
  sheetSettles,
} from "../../src/lib/sheet.ts";
import { MAX_PULL, resist } from "../../src/lib/pull.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../src", p), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("sheet");

// ---- where the sheet sits while the finger is down -------------------------

check("at rest, nothing has moved", sheetOffset(0, 400) === 0);
check("downward follows the finger 1:1", sheetOffset(120, 400) === 120);
check("it never drags past its own height", sheetOffset(900, 400) === 400);
check("a sheet of unknown height still follows", sheetOffset(60, 0) === 0);
check("upward is resisted, not free", sheetOffset(-40, 400) > -40);
check("upward stops at the lift", sheetOffset(-5000, 400) === -MAX_LIFT);
check("the lift is small: it says 'already open', not 'there is more'", MAX_LIFT <= 40);
check(
  "the upward give is the app's own pull curve",
  sheetOffset(-30, 400) === -Math.min(MAX_LIFT, resist(30)),
  `${sheetOffset(-30, 400)} vs ${-Math.min(MAX_LIFT, resist(30))}`,
);
check("the pull's own cap is untouched", resist(10000) === MAX_PULL);
check("NaN is no drag at all", sheetOffset(Number.NaN, 400) === 0);

// ---- what letting go does --------------------------------------------------

const height = 400;
const past = height * DISMISS_FRACTION;

check("a slow drag past the fraction closes", sheetSettles(past + 10, height, 0) === "dismiss");
check("a slow drag short of it springs back", sheetSettles(past - 10, height, 0) === "open");
check("exactly at the fraction stays open", sheetSettles(past, height, 0) === "open");
check(
  "a short fast flick closes even though it barely moved",
  sheetSettles(40, height, DISMISS_FLICK + 0.2) === "dismiss",
);
check("a fast upward flick keeps it open", sheetSettles(past + 60, height, -1.2) === "open");
check("a flick with no height measured still closes", sheetSettles(0, 0, 2) === "dismiss");
check("no height and no flick keeps it open", sheetSettles(0, 0, 0) === "open");
check("NaN velocity falls back to the distance", sheetSettles(past + 10, height, Number.NaN) === "dismiss");

// ---- the scrim -------------------------------------------------------------

check("the scrim is at its peak while the sheet is home", Math.abs(scrimOpacity(0, height) - 0.42) < 1e-9);
check("it is gone once the sheet is out of the way", scrimOpacity(height, height) === 0);
check("halfway out, half as dark", Math.abs(scrimOpacity(height / 2, height) - 0.21) < 1e-9);
check("it never goes past its peak", scrimOpacity(-20, height) <= 0.42 + 1e-9);
check("an unmeasured sheet is not a transparent one", scrimOpacity(0, 0) === 0.42);

// ---- the component ---------------------------------------------------------

const sheet = read("components/Sheet.svelte");
check("the sheet is a dialog and says so", /role="dialog"/.test(sheet) && /aria-modal="true"/.test(sheet));
check("it has a handle that owns the gesture", /class="grab"/.test(sheet) && /onpointerdown=\{grab\}/.test(sheet));
check("the handle does not steal the body's scrolling", /touch-action: none/.test(sheet));
check("the finger's position beats the spring", /\.sheet\.dragging\s*\{[^}]*transition: none/.test(sheet));
check("it portals out of the bar that opens it", /document\.body\.appendChild/.test(sheet));
check("Escape closes it", /event\.key !== "Escape"/.test(sheet));
check("the scrim is a real button, not a clickable div", /class="scrim"/.test(sheet) && /<button/.test(sheet));
check("reduced motion is respected", /prefers-reduced-motion: reduce/.test(sheet));
check("it rides inside the safe area", /env\(safe-area-inset-bottom\)/.test(sheet));

const controls = read("components/ReadingControls.svelte");
check("the phone branch exists", /onPhone\s*\?\s*|onPhone\)/.test(controls) || /const onPhone/.test(controls));
check("a phone gets the sheet", /<Sheet label="Reading options"/.test(controls));
check("a window keeps the popover", /class="panel" role="dialog"/.test(controls));
check("the two are alternatives, not both", /\{#if onPhone\}[\s\S]*\{:else\}[\s\S]*class="panel"/.test(controls));
check(
  "the old click-outside no longer fires inside the sheet",
  /if \(!open \|\| onPhone\) return;/.test(controls),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
