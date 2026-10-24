/**
 * The stacked third pane: three panes drawn as the feeds beside one right-hand
 * column, posts above the article.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/stacked.mjs
 *
 * `panes.mjs` covers the arithmetic (the template, the width it needs, the
 * split, the 2 -> 3 press) and `stack-controls.mjs` the order and the tucks.
 * This suite covers the other half, which is not arithmetic at all: that the
 * arrangement is a saved preference, that the settings toggle reaches it on a
 * phone, and that the one grid which draws it really does — four row tracks in
 * every arrangement, a top pane, a seam and a bottom pane pinned to three of
 * them, and the panes hidden rather than torn down when the arrangement is off.
 *
 * The layout state cannot be imported here — it is a rune class that reads
 * `localStorage` at module scope — so the state checks read the source, as the
 * other layout suites do. The geometry is imported and pressed for real.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLAT_ROWS,
  STACK_GUTTER,
  STACK_SHARE,
  clampShare,
  paneSlots,
  stackTemplate,
} from "../../src/lib/panes.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const layout = read("src/state/layout.svelte.ts");
const panel = read("src/components/ThemePanel.svelte");
const main = read("src/views/Main.svelte");
const gutter = read("src/components/PaneGutter.svelte");

/** The index of the `}`-equivalent that closes the Svelte block opened at `open`. */
function blockEnd(source, open) {
  const start = source.indexOf(open);
  if (start < 0) return -1;
  const marks = /\{#(?:if|each|await|key|snippet)\b|\{\/(?:if|each|await|key|snippet)\}/g;
  marks.lastIndex = start;
  let depth = 0;
  for (let match = marks.exec(source); match !== null; match = marks.exec(source)) {
    if (match[0].startsWith("{#")) depth += 1;
    else {
      depth -= 1;
      if (depth === 0) return match.index;
    }
  }
  return -1;
}

/** The tracks of a grid-template string, splitting only outside `calc()`. */
function tracksOf(rows) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const char of rows) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === " " && depth === 0) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") out.push(current);
  return out;
}

/** The body of the first CSS rule with this exact selector, comments and all. */
function ruleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

// ---------------------------------------------------------------------------
// The setting: two fields, saved with the rest of the layout, and an old payload
// still loads — as side by side, which is what that payload was looking at.
check("the arrangement is state", /stacked = \$state\(false\)/.test(layout));
check("so is the split", /stackShare = \$state<number>\(STACK_SHARE\.fallback\)/.test(layout));
check("a saved arrangement is read", /this\.stacked = saved\.stacked === true;/.test(layout));
check(
  "and only an explicit true turns it on",
  !/this\.stacked = saved\.stacked \?\?/.test(layout) && !/saved\.stacked !== false/.test(layout),
);
check(
  "a saved split is clamped into the range the setting allows",
  /saved\.stackShare[\s\S]{0,260}STACK_SHARE\.min[\s\S]{0,80}STACK_SHARE\.max/.test(layout),
);
check(
  "and anything malformed loads as half",
  /: STACK_SHARE\.fallback;/.test(layout),
);
check(
  "both are written back with the layout, and the order beside them",
  /stacked: this\.stacked,\s*stackSwapped: this\.stackSwapped,\s*stackShare: this\.stackShare,/.test(layout),
);
check(
  "the columns are drawn with the arrangement on screen, not the stored one",
  /columns\(drawnStack = this\.stacked\): string \{\s*return gridTemplate\(this\.mode, this\.shown, \{\s*available: this\.drawn,\s*collapsed: this\.collapsed,\s*stacked: drawnStack,\s*keepWidths: this\.keepWidths,\s*\}\);/.test(
    layout,
  ),
);
check(
  "and the view hands it the stack it is actually drawing",
  /style:grid-template-columns=\{columns\}/.test(main) &&
    /const columns = \$derived\(\s*gridTemplate\(mode, layout\.shown, \{[\s\S]{0,560}?stacked: stackDrawn,/.test(main),
);
check(
  "so are the drawn widths, which stacked are not three columns' worth",
  /clampWidths\(\s*layoutWidths\(this\.panes, this\.mode\),\s*this\.mode,\s*this\.drawn,\s*this\.device,\s*this\.stacked,/.test(
    layout,
  ),
);
check(
  "the thresholds follow the arrangement",
  /neededWidth\(this\.panes, mode, this\.device, this\.stacked\)/.test(layout) &&
    /thresholdsFor\(this\.panes, this\.device, this\.panes\.sidebar, this\.stacked\)/.test(layout),
);

// One string for the rows, drawn by the one grid, so a dragged split is the same
// split in both surfaces that show it — and, stacked or not, four tracks, which
// is what lets CSS slide the split instead of snapping it.
check(
  "the rows are the share's while a stack is drawn, and flat when it is not",
  /rows\(drawnStack: boolean\): string \{\s*if \(!drawnStack\) return FLAT_ROWS;\s*return stackTemplate\(this\.stacked \? this\.stackShare : STACK_SHARE\.fallback\);/.test(
    layout,
  ),
);
check(
  "and the view draws them from the same flag as the columns",
  /style:grid-template-rows=\{layout\.rows\(stackDrawn\)\}/.test(main),
);
check(
  "one getter, so nothing can build a second rows string",
  /get stackRows\(\): string \{\s*return this\.rows\(this\.stacked\);\s*\}/.test(layout) &&
    !/return stackTemplate\(share,/.test(layout),
);
check(
  "flat rows are the same four tracks with nothing split",
  FLAT_ROWS === "0px 100% 0px 0px" && tracksOf(FLAT_ROWS).length === 4,
  FLAT_ROWS,
);
check(
  "and a split is four tracks that come to exactly the column",
  tracksOf(stackTemplate(STACK_SHARE.fallback)).length === 4 &&
    stackTemplate(0.5) === `0px 50.00% ${STACK_GUTTER}px calc(100% - 50.00% - ${STACK_GUTTER}px)`,
  stackTemplate(0.5),
);
check(
  "the share is drawn, never a remembered width, so a resize keeps the split",
  stackTemplate(0.5).includes("50.00%") && stackTemplate(0.25).includes("25.00%"),
);

// Turning it on is a choice, so it is answered at once — the band is for
// accidents — and it is not a window resize: the window belongs to the user.
check(
  "turning it on re-derives the thresholds and settles at once",
  /setStacked\(on: boolean\): void \{[\s\S]{0,260}this\.syncThresholds\(\);\s*this\.settle\(false\);/.test(layout),
);
check(
  "and resizes nothing",
  !/setStacked\(on: boolean\): void \{[\s\S]{0,400}fitWindowTo/.test(layout),
);
check(
  "nor rewrites a width: the panes keep the shape they had",
  (() => {
    const start = layout.indexOf("setStacked(on: boolean)");
    const body = layout.slice(start, layout.indexOf("\n  }", start));
    return !body.includes("this.panes =") && !body.includes("this.write(");
  })(),
);

// A drag on the seam is the same shape as a drag on a column: per-frame moves,
// one write at the end, and a reset to half.
check(
  "a share drag does not write per frame",
  (() => {
    const body = layout.slice(layout.indexOf("dragShare(share: number)"), layout.indexOf("commitShare()"));
    return /this\.stackShare = Math\.min\(Math\.max\(share, STACK_SHARE\.min\), STACK_SHARE\.max\)/.test(body) &&
      !body.includes("this.save()");
  })(),
);
check("the write happens once, on release", /commitShare\(\): void \{[\s\S]{0,120}this\.save\(\);/.test(layout));
check(
  "and a commit trims the requirement in the arrangement that is drawn",
  /commit\(\): void \{\s*this\.panes = settleRequirement\(this\.panes, this\.mode, this\.available, this\.device, this\.stacked\)/.test(
    layout,
  ),
);
check("double-click goes back to half", /resetShare\(\): void \{[\s\S]{0,120}STACK_SHARE\.fallback/.test(layout));
check("arrow keys nudge the split", /nudgeShare\(delta: number\): void \{/.test(layout));

// ---------------------------------------------------------------------------
// The toggle: in Settings, labelled by the arrangement, and reachable on a
// phone — which means outside the gate on the pixel sliders, because a phone has
// no thresholds and does draw the stack.
const sliderGate =
  '{#if layout.caps.paneThresholds}';
const gateEnd = blockEnd(panel, sliderGate);
const toggle = panel.indexOf('<span class="key">Three panes</span>');
check("the layout tab offers the arrangement", toggle > 0);
check(
  "the row is outside the threshold gate, so a phone can reach it",
  toggle > gateEnd && gateEnd > 0,
  `toggle at ${toggle}, gate closes at ${gateEnd}`,
);
check(
  "both arrangements are named and pressed",
  /class:on=\{!layout\.stacked\}[\s\S]{0,220}layout\.setStacked\(false\)[\s\S]{0,400}layout\.setStacked\(true\)/.test(
    panel,
  ),
);
check(
  "the labels are the two arrangements, not a switch",
  /setStacked\(false\)\}>Side by side<\/button>/.test(panel) &&
    /setStacked\(true\)\}>Stacked<\/button>/.test(panel),
);
check(
  "each says what it draws, in a dozen words or fewer",
  (panel.match(/title="[^"]*(?:side by side|posts above the article)[^"]*"/g) ?? []).every(
    (title) => title.split(/\s+/).length <= 14,
  ),
);

// ---------------------------------------------------------------------------
// Drawn: one grid holds the whole arrangement, and a stack is a placement in it.
check(
  "three panes draw the stack when it is on",
  /const stackDrawn = \$derived\(\s*layout\.stacked && \(mode === 3 \|\| \(mode === 1 && level === "article"\)\),\s*\)/.test(
    main,
  ) && /class:stacked=\{stackDrawn\}/.test(main),
);
check(
  "the grid carries four row tracks whether or not anything is split",
  /style:grid-template-rows=\{layout\.rows\(stackDrawn\)\}/.test(main) &&
    /grid-template-columns: minmax\(0, 1fr\) 0 0 0 0;/.test(main),
);

// The column is two panes and a seam: the top pane in row 2, the seam in row 3,
// the bottom pane in row 4, with row 1 held at nothing so the split can slide
// open and shut.
check(
  "the top pane is row 2, the seam row 3 and the bottom pane row 4",
  /\.panes\.stacked \.slot\.posts \{\s*grid-row: 2 \/ 3;/.test(main) &&
    /\.panes\.stacked \.slot\.gut-stack \{\s*grid-column: 3 \/ -1;\s*grid-row: 3 \/ 4;/.test(main) &&
    /\.panes\.stacked \.slot\.article \{\s*grid-row: 4 \/ 5;/.test(main),
);
check(
  "a swap trades those two rows and leaves the seam where it was",
  /\.panes\.stacked\.swapped \.slot\.posts \{\s*grid-row: 4 \/ 5;/.test(main) &&
    /\.panes\.stacked\.swapped \.slot\.article \{\s*grid-row: 2 \/ 3;/.test(main) &&
    !/\.panes\.stacked\.swapped \.slot\.gut-stack/.test(main),
);
check(
  "both stacked panes share the one right-hand column",
  /\.panes\.stacked \.slot\.posts,\s*\.panes\.stacked \.slot\.article \{\s*grid-column: 3 \/ -1;/.test(main),
);
check(
  "and which of them is which is paneSlots' answer, not the markup's",
  (() => {
    const posts = paneSlots({ mode: 3, level: "article", stacked: true, collapsed: false, tuck: null, swapped: false });
    const swapped = paneSlots({ mode: 3, level: "article", stacked: true, collapsed: false, tuck: null, swapped: true });
    return posts.posts && posts.article && posts.seamStack && swapped.posts && swapped.article && swapped.seamStack;
  })(),
);
check(
  "with a half tucked, the pane that stayed spans every row and the seam over it",
  /\.panes\.stacked\.tucked \.slot\.posts,\s*\.panes\.stacked\.tucked \.slot\.article,\s*\.panes\.stacked\.tucked \.slot\.gut-stack \{\s*grid-row: 1 \/ -1;/.test(
    main,
  ) &&
    /class:tucked=\{stackDrawn && layout\.stackTuck !== null\}/.test(main),
);

// Side by side is the same grid with no split in it: the panes are in their own
// column tracks and the rows are flat.
check(
  "and side by side is untouched when it is off",
  /\.slot\.posts \{\s*grid-column: 3 \/ 4;\s*grid-row: 1 \/ -1;/.test(main) &&
    /\.slot\.article \{\s*grid-column: 5 \/ 6;\s*grid-row: 1 \/ -1;/.test(main) &&
    /\.panes\.stacked \.slot\.posts,/.test(main),
);
check(
  "the stack is a grid that cannot outgrow its column",
  (() => {
    const body = ruleBody(main, ".panes") ?? "";
    return body.includes("display: grid;") && body.includes("min-height: 0;") && body.includes("overflow: hidden;");
  })(),
  (ruleBody(main, ".panes") ?? "(no .panes rule)").replace(/\s+/g, " ").trim(),
);
check(
  "and its cells may not push the other row off the top",
  (ruleBody(main, ".slot") ?? "").includes("min-height: 0;") &&
    /\.panes > :global\(\*\) \{\s*min-height: 0;/.test(main),
);
check(
  "the seam is the vertical gutter, one component",
  /axis="y"/.test(main) && /axis\?: "x" \| "y"/.test(gutter),
);
check(
  "the gutter turns its own axis, measures its column and clamps in pixels",
  /const vertical = \$derived\(axis === "y"\)/.test(gutter) &&
    /getBoundingClientRect\(\)\.height/.test(gutter) &&
    /clampShare\(startShare \+ \(y - startPos\) \/ room, track\)/.test(gutter),
);
check(
  "up and down resize a row, left and right a column",
  /const back = vertical \? "ArrowUp" : "ArrowLeft"/.test(gutter) &&
    /const onward = vertical \? "ArrowDown" : "ArrowRight"/.test(gutter),
);
check(
  "the outer switch is not gated by the pane count",
  !/\{#if layout\.caps\.paneCount\}[\s\S]{0,2000}setStacked/.test(main),
);

// The numbers themselves, pinned where they are cheap to pin.
check("the seam is 6px, like a column's", STACK_GUTTER === 6);
check("a split is clamped both ways", clampShare(0.01, 900) === STACK_SHARE.min && clampShare(0.99, 900) === STACK_SHARE.max);

// The feeds pane is the caller's, not the stack's. `stackedSlots` blanks every
// slot it does not own, and spreading that blank map over the base switched pane
// 1 off in every stacked draw — the pane vanished and left its column empty.
const stackedSlotsOf = (collapsed) =>
  paneSlots({ mode: 3, level: "feeds", stacked: true, collapsed, tuck: null, swapped: false });
check(
  "stacked keeps the feeds pane beside the pair",
  stackedSlotsOf(false).sidebar === true && stackedSlotsOf(false).seam === true,
  JSON.stringify(stackedSlotsOf(false)),
);
check(
  "and folding it still takes it away",
  stackedSlotsOf(true).sidebar === false && stackedSlotsOf(true).seam === false,
  JSON.stringify(stackedSlotsOf(true)),
);
check(
  "while the pair is drawn either way",
  ["posts", "article", "seamStack"].every(
    (k) => stackedSlotsOf(false)[k] === true && stackedSlotsOf(true)[k] === true,
  ),
);
check(
  "a single stacked column has no feeds pane to begin with",
  paneSlots({ mode: 1, level: "article", stacked: true, collapsed: false, tuck: null, swapped: false })
    .sidebar === false,
);
check(
  "and side-by-side three panes keep theirs",
  paneSlots({ mode: 3, level: "feeds", stacked: false, collapsed: false, tuck: null, swapped: false })
    .sidebar === true,
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
