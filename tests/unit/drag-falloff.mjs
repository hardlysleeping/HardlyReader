// `src/lib/drag-falloff.ts` was built to damp a mouse drag on the layout
// sliders: the further the pointer runs ahead of the handle, the less of each
// further pixel reaches the value.
//
// It is no longer wired to anything. It was the wrong fix for "the slider is
// twitchy": the range is 1640px of window shown in a 96px track, and the drag
// was relative, so the handle started 1:1 and then fell away to 6% — too
// strong, then too slow. BACKLOG #123 removed the damping and fixed the cause
// instead (the slider now spans the whole panel, ~242px, and is a native range
// input again). The module and this suite were left in the tree, so these
// checks pin the curve that still exists plus the wiring the app actually has:
// native sliders that write the layout on input and commit on change, and a
// pane seam that moves 1:1 with the pointer.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FALLOFF, FLOOR, gain, snap, clampTo } from "../../src/lib/drag-falloff.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every source file under src, for the "attached to nothing" check. */
function sources(dir = join(root, "src"), out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".svelte") || name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// --- the curve
check("at the handle the pull is direct", gain(0) === 1);
check("a pointer that has not run away is not slowed", gain(-40) === 1, String(gain(-40)));
check("one falloff distance halves it", Math.abs(gain(FALLOFF) - 0.5) < 0.001, String(gain(FALLOFF)));
check("further is slower, and always slower than nearer",
  gain(FALLOFF * 2) < gain(FALLOFF) && gain(FALLOFF * 6) < gain(FALLOFF * 2));
check("it keeps creeping rather than stopping", gain(100000) > 0);
check("the floor holds", gain(100000) >= FLOOR && gain(FALLOFF * 1000) >= FLOOR);
check("it never exceeds 1:1", gain(1) <= 1 && gain(FALLOFF * 0.1) <= 1);
check("a nonsense distance is not a slowdown", gain(NaN) === 1 && gain(Infinity) >= FLOOR);

// --- the grid it lands on
check("values snap to the step", snap(1041, 10) === 1040 && snap(1046, 10) === 1050);
check("a zero step leaves the position alone", snap(1041.5, 0) === 1041.5);
check("clamping keeps the ends", clampTo(5000, 360, 2000) === 2000 && clampTo(1, 360, 2000) === 360);
check("clamping inside is identity", clampTo(900, 360, 2000) === 900);

// --- the arithmetic of a real drag, in the units the action uses
// The action measures lag in *track pixels*: it maps the value back onto the
// track and compares that with the pointer. This sim models that — a 360–2000
// range spread over the 242px the layout panel gives the slider — which is the
// case where the handle can actually fall behind. The earlier version compared
// the pointer against the raw value (a 1:1 track), where lag starts and stays
// at 0, so 400px of pointer could only ever be 400 of value: the "400 vs 400"
// it used to print was the sim contradicting its own premise, not the code.
const TRACK_PX = 242;
const SPAN = 2000 - 360;
function drag(pixels, trackPx = TRACK_PX, stepPx = 10) {
  const handleX = (value) => ((value - 360) / SPAN) * trackPx;
  let position = 1000;
  let value = snap(position, 10);
  const startX = handleX(value);
  for (let i = 0; i < pixels; i += stepPx) {
    const lag = Math.abs(startX + i - handleX(value));
    position = clampTo(position + stepPx * gain(lag), 360, 2000);
    value = clampTo(snap(position, 10), 360, 2000);
  }
  return { value, travelled: pixels };
}
const near = drag(400);
check("a normal drag still moves", near.value > 1000, String(near.value));
check("the value trails the pointer", near.value - 1000 < near.travelled, `${near.value - 1000} vs 400`);
check("but it is not stuck", near.value - 1000 > 60, String(near.value - 1000));
// And the other half of the same arithmetic: on a track the value maps 1:1 to,
// the lag never opens, so nothing is slowed — which is exactly why this was the
// wrong tool for a slider and why the wiring below is gone.
check("a 1:1 track is not damped at all", drag(400, SPAN).value - 1000 === 400);

// --- wiring: what the layout panel actually does
const panel = read("src/components/ThemePanel.svelte");
check("the two-pane slider writes the layout directly",
  /value=\{layout\.thresholds\.two\}[\s\S]{0,400}oninput=\{\(event\) => layout\.setThreshold\("two"/.test(panel));
check("the three-pane slider writes the layout directly",
  /value=\{layout\.thresholds\.three\}[\s\S]{0,400}oninput=\{\(event\) => layout\.setThreshold\("three"/.test(panel));
check("a finished slider drag is committed",
  (panel.match(/onchange=\{\(\) => layout\.commitThreshold\(\)\}/g) ?? []).length === 3,
  String((panel.match(/onchange=\{\(\) => layout\.commitThreshold\(\)\}/g) ?? []).length));
// The removed contract: the damped action is not attached to any control, in
// the panel or anywhere else in the app.
check("no slider is damped any more", !/\buse:/.test(panel) && sources().every((file) => !readFileSync(file, "utf8").includes("use:falloffDrag")));
// The seam between panes is the other drag in the layout, and it is a straight
// 1:1: a moved pixel is a moved pixel, with no damping on either axis.
check("the pane seam still moves 1:1 with the pointer",
  /layout\.dragTo\(which, startWidth \+ \(x - startPos\)\)/.test(read("src/components/PaneGutter.svelte")));

// --- the action behaves itself (kept: the module is still in the tree)
const lib = read("src/lib/drag-falloff.ts");
check("touch keeps its native drag", /pointerType !== "mouse"/.test(lib));
check("the native thumb drag is stopped", /event\.preventDefault\(\)/.test(lib));
check("a click still jumps to where it landed", /travelled < 3/.test(lib));
check("it lets go of the pointer", /releasePointerCapture/.test(lib));
check("it takes its listeners away", /removeEventListener\("pointermove", onMove\)/.test(lib));
check("the value is reported as a real input event", /new Event\("input", \{ bubbles: true \}\)/.test(lib));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
