import {
  EFFORT_DEFAULT, EFFORT_MAX, EFFORT_MIN, PULL_THRESHOLD, RESISTANCE, accumulate, clampEffort,
  contribution, directionOf, progressOf, shouldAdvance, thresholdFor, travelToAdvance,
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
check("scrolling up builds the pull backwards", accumulate(0, -100) === -100);
check("the pull stops at the threshold downwards", accumulate(-(PULL_THRESHOLD - 1), -10_000) === -PULL_THRESHOLD);
check("reversing eats the pull already made", accumulate(120, -60) > 0 && accumulate(120, -60) < 120);
check("...an equal reversal does not sweep the pull away at once", accumulate(120, -120) > 0);
check("...but continuing back through zero does", accumulate(120, -1000) < 0);
check("a reversal cannot overshoot the other way in one tick", accumulate(100, -10_000) === -PULL_THRESHOLD);
check("a zero delta leaves the pull alone", accumulate(77, 0) === 77);
check("advance fires upwards at the threshold", shouldAdvance(-PULL_THRESHOLD) === true);
check("advance does not fire early upwards", shouldAdvance(-(PULL_THRESHOLD - 1)) === false);
check("progress is direction-blind", progressOf(-PULL_THRESHOLD / 2) === 0.5);
check("direction is read from the sign", directionOf(-3) === -1 && directionOf(3) === 1 && directionOf(0) === 0);

// It is not linear: the same travel at the end moves the pull less than at the start.
const early = accumulate(0, 40) - 0;
const late = accumulate(PULL_THRESHOLD * 0.9, 40) - PULL_THRESHOLD * 0.9;
check("the same wheel travel does less work late", late < early * 0.6, `${late.toFixed(1)} vs ${early.toFixed(1)}`);

// Enough travel eventually switches, and it is meaningfully more than a single
// threshold's worth — that is the whole point of the resistance.
const travel = travelToAdvance();
check("a full pull is reachable", travel < PULL_THRESHOLD * 100, String(travel));
check("it takes more than the threshold in wheel travel", travel > PULL_THRESHOLD, `${travel} vs ${PULL_THRESHOLD}`);
check("but not absurdly more", travel < PULL_THRESHOLD * 2.7, String(travel));
// A 100px notch is the common wheel delta; the point of the curve is that it
// takes a run of them — about seven — rather than two.
let notches = 0;
let pullNow = 0;
while (!shouldAdvance(pullNow) && notches < 20) {
  pullNow = accumulate(pullNow, 100);
  notches += 1;
}
check("it takes several deliberate notches, not one", notches >= 6 && notches <= 9, String(notches));
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
check("a smaller threshold still resists", shortTravel > 120 && shortTravel < 120 * 2.7, String(shortTravel));

// Upwards costs exactly what downwards costs: the curve is on the magnitude, so
// there is no "easier" direction to surprise anyone.
let upPull = 0;
let upNotches = 0;
while (!shouldAdvance(upPull) && upNotches < 20) {
  upPull = accumulate(upPull, -100);
  upNotches += 1;
}
check("scrolling up takes the same run of notches", upNotches === notches, `${upNotches} vs ${notches}`);

// Effort: one multiplier on the threshold, so the tuned default is untouched and
// both directions scale together.
check("the default effort changes nothing", thresholdFor(EFFORT_DEFAULT) === PULL_THRESHOLD, String(thresholdFor(EFFORT_DEFAULT)));
check("the default is 1", EFFORT_DEFAULT === 1);
check("less effort shortens the pull", thresholdFor(0.5) === PULL_THRESHOLD / 2, String(thresholdFor(0.5)));
check("more effort lengthens it", thresholdFor(2) === PULL_THRESHOLD * 2, String(thresholdFor(2)));
check("effort is clamped to its range", clampEffort(9) === EFFORT_MAX && clampEffort(0.1) === EFFORT_MIN);
check("effort is kept to one decimal", clampEffort(1.234) === 1.2, String(clampEffort(1.234)));
check("rubbish effort falls back to the default", clampEffort("nope") === EFFORT_DEFAULT && clampEffort(null) === EFFORT_DEFAULT);
const easyTravel = travelToAdvance(thresholdFor(0.5));
const hardTravel = travelToAdvance(thresholdFor(2));
check("the harder setting really takes more scrolling", hardTravel > easyTravel * 3, `${easyTravel} vs ${hardTravel}`);
check("the easy setting is still a deliberate pull", easyTravel > 300, String(easyTravel));
check("the hardest setting is not absurd", hardTravel < 1600, String(hardTravel));
check("the default effort still needs the tuned travel", Math.abs(travelToAdvance(thresholdFor(1)) - travel) <= 1);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
