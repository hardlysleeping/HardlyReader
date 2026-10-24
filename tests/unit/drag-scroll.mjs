/**
 * Checks for mouse drag-to-scroll.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/drag-scroll.mjs
 *
 * The module is a listener installer, so its behaviour was measured in a real
 * browser with real mouse events (drag 90px → scrollTop 90, no click; plain
 * click → 1 click; drag from a range input, from the gutter and with Shift →
 * no scroll; touch → native scroll, no class). What is checked here is the set
 * of rules that produced those numbers, read back from the source, so a later
 * edit cannot quietly drop one of them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (path) => readFileSync(`${here}${path}`, "utf8");

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${detail})`}`);
  }
}

const source = read("../../src/lib/drag-scroll.ts");
const app = read("../../src/main.ts");
const css = read("../../src/app.css");

check("the app installs it at startup", /import \{ installDragScroll \} from "\.\/lib\/drag-scroll"/.test(app) && /installDragScroll\(\);/.test(app));
check("it listens once, on the window", (source.match(/window\.addEventListener\("pointerdown"/g) ?? []).length === 1);
check("and removes what it added", /removeEventListener\("pointerdown"/.test(source) && /removeEventListener\("pointermove"/.test(source));

// Mouse only: touch and pen already pan natively, with inertia and chaining we
// would only ruin.
check("only the mouse pans", /event\.pointerType !== "mouse"/.test(source));
check("only the primary button pans", /event\.button !== 0/.test(source));

// Modifiers keep the native gestures: shift-drag selects text.
check(
  "holding a modifier leaves the gesture to the browser",
  /event\.shiftKey \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey/.test(source),
);

// A click must stay a click.
const threshold = Number(/const THRESHOLD = (\d+)/.exec(source)?.[1] ?? "0");
check("a press is not a pan until it travels", threshold >= 4 && threshold <= 10, String(threshold));
check("the click after a pan is swallowed", /performance\.now\(\) - endedAt > CLICK_GRACE/.test(source));
check("and the swallow expires", /const CLICK_GRACE = \d+/.test(source));

// Controls that own the pointer keep it.
check(
  "inputs, the gutter and opt-outs are left alone",
  /input, textarea, select, option, \[contenteditable='true'\], \[data-no-drag-scroll\], \.gutter/.test(source),
);
check("the opt-out is honoured", /origin\.closest\(OWNS_POINTER\)/.test(source));

// Content follows the pointer, both axes.
check("the scroll is taken from the pointer's travel", /scrollTop -= event\.clientY - lastY/.test(source) && /scrollLeft -= event\.clientX - lastX/.test(source));

// No fling: a mouse stops where the hand stops.
check("there is no momentum loop", !/requestAnimationFrame|setInterval/.test(source));

check("the grabbing cursor is defined once", /html\.drag-panning/.test(css));
check("the panning class is added and removed", new RegExp(`classList\\.add\\(PANNING_CLASS\\)`).test(source) && /classList\.remove\(PANNING_CLASS\)/.test(source));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
