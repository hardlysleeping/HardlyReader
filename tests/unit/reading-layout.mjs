import { strict as assert } from "node:assert";
import {
  ALIGN_INITIAL,
  LEADINGS,
  LEADING_INITIAL,
  LEADING_LABELS,
  LEADING_ORDER,
  LAYOUT_INITIAL,
  ROW_SCALE,
  TEXT_ALIGNS,
  TEXT_SCALE,
  atScaleLimit,
  clampScale,
  isDefaultLayout,
  isLeading,
  isTextAlign,
  readingStyle,
  readingVars,
  THUMB_SCALE,
  THUMB_SIDES,
  THUMB_SIDE_INITIAL,
  THUMB_SIDE_LABELS,
  ARTICLE_IMAGE_INITIAL,
  isThumbSide,
  isStepPercent,
  STEP_INITIAL,
  STEP_PERCENTS,
  THUMB_BASE_PX,
  thumbWidthPx,
  scalePercent,
  stepScale,
  FLIP_EDGE,
  clampFlipEdge,
} from "../../src/lib/reading-layout.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

check("both scales start at 100%", () => {
  assert.equal(TEXT_SCALE.initial, 1);
  assert.equal(ROW_SCALE.initial, 1);
  assert.equal(TEXT_SCALE.min, 0.85);
  assert.equal(TEXT_SCALE.max, 1.5);
  assert.equal(ROW_SCALE.max, 1.4);
});

check("clamping keeps a value inside the scale", () => {
  assert.equal(clampScale(2, TEXT_SCALE), 1.5);
  assert.equal(clampScale(0.1, TEXT_SCALE), 0.85);
  assert.equal(clampScale(1.2, TEXT_SCALE), 1.2);
});

check("junk in storage falls back to 100%, not NaN", () => {
  assert.equal(clampScale(undefined, TEXT_SCALE), 1);
  assert.equal(clampScale("big", TEXT_SCALE), 1);
  assert.equal(clampScale(Number.POSITIVE_INFINITY, TEXT_SCALE), 1);
  assert.equal(clampScale(Number.NaN, TEXT_SCALE), 1);
});

check("stepping up from the bottom does not drift", () => {
  // 0.85 + 0.1 is 0.9500000000000001 in binary floating point.
  assert.equal(stepScale(0.85, 1, TEXT_SCALE), 0.9, "default step is 5%");
  assert.equal(stepScale(0.95, 1, TEXT_SCALE), 1);
  assert.equal(stepScale(1.05, -1, TEXT_SCALE), 1);
  assert.equal(stepScale(1, 1, TEXT_SCALE, 1), 1.01);
  assert.equal(stepScale(1, 1, TEXT_SCALE, 10), 1.1);
});

check("stepping stops at the ends rather than leaving the scale", () => {
  assert.equal(stepScale(1.5, 1, TEXT_SCALE), 1.5);
  assert.equal(stepScale(0.85, -1, TEXT_SCALE), 0.85);
  assert.equal(stepScale(3, 1, TEXT_SCALE), 1.5);
});

check("the limits say so, for disabling a button", () => {
  assert.equal(atScaleLimit(1.5, 1, TEXT_SCALE), true);
  assert.equal(atScaleLimit(1.4, 1, TEXT_SCALE), false);
  assert.equal(atScaleLimit(0.85, -1, TEXT_SCALE), true);
  assert.equal(atScaleLimit(1, 1, TEXT_SCALE), false);
});

check("the readout is a whole percentage", () => {
  assert.equal(scalePercent(1), "100%");
  assert.equal(scalePercent(0.95), "95%");
  assert.equal(scalePercent(1.5), "150%");
  assert.equal(scalePercent(9), "150%", "out-of-range values report the clamped value");
});

check("row percentages use the row scale's own bounds", () => {
  assert.equal(scalePercent(1.4, ROW_SCALE), "140%");
  assert.equal(scalePercent(2, ROW_SCALE), "140%");
});

check("leading has three named steps and a label each", () => {
  assert.deepEqual([...LEADING_ORDER], ["tight", "normal", "loose"]);
  for (const leading of LEADING_ORDER) {
    assert.equal(typeof LEADINGS[leading], "number");
    assert.ok(LEADING_LABELS[leading].length > 0);
  }
  assert.ok(LEADINGS.tight < LEADINGS.normal && LEADINGS.normal < LEADINGS.loose);
  assert.equal(LEADING_INITIAL, "normal");
});

check("alignment is left, centre, right, defaulting to left", () => {
  assert.deepEqual([...TEXT_ALIGNS], ["left", "center", "right"]);
  assert.equal(ALIGN_INITIAL, "left");
});

check("stored strings are validated, not trusted", () => {
  assert.equal(isLeading("loose"), true);
  assert.equal(isLeading("wide"), false);
  assert.equal(isLeading(1.6), false);
  assert.equal(isTextAlign("center"), true);
  assert.equal(isTextAlign("justify"), false);
});

check("the variables carry the numbers the panes read", () => {
  const vars = readingVars({
    textScale: 1.2,
    rowScale: 0.9,
    leading: "loose",
    align: "center",
  });
  assert.equal(vars["--read-scale"], "1.2");
  assert.equal(vars["--row-scale"], "0.9");
  assert.equal(vars["--read-leading"], String(LEADINGS.loose));
  assert.equal("--read-indent" in vars, false, "paragraphs are not indented any more");
  assert.equal(vars["--read-align"], "center");
});

check("nothing sets a paragraph indent any more", () => {
  // The setting is gone rather than defaulted off: a stored `indentParagraphs`
  // from an older build is ignored on load, so a first-line indent cannot come
  // back without a control to turn it off again.
  const vars = readingVars({ ...LAYOUT_INITIAL });
  assert.equal("--read-indent" in vars, false);
});

check("a bad leading or alignment in memory still yields usable CSS", () => {
  const vars = readingVars({
    textScale: 99,
    rowScale: -1,
    leading: "sideways",
    align: "justify",
  });
  assert.equal(vars["--read-scale"], "1.5");
  assert.equal(vars["--row-scale"], "0.8");
  assert.equal(vars["--read-leading"], String(LEADINGS[LEADING_INITIAL]));
  assert.equal(vars["--read-align"], ALIGN_INITIAL);
});

check("the style string is five declarations", () => {
  const style = readingStyle({ ...LAYOUT_INITIAL });
  assert.equal(style.split(";").length, 5);
  assert.ok(style.startsWith("--read-scale:1;"));
  assert.equal(style.includes("--read-indent"), false, "paragraph indent is gone");
});

check("the picture has a size of its own, separate from the row", () => {
  const vars = readingVars({ ...LAYOUT_INITIAL, thumbScale: 1.6 });
  assert.equal(vars["--thumb-scale"], "1.6");
  assert.equal(vars["--row-scale"], "1", "sizing the picture must not resize the row type");
});

check("the picture scale is clamped to its own range, not the row's", () => {
  assert.equal(readingVars({ ...LAYOUT_INITIAL, thumbScale: 99 })["--thumb-scale"], String(THUMB_SCALE.max));
  assert.equal(readingVars({ ...LAYOUT_INITIAL, thumbScale: 0 })["--thumb-scale"], String(THUMB_SCALE.min));
  assert.equal(THUMB_SCALE.min < ROW_SCALE.min, true, "a picture may shrink further than the row may");
});

check("its steps land on the scale and stop at the ends", () => {
  assert.equal(stepScale(THUMB_SCALE.initial, 1, THUMB_SCALE), 1.05, "pictures move 5%, not a fifth");
  assert.equal(stepScale(THUMB_SCALE.initial, -1, THUMB_SCALE), 0.95);
  assert.equal(stepScale(THUMB_SCALE.max, 1, THUMB_SCALE), THUMB_SCALE.max);
  assert.equal(stepScale(THUMB_SCALE.min, -1, THUMB_SCALE), THUMB_SCALE.min);
});

check("every side is a known side, and junk falls back", () => {
  assert.equal(THUMB_SIDES.length, 3);
  assert.equal(THUMB_SIDES.includes("off"), true);
  assert.equal(isThumbSide("left"), true);
  assert.equal(isThumbSide("sideways"), false);
  assert.equal(isThumbSide(undefined), false);
  assert.equal(THUMB_SIDE_LABELS[THUMB_SIDE_INITIAL], "Right", "the shipped position is unchanged");
});

check("the article picture is on by default and is a setting", () => {
  assert.equal(ARTICLE_IMAGE_INITIAL, true);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, articleImage: false }), false);
});

check("Reset restores the picture size but leaves its side alone", () => {
  const dirty = { ...LAYOUT_INITIAL, thumbScale: 1.8, thumbSide: "left" };
  assert.equal(isDefaultLayout(dirty), false, "a moved picture is not defaults");
  const reset = { ...dirty, thumbScale: THUMB_SCALE.initial };
  assert.equal(isDefaultLayout(reset), true, "size is a quantity; the side is a position he chose");
});

check("one step size governs every scale, and 5% is the default", () => {
  assert.deepEqual([...STEP_PERCENTS], [1, 5, 10]);
  assert.equal(STEP_INITIAL, 5);
  assert.equal(isStepPercent(5), true);
  assert.equal(isStepPercent(20), false, "20% was the old picture step and is gone");
  for (const percent of STEP_PERCENTS) {
    assert.equal(stepScale(1, 1, ROW_SCALE, percent), 1 + percent / 100);
    assert.equal(stepScale(1, 1, THUMB_SCALE, percent), 1 + percent / 100);
  }
});

check("1% steps land on exact percents, not float dust", () => {
  let value = 1;
  for (let i = 0; i < 7; i += 1) value = stepScale(value, 1, TEXT_SCALE, 1);
  assert.equal(value, 1.07);
  assert.equal(scalePercent(value), "107%");
});

check("a 1% step still stops at the ends", () => {
  assert.equal(stepScale(TEXT_SCALE.max, 1, TEXT_SCALE, 1), TEXT_SCALE.max);
  assert.equal(stepScale(TEXT_SCALE.min, -1, TEXT_SCALE, 1), TEXT_SCALE.min);
});

check("the step is part of the defaults, so Reset restores 5%", () => {
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, stepPercent: 10 }), false);
});

check("the readout agrees with the stylesheet's arithmetic", () => {
  assert.equal(THUMB_BASE_PX, 48, "the stylesheet hardcodes the same base");
  assert.equal(thumbWidthPx(1, 1), 48);
  assert.equal(thumbWidthPx(1, 1.6), 77, "rounded, not truncated");
  assert.equal(thumbWidthPx(1.4, 1), 67);
  assert.equal(thumbWidthPx(1, 0.6), 29);
  assert.equal(thumbWidthPx(99, 99), 134, "both scales clamp, so the readout cannot promise 3966px");
});

check("defaults are recognised, so Reset can be disabled", () => {
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL }), true);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, textScale: 1.1 }), false);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, align: "right" }), false);
  assert.equal(
    isDefaultLayout({ ...LAYOUT_INITIAL, textScale: 99 }),
    false,
    "an out-of-range value clamps to the end of the scale, which is not the default",
  );
});

check("the card flip edge is adjustable but stays hittable and leavable", () => {
  assert.equal(clampFlipEdge(FLIP_EDGE.initial), 10, "a fifth of the card in total: the edges, and four fifths in the middle");
  assert.equal(clampFlipEdge(1), 10, "below a tenth there is nothing to aim at");
  assert.equal(clampFlipEdge(80), 45, "above this the middle stops being reachable");
  assert.equal(clampFlipEdge(Number.NaN), 10);
  assert.equal(clampFlipEdge(27.6), 28, "whole percentages only");
  assert.equal(clampFlipEdge(10), 10);
});

console.log(`\n${passed}/${passed} checks passed`);
