import {
  EFFORT_DEFAULT, EFFORT_HARD_MAX, EFFORT_HARD_MIN, EFFORT_MAX, EFFORT_MIN, PULL_CURVE,
  PULL_THRESHOLD, accumulate, clampEffort, curveAt, directionOf, effortForSwipePx, peekOf,
  progressOf, shouldAdvance, SWIPE_GAIN, swipePxFor, swipePull, swipeTravel, thresholdFor,
  travelAt, travelFor, travelToAdvance, withinSlider,
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

// The curve: the first pixels are cheap, the last ones are the expensive half.
// `curveAt` is progress for a share of the travel; `travelAt` its inverse.
check("no travel, no pull", curveAt(0) === 0 && curveAt(-3) === 0);
check("the whole travel fills it", curveAt(1) === 1 && curveAt(9) === 1 && curveAt(Infinity) === 1);
check("progress never falls as travel is spent", [0.1, 0.3, 0.5, 0.7, 0.9, 1].every((u, i, all) => i === 0 || curveAt(u) > curveAt(all[i - 1])));
// The owner's ask, as a number: "it should take more effort towards the end".
// The first quarter of the bar is 13% of the travel; the last quarter is 50%.
check("the first quarter of the bar is cheap", Math.abs(travelAt(0.25) - 0.134) < 0.01, String(travelAt(0.25).toFixed(3)));
check("the last quarter of the bar is half the travel", Math.abs(travelAt(0.75) - 0.5) < 0.001, String(travelAt(0.75).toFixed(3)));
check("the inverse is exact", [0.05, 0.25, 0.5, 0.75, 1].every((p) => Math.abs(curveAt(travelAt(p)) - p) < 1e-9));
check("the curve is the shipped shape", PULL_CURVE === 2);

// Accumulating.
check("a delta adds less than itself", accumulate(0, 100) < 100 && accumulate(200, 100) < 300);
check("the pull never exceeds the threshold", accumulate(PULL_THRESHOLD - 1, 10_000) === PULL_THRESHOLD);
check("scrolling up builds the pull backwards", accumulate(0, -100) < 0 && Math.abs(accumulate(0, -100) + accumulate(0, 100)) < 1e-9);
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

// It is not linear: the same travel at the end moves the pull much less than at
// the start. A 100px notch is worth 72px of pull on the first tick and 13px once
// the bar is nearly full — the old curve held it at 26–38px through the middle,
// which is why the last stretch felt exactly as heavy as the fourth notch.
const firstNotch = accumulate(0, 100);
const lateNotch = accumulate(260, 100) - 260;
check("the same wheel travel does less work late", lateNotch < firstNotch * 0.25, `${lateNotch.toFixed(1)} vs ${firstNotch.toFixed(1)}`);
check("...and each notch buys less than the one before", (() => {
  let pull = 0;
  let last = Infinity;
  for (let i = 0; i < 6; i += 1) {
    const before = pull;
    pull = accumulate(pull, 100);
    const gained = pull - before;
    if (i > 0 && gained > last + 0.001) return false;
    last = gained;
  }
  return true;
})());

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

// The curve integrates to the travel `travelFor` reports: a full pull costs
// exactly one travel's worth, whatever the shape between.
check("the cost is the travel", Math.abs(travel - travelFor(PULL_THRESHOLD)) <= 1, `${travel} vs ${travelFor(PULL_THRESHOLD)}`);
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
check("effort beyond the slider is allowed", clampEffort(4) === 4, String(clampEffort(4)));
check("effort below the slider is allowed", clampEffort(0.3) === 0.3, String(clampEffort(0.3)));
check("effort clamps at the hard ceiling", clampEffort(99) === EFFORT_HARD_MAX, String(clampEffort(99)));
check("effort clamps at the hard floor", clampEffort(0) === EFFORT_HARD_MIN, String(clampEffort(0)));
check("the slider range is unchanged", EFFORT_MIN === 0.5 && EFFORT_MAX === 2);
check("the slider pins an out-of-range value", withinSlider(4, EFFORT_MIN, EFFORT_MAX) === 2 && withinSlider(0.3, EFFORT_MIN, EFFORT_MAX) === 0.5);
check("the slider passes a value inside its range through", withinSlider(1.4, EFFORT_MIN, EFFORT_MAX) === 1.4);
check("the hard ceiling is ten", EFFORT_HARD_MAX === 10);
check("effort is kept to one decimal", clampEffort(1.234) === 1.2, String(clampEffort(1.234)));
check("rubbish effort falls back to the default", clampEffort("nope") === EFFORT_DEFAULT && clampEffort(null) === EFFORT_DEFAULT);
const easyTravel = travelToAdvance(thresholdFor(0.5));
const hardTravel = travelToAdvance(thresholdFor(2));
check("the harder setting really takes more scrolling", hardTravel > easyTravel * 3, `${easyTravel} vs ${hardTravel}`);
check("the easy setting is still a deliberate pull", easyTravel > 300, String(easyTravel));
check("the hardest setting is not absurd", hardTravel < 1600, String(hardTravel));
check("the default effort still needs the tuned travel", Math.abs(travelToAdvance(thresholdFor(1)) - travel) <= 1);

// A finger, on the same curve. The phone had no way past the end of an article
// at all: dragging stopped where the scroll stopped. It fills the same pull, so
// the line that fills under the wheel fills under a thumb too.
check("a finger that has not moved has not pulled", swipePull(0) === 0 && swipePull(-40) === 0);
check("a finger builds the pull", swipePull(60) > 0 && swipePull(120) > swipePull(60));
check("a finger cannot overfill it", swipePull(10_000) === PULL_THRESHOLD);
check("nonsense pulls nothing", swipePull(NaN) === 0 && swipePull(Infinity) === PULL_THRESHOLD);
const thumbEarly = swipePull(30) - swipePull(10);
const thumbLateSame = swipePull(swipeTravel() - 2) - swipePull(swipeTravel() - 22);
check("the same thumb travel does less work late", thumbLateSame < thumbEarly, `${thumbLateSame.toFixed(1)} vs ${thumbEarly.toFixed(1)}`);
check("a sweep of a thumb gets there", swipePull(swipeTravel()) >= PULL_THRESHOLD - 0.5, String(swipePull(swipeTravel()).toFixed(2)));
check("and it takes a swipe, not a nudge", swipeTravel() > 120 && swipeTravel() < 320, String(swipeTravel()));
check("an ordinary swipe is not enough", shouldAdvance(swipePull(140)) === false, String(swipePull(140).toFixed(1)));
check("the finger and the wheel cost the same, in their own units",
  Math.abs(swipeTravel() * SWIPE_GAIN - travelToAdvance()) <= 3,
  `${swipeTravel() * SWIPE_GAIN} vs ${travelToAdvance()}`);
check("more effort means a longer swipe", swipeTravel(thresholdFor(2)) > swipeTravel(thresholdFor(1)));
check("less effort means a shorter one", swipeTravel(thresholdFor(0.5)) < swipeTravel(thresholdFor(1)));
check("a useless threshold or gain pulls nothing", swipePull(200, 0) === 0 && swipePull(200, PULL_THRESHOLD, 0) === 0 && swipeTravel(0) === 0);

// A trackpad flick keeps sending deltas after the switch. Those must not be
// read as a pull on the post that has just arrived, or one flick skips a post.
const { readFileSync } = await import("node:fs");
const pane = readFileSync(new URL("../../src/components/ReaderPane.svelte", import.meta.url), "utf8");
const wheel = pane.slice(pane.indexOf("function onwheel("), pane.indexOf("$effect(", pane.indexOf("function onwheel(")));
check("a switch locks the wheel for a moment", /SETTLE_MS/.test(pane) && /settleUntil = performance\.now\(\) \+ SETTLE_MS/.test(pane));
check("the leftover travel of a flick cannot build a pull", /performance\.now\(\) < settleUntil/.test(wheel));

// The finger half: same accumulator, same line, one direction only.
check("the article listens to the finger", /ontouchstart=\{onArticleTouchStart\}/.test(pane) &&
  /ontouchmove=\{onArticleTouchMove\}/.test(pane) &&
  /ontouchend=\{onArticleTouchEnd\}/.test(pane) && /ontouchcancel=\{onArticleTouchEnd\}/.test(pane));
check("only from the end of the article", /if \(performance\.now\(\) < settleUntil \|\| !atEnd\(el\)\) return;/.test(pane));
check("advance-on-scroll decides whether it exists", /if \(!reading\.advanceOnScroll \|\| !el \|\| event\.touches\.length !== 1\) return;/.test(pane));
check("it fills the wheel's own accumulator", /pull = travel > 0 \? swipePull\(travel, threshold\) : 0;/.test(pane));
check("letting go early puts the pull back", /const fire = shouldAdvance\(pull, threshold\);\s*swipeId = null;\s*if \(!fire\) \{[\s\S]{0,240}?springBack\(\);/.test(pane));
check("a finished swipe advances forward, once", /settleUntil = performance\.now\(\) \+ SETTLE_MS;\s*void store\.advanceArticle\(1\);/.test(pane));
// The line has to be on the content's edge: the article's bar sits on the
// pane's edge now, and the first attempt drew the line behind it — a swipe with
// no feedback at all, in the one place the swipe is the only way through.
check("the bar is measured, not guessed", /bind:clientHeight=\{barHeight\}/.test(pane));
check("the line sits above the bar when the bar is at the bottom",
  /style:bottom=\{pull < 0 \? "auto" : barAtBottom \? `\$\{barHeight\}px` : "0px"\}/.test(pane));
check("and along the words' top edge when it fills upwards",
  /style:top=\{pull < 0 \? \(barAtBottom \? "0px" : `\$\{barHeight\}px`\) : "auto"\}/.test(pane));

check("a drag that turns into a scroll is given up", /if \(!atEnd\(el\)\) \{[\s\S]{0,140}?swipeId = null;\s*resetPull\(\);/.test(pane));

/* ---------------------------------------------------------------------------
 * The drag the owner asked to be longer, and the reveal he asked to be optional
 * ------------------------------------------------------------------------- */

// "default is too low need 150% increase for the amount i need to drag before it
// scrolls to the next article" — the finger's gain came down from 4, so a full
// pull is 273px of thumb instead of 182. The wheel's 728px is untouched.
check("half again as long as it was", Math.abs(swipeTravel() - 273) <= 1, String(swipeTravel()));
check(
  "...which is 1.5x the old 182px",
  Math.abs(swipeTravel() / 182 - 1.5) < 0.01,
  String((swipeTravel() / 182).toFixed(3)),
);
check("and the wheel still costs what it did", Math.abs(travelToAdvance() - 728) <= 2, String(travelToAdvance()));

// One store, two units: the desktop row shows the multiplier, the phone's shows
// the distance. 273px is ×1 and each tenth of effort is about 27px.
check("the phone's distance is the wheel's effort", swipePxFor(1) === swipeTravel(), `${swipePxFor(1)} vs ${swipeTravel()}`);
check("×1.5 is half again as far", swipePxFor(1.5) > swipeTravel() * 1.45 && swipePxFor(1.5) < swipeTravel() * 1.55, String(swipePxFor(1.5)));
check("a distance converts back to the effort it means", effortForSwipePx(273) === 1, String(effortForSwipePx(273)));
check("round trip in pixels", [110, 273, 410].every((px) => Math.abs(swipePxFor(effortForSwipePx(px)) - px) <= 3));
check("nonsense pixels are the default", effortForSwipePx(NaN) === EFFORT_DEFAULT && effortForSwipePx(0) === EFFORT_HARD_MIN);

// The reveal is driven by the bar's progress, not by travel, so a wheel and a
// thumb uncover the same post at the same point on the line. It starts before the
// apex — an apex-only reveal would be a flash on the last pixel — and is complete
// at the apex, because at that point letting go switches: a page that started to
// move and then stopped short would be a page that lied.
check("nothing is revealed on the way down", peekOf(0) === 0 && peekOf(0.5) === 0 && peekOf(0.79) === 0);
check("it begins as the bar nears full", peekOf(0.85) > 0 && peekOf(0.9) > peekOf(0.85));
check("the apex reveals the whole post", peekOf(1) === 1, String(peekOf(1)));
check("and it never exceeds the layer", peekOf(4) === 1 && peekOf(Infinity) === 1);
check("off means off, whatever the pull", peekOf(1, false) === 0 && peekOf(0.99, false) === 0);
// On the shipped curve the reveal covers the last stretch of travel — the one
// that costs the most — so the page starts to move exactly where the effort goes.
check(
  "the reveal begins a full notch before the switch",
  Math.abs(curveAt(travelAt(0.8)) - 0.8) < 1e-9 && peekOf(progressOf(accumulate(223, 100))) > 0,
  String(peekOf(progressOf(accumulate(223, 100))).toFixed(2)),
);

// And the pane: a curve back, not a disappearance; the post lifts; the reveal
// is the setting's.
check("letting go springs back on a curve", /function springBack\(\)[\s\S]{0,700}?1 - Math\.pow\(1 - t, 3\)/.test(pane));
check("...for a quarter of a second", /const SPRING_MS = 260;/.test(pane));
check("...and a wheel pause uses it too", /pullTimer = setTimeout\(\(\) => \{\s*pullTimer = null;\s*\/\/ A pause is a release[\s\S]{0,60}?springBack\(\);/.test(pane));
// Forward only: the layer behind the page is the post *after* this one, so a
// pull upwards must not uncover it — that would show the wrong post for the way
// the reader is going.
check("the reveal is the setting's to give", /peek = pull > 0 \? peekOf\(progressOf\(pull, threshold\), reading\.apexPeek\) : 0;/.test(pane));
check("...and only forwards", !/peek = peekOf\(progressOf\(/.test(pane));
// The wheel reveals too, at the same place on the line. Before this it filled the
// line and then swapped the post under the reader with nothing sliding at all.
check(
  "the wheel uncovers the next post as well",
  (pane.match(/peek = pull > 0 \? peekOf\(progressOf\(pull, threshold\), reading\.apexPeek\) : 0;/g) ?? []).length === 2,
  String((pane.match(/peek = peekOf\(/g) ?? []).length),
);
check("...and the wheel reveals after it accumulates, not before", (() => {
  const at = wheel.indexOf("pull = accumulate(pull, event.deltaY, threshold);");
  const peekAt = wheel.indexOf("peek = pull > 0 ? peekOf(progressOf(pull, threshold)");
  return at >= 0 && peekAt > at && peekAt - at < 600;
})());
check("the open post lifts out of the way", /style:transform=\{peek > 0 \? `translateY\(\$\{\(-peek \* PEEK_LIFT\)/.test(pane));
check("the next post is drawn behind it", /<div class="next" style:--peek=\{peek\} aria-hidden="true">/.test(pane) && /Next post/.test(pane));
check("a switch is still the quiet one", /resetPull\(\);\s*settleUntil = performance\.now\(\) \+ SETTLE_MS;\s*void store\.advanceArticle\(1\);/.test(pane));

// The Aa panel the phone opens has the row; the desktop's does not, because a
// cursor has no drag to shorten.
const controls = readFileSync(new URL("../../src/components/ReadingPanel.svelte", import.meta.url), "utf8");
check("the phone's Aa panel carries the drag row", /Drag to next/.test(controls) && /\{swipePx\}px/.test(controls));
check("...and the reveal switch", /Reveal next/.test(controls) && /reading\.setApexPeek/.test(controls));
check("both rows are gated on the phone", /\{#if phone\}\n  <div class="row">\n    <span class="key">Drag to next<\/span>/.test(controls));
check("the row writes the same store the desktop does", /reading\.stepScrollEffort\(-1\)/.test(controls) && /reading\.stepScrollEffort\(1\)/.test(controls));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
