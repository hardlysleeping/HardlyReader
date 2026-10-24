/**
 * The arithmetic behind a picture's size in the article pane.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/image-fit.mjs
 *
 * Three limits, and the tightest wins: the frame's width, the frame's height,
 * and — at 100% — the file's own width. The user's multiplier goes on top, which
 * is the only way a picture is ever allowed to be drawn larger than its file.
 */

import { fittedWidth } from "../../src/lib/image-fit.ts";

let checks = 0;
let failures = 0;

function check(name, ok) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${name}`);
  }
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 1;

// A tall comic strip in a desktop article frame: the height is the limit.
check("a 1:3 strip fits the frame's height", near(fittedWidth({ width: 800, height: 2400 }, { width: 900, height: 700 }), 233));

// The same strip on a phone-shaped frame: still the height, but far less of it.
check("the same strip on a portrait frame", near(fittedWidth({ width: 800, height: 2400 }, { width: 390, height: 700 }), 233));

// A picture narrower than the frame keeps its own size at 100%.
check("a small picture is not stretched to the frame", fittedWidth({ width: 300, height: 200 }, { width: 900, height: 700 }) === 300);

// Wider than the frame: the width is the limit.
check("a wide picture is capped by the frame's width", fittedWidth({ width: 1200, height: 800 }, { width: 900, height: 700 }) === 900);

// Exactly the frame.
check("a picture the size of the frame is untouched", fittedWidth({ width: 900, height: 700 }, { width: 900, height: 700 }) === 900);

// The reader's multiplier, both ways, measured against the automatic fit.
check("asking for 200% doubles the fit", fittedWidth({ width: 800, height: 2400 }, { width: 900, height: 700 }, 2) === 467);
check("asking for 150% on a small picture does upscale it", fittedWidth({ width: 300, height: 200 }, { width: 900, height: 700 }, 1.5) === 450);
check("asking for 50% halves it, so the words get the room", fittedWidth({ width: 300, height: 200 }, { width: 900, height: 700 }, 0.5) === 150);

// Past the fit the picture can be taller than the frame, and that is the point:
// the reader asked for the blur, and the scroll that comes with it is theirs.
check(
  "past the fit the picture may be taller than the frame",
  fittedWidth({ width: 800, height: 2400 }, { width: 900, height: 700 }, 2) * (2400 / 800) > 700,
);

// Nothing to decide yet.
check("an image that has not loaded has no width", fittedWidth({ width: 0, height: 0 }, { width: 900, height: 700 }) === null);
check("a frame that has not been measured does not limit the picture", fittedWidth({ width: 300, height: 200 }, { width: 0, height: 0 }) === 300);
check("an unmeasured frame still respects the file", fittedWidth({ width: 1200, height: 800 }, { width: 0, height: 0 }) === 1200);

// A nonsense multiplier must not erase the picture.
check("a broken multiplier falls back to the fit", fittedWidth({ width: 800, height: 2400 }, { width: 900, height: 700 }, Number.NaN) === 233);
check("a zero multiplier falls back to the fit", fittedWidth({ width: 800, height: 2400 }, { width: 900, height: 700 }, 0) === 233);
check("a picture never rounds away to nothing", fittedWidth({ width: 1, height: 1000 }, { width: 900, height: 700 }) >= 1);

if (failures === 0) {
  console.log(`ok ${checks} checks — article pictures: fit the frame, never the file`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
