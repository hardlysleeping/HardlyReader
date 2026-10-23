import {
  PULL_THRESHOLD, RESISTANCE, accumulate, contribution, progressOf, shouldAdvance, travelToAdvance,
} from "../../src/lib/scroll-advance.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The curve: the first pixel counts fully, the last hardly at all.
check("no resistance at the start", contribution(0) === 1, String(contribution(0)));
check("resistance grows with progress", contribution(0.5) < contribution(0.25));
check("the last stretch is the heaviest", contribution(1) === 1 / (1 + RESISTANCE), String(contribution(1)));
check("progress outside 0..1 is clamped", contribution(-5) === 1 && contribution(9) === contribution(1));

// Accumulating.
check("a delta adds less than itself", accumulate(0, 100) === 100 && accumulate(200, 100) < 300);
check("the pull never exceeds the threshold", accumulate(PULL_THRESHOLD - 1, 10_000) === PULL_THRESHOLD);
check("scrolling up does not count", accumulate(120, -500) === 120);
check("the pull cannot go negative", accumulate(0, -500) === 0);

// It is not linear: the same travel at the end moves the pull less than at the start.
const early = accumulate(0, 40) - 0;
const late = accumulate(PULL_THRESHOLD * 0.9, 40) - PULL_THRESHOLD * 0.9;
check("the same wheel travel does less work late", late < early * 0.6, `${late.toFixed(1)} vs ${early.toFixed(1)}`);

// Enough travel eventually switches, and it is meaningfully more than a single
// threshold's worth — that is the whole point of the resistance.
const travel = travelToAdvance();
check("a full pull is reachable", travel < PULL_THRESHOLD * 100, String(travel));
check("it takes more than the threshold in wheel travel", travel > PULL_THRESHOLD, `${travel} vs ${PULL_THRESHOLD}`);
check("but not absurdly more", travel < PULL_THRESHOLD * 2.4, String(travel));
// A 100px notch is the common wheel delta; the point of the curve is that the
// fourth one finishes the pull rather than the second.
let notches = 0;
let pullNow = 0;
while (!shouldAdvance(pullNow) && notches < 20) {
  pullNow = accumulate(pullNow, 100);
  notches += 1;
}
check("it takes several deliberate notches, not one", notches >= 3 && notches <= 5, String(notches));
// The curve integrates to threshold * (1 + resistance / 2); asserting it keeps
// the constant honest if someone retunes either number.
check(
  "the cost matches the curve",
  Math.abs(travel - PULL_THRESHOLD * (1 + RESISTANCE / 2)) <= 3,
  `${travel} vs ${PULL_THRESHOLD * (1 + RESISTANCE / 2)}`,
);
check("advance fires at the threshold", shouldAdvance(PULL_THRESHOLD) === true);
check("advance does not fire early", shouldAdvance(PULL_THRESHOLD - 1) === false);
check("progress is a fraction", progressOf(PULL_THRESHOLD / 2) === 0.5 && progressOf(PULL_THRESHOLD * 2) === 1);

// A short threshold behaves the same way, just sooner.
const shortTravel = travelToAdvance(120);
check("a smaller threshold still resists", shortTravel > 120 && shortTravel < 120 * 2.4, String(shortTravel));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
