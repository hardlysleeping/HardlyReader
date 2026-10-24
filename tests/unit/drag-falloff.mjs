// The layout sliders damp a mouse drag: the further the pointer runs ahead of
// the handle, the less of each further pixel reaches the value.
import { readFileSync } from "node:fs";
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

// --- the arithmetic of a real drag: 400px of pointer, near then far
function drag(pixels, start, stepPx = 10) {
  let value = 1000;
  let pos = value;
  for (let i = 0; i < pixels; i += stepPx) {
    // lag = how far the pointer has run ahead of the handle
    const lag = Math.abs(start + i - start - (pos - 1000));
    pos = clampTo(pos + stepPx * gain(lag), 360, 2000);
    value = snap(pos, 10);
  }
  return { value, travelled: pixels };
}
const near = drag(400, 0);
check("a normal drag still moves", near.value > 1000, String(near.value));
// Damping means the value trails the pointer, so 400px of drag cannot be 400px
// of value once the handle falls behind.
check("the value trails the pointer", near.value - 1000 < near.travelled, `${near.value - 1000} vs 400`);
check("but it is not stuck", near.value - 1000 > 60, String(near.value - 1000));

// --- wiring: the two layout sliders, and only them
const panel = read("src/components/ThemePanel.svelte");
check("the two-pane slider is damped",
  /value=\{layout\.thresholds\.two\}[\s\S]{0,200}use:falloffDrag/.test(panel));
check("the three-pane slider is damped",
  /value=\{layout\.thresholds\.three\}[\s\S]{0,200}use:falloffDrag/.test(panel));
check("exactly two sliders are damped", (panel.match(/use:falloffDrag/g) ?? []).length === 2);
check("the reading sliders are left native", !/effort[\s\S]{0,300}use:falloffDrag/.test(panel));

// --- the action behaves itself
const lib = read("src/lib/drag-falloff.ts");
check("touch keeps its native drag", /pointerType !== "mouse"/.test(lib));
check("the native thumb drag is stopped", /event\.preventDefault\(\)/.test(lib));
check("a click still jumps to where it landed", /travelled < 3/.test(lib));
check("it lets go of the pointer", /releasePointerCapture/.test(lib));
check("it takes its listeners away", /removeEventListener\("pointermove", onMove\)/.test(lib));
check("the value is reported as a real input event", /new Event\("input", \{ bubbles: true \}\)/.test(lib));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
