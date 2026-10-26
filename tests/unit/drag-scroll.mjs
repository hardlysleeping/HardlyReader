/**
 * Checks for mouse drag-to-scroll.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/drag-scroll.mjs
 *
 * The module is a listener installer, so its behaviour was measured in a real
 * browser with real pointer events (drag 90px → scrollTop 90, no click; plain
 * click → 1 click; drag from a range input, from the gutter and with Shift → no
 * scroll; a fast release → the content keeps moving and slows; a press during
 * that → it stops where it is). What is checked here is the set of rules that
 * produced those numbers, read back from the source, so a later edit cannot
 * quietly drop one of them. The throw's own numbers are measured in `fling.mjs`.
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
const flingSource = read("../../src/lib/fling.ts");

check("the app installs it at startup", /import \{ installDragScroll \} from "\.\/lib\/drag-scroll"/.test(app) && /installDragScroll\(\);/.test(app));
check("it listens once, on the window", (source.match(/window\.addEventListener\("pointerdown"/g) ?? []).length === 1);
check("and removes what it added", /removeEventListener\("pointerdown"/.test(source) && /removeEventListener\("pointermove"/.test(source));

// Mouse and finger both pan here: the point of the module is that a flick and a
// drag feel the same, and the browser's own touch panning has no throw to offer.
check(
  "the mouse and the finger both pan",
  /event\.pointerType !== "mouse" && event\.pointerType !== "touch"/.test(source),
);
check("a pen is left to the browser", !/"pen"/.test(source));
check("only the primary button pans", /event\.button !== 0/.test(source));

// Modifiers keep the native gestures: shift-drag selects text. A finger has no
// modifiers, so this can only ever apply to the mouse.
check(
  "holding a modifier leaves the mouse gesture to the browser",
  /event\.pointerType === "mouse" && \(event\.shiftKey \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey\)/.test(
    source,
  ),
);

// A click must stay a click.
const threshold = Number(/const THRESHOLD = (\d+)/.exec(source)?.[1] ?? "0");
check("a press is not a pan until it travels", threshold >= 4 && threshold <= 10, String(threshold));
check("the click after a pan is swallowed", /performance\.now\(\) - endedAt > CLICK_GRACE/.test(source));
check("and the swallow expires", /const CLICK_GRACE = \d+/.test(source));

// Controls that own the pointer keep it — and which controls those are depends
// on the pointer. Typing, a slider and the pane edge hold the gesture against
// either hand. `data-no-drag-scroll` is a mouse opt-out only: it was added
// because a mouse press that slid a few pixels became a pan and swallowed the
// click, and a mouse has a wheel to scroll with instead. A finger has no wheel,
// so the pan is the only scroll there is and a finger is never refused there.
check(
  "typing, a slider and the pane edge are left alone whatever the pointer is",
  /const OWNS_POINTER = "input, textarea, select, option, \[contenteditable='true'\], \.gutter"/.test(source),
);
check(
  "the mouse's own list is the general one plus the opt-out",
  /`\$\{OWNS_POINTER\}, \[data-no-drag-scroll\]`/.test(source),
);
check(
  "and the press reads one list or the other by pointer type",
  /const finger = event\.pointerType === "touch";\s*\n\s*if \(origin\.closest\(finger \? OWNS_POINTER : MOUSE_OWNS_POINTER\)\) return;/.test(
    source,
  ),
);

// The threshold is per press, not raised for everyone: a finger that landed on
// a control has to travel further before the pan takes the tap away from it,
// and a finger that landed on the row's body still pans at `THRESHOLD`.
const controlThreshold = Number(/const CONTROL_THRESHOLD = (\d+)/.exec(source)?.[1] ?? "0");
check("a control is travelled past further than a plain surface", controlThreshold > threshold && controlThreshold <= 12, String(controlThreshold));
check(
  "only a finger's press on something tappable gets it",
  /threshold = finger && origin\.closest\(TAPPABLE\) \? CONTROL_THRESHOLD : THRESHOLD;/.test(source),
);
check(
  "what a finger can tap is a button, a link, a role button or an opt-out strip",
  /const TAPPABLE = "button, a\[href\], \[role='button'\], \[data-no-drag-scroll\]"/.test(source),
);
check(
  "and the pan measures against that press's threshold",
  /Math\.hypot\(event\.clientX - startX, event\.clientY - startY\) < threshold\) return;/.test(source),
);

// The press that became a pan is not a press on the control it started on: the
// pressed look has to go with the gesture, or the star stays lit for the whole
// scroll.
check(
  "a pan drops the pressed look it started on",
  /html\.drag-panning :is\(button, a, \[role="button"\]\):active:not\(\.on\):not\(\[aria-pressed="true"\]\) \{/.test(css) &&
    /transform: none !important;\s*\n\s*background-color: transparent !important;/.test(css),
);
check(
  "and a control that is switched on keeps its colour",
  /:active:not\(\.on\):not\(\[aria-pressed="true"\]\)/.test(css),
);

// Content follows the pointer, both axes.
check("the scroll is taken from the pointer's travel", /scrollTop -= event\.clientY - lastY/.test(source) && /scrollLeft -= event\.clientX - lastX/.test(source));

// The release throws the speed the hand still had, and the throw is the shared
// model rather than a second set of numbers grown here.
check(
  "a release reads the speed it was travelling at",
  /releaseVelocity\(samples, when\(event\)\)/.test(source) && /startFling\(el, vx, vy\)/.test(source),
);
// `timeStamp` is the pointer's own clock and survives coalescing; it is also 0 on
// some synthetic dispatch paths, so receipt time is the fallback rather than the
// rule — with `timeStamp` alone, a burst of moves reads as zero speed.
check(
  "the sample clock is the event's, with the clock at receipt behind it",
  /const stamp = event\.timeStamp;\s*return Number\.isFinite\(stamp\) && stamp > 0 \? stamp : performance\.now\(\);/.test(
    source,
  ),
);
check(
  "and the throw is the shared model",
  /import \{ decayVelocity, isFlung, isSpent, releaseVelocity, FLING, type FlingSample \} from "\.\/fling"/.test(
    source,
  ),
);
check("the throw decays per frame", /decayVelocity\(vx, vy, dt\)/.test(source));
check("and stops when it is spent", /isSpent\(vx, vy\)/.test(source));
check("a slow release does not throw", /if \(!isFlung\(vx, vy\)\) return;/.test(source));
check("the content moves opposite the hand", /let vx = -vxPointer;/.test(source) && /let vy = -vyPointer;/.test(source));
// An axis that has reached the end of the scroller stops on its own, so a
// diagonal throw along the top of a list keeps sliding sideways.
check(
  "each axis stops at the end of the scroller",
  /if \(el\.scrollTop === before\) vy = 0;/.test(source) && /if \(el\.scrollLeft === before\) vx = 0;/.test(source),
);
// A dropped frame must not skip content: the integration is clamped.
check("a stalled frame cannot skip the throw", /const dt = Math\.min\(now - last, MAX_FRAME\)/.test(source));

// Catching it: the next press stops the content where it is, and that press is
// not also a click on whatever it landed on.
const down = source.slice(source.indexOf("function onPointerDown"), source.indexOf("function onPointerMove"));
check(
  "a press catches the throw before anything else",
  /const flingCaught = fling !== null;\s*if \(flingCaught\) \{\s*stopFling\(\);\s*endedAt = performance\.now\(\);\s*\}/.test(
    down,
  ) && down.indexOf("flingCaught") < down.indexOf('event.pointerType !== "mouse"'),
);
// Resting a finger on the caught content then letting go must not also press the
// row it is resting on: the press that caught the throw swallows its own click.
check(
  "and the press that caught it swallows its click, however long it rests",
  /caughtPress = flingCaught;/.test(down) && /if \(panning \|\| caughtPress\) endedAt = performance\.now\(\);/.test(source),
);
check(
  "and a hand that overtakes the throw does not inherit its speed",
  /if \(!panning\) \{[\s\S]{0,300}stopFling\(\)/.test(source),
);
check("the wheel catches it too", /function onWheel\(\): void \{\s*stopFling\(\)/.test(source));
check("the throw is cancelled when the module is removed", /return \(\) => \{\s*stopFling\(\);/.test(source));

// Snapping is what makes a drag feel like it did nothing: re-armed on release,
// the snap engine pulls the column back to the card it started from before
// anything that cares about where the drag ended has read the position.
check("the panning class outlives the release by a frame", /const seq = panSeq;\s*\n\s*requestAnimationFrame\(\s*\(\) => \{[\s\S]{0,120}classList\.remove\(PANNING_CLASS\)/.test(source));
check("a deferred removal cannot land in the next pan", /if \(seq === panSeq\)/.test(source));
check("the release arms nothing else", /panning = false;\s*\n\s*pointer = null;\s*\n\s*container = null;/.test(source));

check("the grabbing cursor is defined once", /html\.drag-panning/.test(css));
check("the panning class is added and removed", new RegExp(`classList\\.add\\(PANNING_CLASS\\)`).test(source) && /classList\.remove\(PANNING_CLASS\)/.test(source));

// A press on a 24px toggle is smaller than a mouse is steady: if it slides past
// the threshold it becomes a pan, and the pan swallows the click — the button
// reads as dead. The toggles therefore own the pointer for the mouse. A finger
// pans from them instead, at `CONTROL_THRESHOLD`.
const list = read("../../src/components/ArticleList.svelte");
check("the star, read and source toggles own the pointer for the mouse", /class="acts" data-no-drag-scroll/.test(list));
check("and the rule that gives it to them is the one the module reads", /\[data-no-drag-scroll\]/.test(source));

// Taking the pan from the browser is a per-surface decision: the three readers
// hand it over so a flick throws, and everything else (menus, panels, dialogs)
// keeps the browser's own panning.
const sidebar = read("../../src/components/Sidebar.svelte");
const reader = read("../../src/components/ReaderPane.svelte");
check("the post list hands the pointer over", /\.items \{[^}]*touch-action: none;/.test(list));
check("so does the feed tree", /\.scroll \{[^}]*touch-action: none;/.test(sidebar));
check("and the article", /article \{[^}]*touch-action: none;/.test(reader));
check("the app's page-level panning is untouched", /touch-action: pan-x pan-y;/.test(css));

// The throw's numbers, so the feel cannot drift away from what was measured.
check("the throw's constants live in the model", /export const FLING = \{/.test(flingSource));
check("a throw is capped", /max: 5,/.test(flingSource));
check("a slow release keeps nothing", /min: 0\.12,/.test(flingSource));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
