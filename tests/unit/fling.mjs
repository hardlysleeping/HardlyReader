/**
 * The throw a released pan becomes: how fast, how long, and how it ends.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/fling.mjs
 *
 * These are the numbers behind "a flick keeps going and a press catches it", so
 * they are measured rather than described: the release velocity is read from the
 * tail of the gesture only, the decay is per frame, and the two thresholds decide
 * whether a release throws at all.
 */
import {
  FLING,
  decayVelocity,
  flingDistance,
  isFlung,
  isSpent,
  releaseVelocity,
} from "../../src/lib/fling.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === "" ? "" : `  (${detail})`}`);
  }
}

const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

// --- the release speed ------------------------------------------------------

// 1px per ms to the right, sampled every 16ms: the throw is that speed.
const steady = [0, 16, 32, 48, 64].map((t, i) => ({ t: 1000 + t, x: 100 + i * 16, y: 0 }));
check("a steady drag releases at its speed", near(releaseVelocity(steady, 1064).vx, 1), String(releaseVelocity(steady, 1064).vx));

// A long slow drag that flicks at the end throws at the flick's speed, not the
// drag's average — the tail is what the hand was doing last.
const lateFlick = [
  { t: 0, x: 0, y: 0 },
  { t: 500, x: 10, y: 0 },
  { t: 1000, x: 20, y: 0 },
  { t: 1050, x: 80, y: 0 },
  { t: 1060, x: 110, y: 0 },
];
const flick = releaseVelocity(lateFlick, 1062);
// The window averages the last ~90ms, so the throw reads 1.5 here rather than the
// flick's own 3 — the drag's own 0.02px/ms average is what must not win.
check("only the end of the gesture sets the release speed", flick.vx > 1, String(flick.vx));

// A fast drag that came to a stop before the hand let go does not throw: the
// hand placed the content and meant it.
const stopped = [
  { t: 900, x: 0, y: 0 },
  { t: 920, x: 60, y: 0 },
  { t: 1200, x: 61, y: 0 },
  { t: 1240, x: 61, y: 0 },
];
check("a drag that stopped before release does not throw", !isFlung(...Object.values(releaseVelocity(stopped, 1240))), JSON.stringify(releaseVelocity(stopped, 1240)));

// One sample is not a gesture.
check("a single sample has no speed", near(releaseVelocity([{ t: 5, x: 1, y: 1 }], 6).vx, 0));

// The speed is capped, so a whip cannot become a jump cut.
const whip = [0, 8, 16].map((t, i) => ({ t, x: i * 200, y: 0 }));
check("the throw is capped", near(releaseVelocity(whip, 16).vx, FLING.max), String(releaseVelocity(whip, 16).vx));

// Both axes, and the vertical one is the one a list uses.
const diagonal = [0, 16].map((t, i) => ({ t, x: i * 16, y: i * 32 }));
const both = releaseVelocity(diagonal, 16);
check("a diagonal drag throws on both axes", near(both.vx, 1) && near(both.vy, 2), JSON.stringify(both));

// --- the decay --------------------------------------------------------------

const oneFrame = decayVelocity(1, 0, FLING.frame);
check("one frame keeps exactly the friction", near(oneFrame.vx, FLING.friction), String(oneFrame.vx));
const twoFrames = decayVelocity(1, 0, FLING.frame * 2);
check("two frames keep it twice", near(twoFrames.vx, FLING.friction ** 2), String(twoFrames.vx));
// A dropped frame must travel as far, not further: the decay follows the time.
check("a long frame decays by the time it took", near(decayVelocity(1, 0, FLING.frame * 4).vx, FLING.friction ** 4), "");

let v = FLING.max;
let frames = 0;
while (!isSpent(v, 0) && frames < 600) {
  v = decayVelocity(v, 0, FLING.frame).vx;
  frames += 1;
}
const seconds = (frames * FLING.frame) / 1000;
check("a throw at the cap is over in about a second and a half", seconds > 0.8 && seconds < 2.2, `${seconds.toFixed(2)}s`);

// --- the thresholds ---------------------------------------------------------

check("a slow release is a placement, not a throw", !isFlung(0.05, 0) && isFlung(FLING.min, 0));
check("a throw is over below the stop speed", isSpent(FLING.stop * 0.9, 0) && !isSpent(FLING.stop * 1.1, 0));

// The distance is the feel: a normal flick should cross a few rows, not a screen
// and not three pixels.
const flickDistance = flingDistance(0.6, 0);
check("a normal flick travels a readable distance", flickDistance > 100 && flickDistance < 260, `${flickDistance.toFixed(0)}px`);
const cappedDistance = flingDistance(FLING.max, 0);
check("and a whip is a pane or two, never a jump", cappedDistance > 900 && cappedDistance < 1800, `${cappedDistance.toFixed(0)}px`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
