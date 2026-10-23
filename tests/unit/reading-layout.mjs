import { strict as assert } from "node:assert";
import {
  ALIGN_INITIAL,
  LEADINGS,
  LEADING_INITIAL,
  LEADING_LABELS,
  LEADING_ORDER,
  LAYOUT_INITIAL,
  PARAGRAPH_INDENT,
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
  scalePercent,
  stepScale,
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
  assert.equal(stepScale(0.85, 1, TEXT_SCALE), 0.95);
  assert.equal(stepScale(0.95, 1, TEXT_SCALE), 1.05);
  assert.equal(stepScale(1.05, -1, TEXT_SCALE), 0.95);
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
    indent: true,
    align: "center",
  });
  assert.equal(vars["--read-scale"], "1.2");
  assert.equal(vars["--row-scale"], "0.9");
  assert.equal(vars["--read-leading"], String(LEADINGS.loose));
  assert.equal(vars["--read-indent"], PARAGRAPH_INDENT);
  assert.equal(vars["--read-align"], "center");
});

check("indent off is a zero, not an absent property", () => {
  const vars = readingVars({ ...LAYOUT_INITIAL, indent: false });
  assert.equal(vars["--read-indent"], "0");
});

check("a bad leading or alignment in memory still yields usable CSS", () => {
  const vars = readingVars({
    textScale: 99,
    rowScale: -1,
    leading: "sideways",
    indent: false,
    align: "justify",
  });
  assert.equal(vars["--read-scale"], "1.5");
  assert.equal(vars["--row-scale"], "0.8");
  assert.equal(vars["--read-leading"], String(LEADINGS[LEADING_INITIAL]));
  assert.equal(vars["--read-align"], ALIGN_INITIAL);
});

check("the style string is six declarations", () => {
  const style = readingStyle({ ...LAYOUT_INITIAL });
  assert.equal(style.split(";").length, 6);
  assert.ok(style.startsWith("--read-scale:1;"));
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
  assert.equal(stepScale(THUMB_SCALE.initial, 1, THUMB_SCALE), 1.2);
  assert.equal(stepScale(THUMB_SCALE.initial, -1, THUMB_SCALE), 0.8);
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

check("defaults are recognised, so Reset can be disabled", () => {
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL }), true);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, textScale: 1.1 }), false);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, indent: true }), false);
  assert.equal(isDefaultLayout({ ...LAYOUT_INITIAL, align: "right" }), false);
  assert.equal(
    isDefaultLayout({ ...LAYOUT_INITIAL, textScale: 99 }),
    false,
    "an out-of-range value clamps to the end of the scale, which is not the default",
  );
});

console.log(`\n${passed}/${passed} checks passed`);
