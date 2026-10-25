/**
 * The three controls in the seam between the stacked panes: swap which pane is
 * on top, tuck the top one away, tuck the bottom one away.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/stack-controls.mjs
 *
 * `stacked.mjs` covers the arrangement as a saved preference and `panes.mjs`
 * the geometry. This suite is about the two other axes of that geometry — order
 * and tucking — so most of it drives the pure functions in `lib/panes.ts`
 * through the same transitions the buttons perform, and the rest reads the
 * state class and the two components for the wiring the arithmetic cannot show:
 * what is saved, what is not, what a screen reader is told, and that the drag
 * gesture is untouched.
 *
 * The panes are one mounted grid now, so the drawn column is modelled the way
 * the view draws it: `paneSlots` says which panes are showing, and
 * `stackTemplate` says where the seam is. A tuck no longer rewrites the rows —
 * the pane that stayed spans every row and the seam is drawn over it at the
 * share — which is why "the split is unchanged" is asserted as an equality
 * rather than as a return to a remembered string.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLAT_ROWS,
  STACK_GUTTER,
  STACK_SHARE,
  nextTuck,
  paneSlots,
  stackBottomPane,
  stackTemplate,
  stackTopPane,
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
const gutter = read("src/components/PaneGutter.svelte");
const main = read("src/views/Main.svelte");
const header = read("src/components/Header.svelte");
const readingControls = read("src/components/ReadingControls.svelte");

/**
 * The column as the app draws it, from the same values the seam writes.
 *
 * This is the model the checks press: the buttons only ever set `swapped` and
 * `tuck`, the drag and the arrows write `share`, and the view asks `paneSlots`
 * and `stackTemplate` what that means. Keeping the model here means a test of
 * "what a press does" is a test of the drawn result rather than of a method's
 * spelling. `mode` 3 is the desktop column; `mode` 1 is the phone, which draws
 * the same pair on its one surface.
 */
function drawn({ share = STACK_SHARE.fallback, swapped = false, tuck = null, mode = 3 } = {}) {
  const top = stackTopPane(swapped);
  const bottom = stackBottomPane(swapped);
  const slots = paneSlots({
    mode,
    level: "article",
    stacked: true,
    collapsed: false,
    tuck,
    swapped,
  });
  const shown = (pane) => (pane === "posts" ? slots.posts : slots.article);
  return {
    rows: stackTemplate(share),
    top,
    bottom,
    slots,
    panes: [top, bottom].filter((pane) => shown(pane)),
    share,
  };
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

/** One track as a percentage of the column plus a fixed number of pixels. */
function sizeOf(track) {
  const pixels = /^(-?[\d.]+)px$/.exec(track);
  if (pixels !== null) return { pct: 0, px: Number(pixels[1]) };
  const percent = /^(-?[\d.]+)%$/.exec(track);
  if (percent !== null) return { pct: Number(percent[1]), px: 0 };
  const calc = /^calc\((.*)\)$/.exec(track);
  if (calc === null) return null;
  const terms = calc[1].trim().split(/\s+/);
  const total = { pct: 0, px: 0 };
  let sign = 1;
  for (const term of terms) {
    if (term === "-") {
      sign = -1;
      continue;
    }
    if (term === "+") {
      sign = 1;
      continue;
    }
    const part = sizeOf(term);
    if (part === null) return null;
    total.pct += sign * part.pct;
    total.px += sign * part.px;
    sign = 1;
  }
  return total;
}

/** The whole template, as a percentage of the column plus a pixel remainder. */
function totalOf(rows) {
  return tracksOf(rows).reduce(
    (sum, track) => {
      const part = sizeOf(track);
      if (part === null) return { pct: Number.NaN, px: Number.NaN };
      return { pct: sum.pct + part.pct, px: sum.px + part.px };
    },
    { pct: 0, px: 0 },
  );
}

/** The share a rows string puts above the seam, as a fraction. */
function shareOf(rows) {
  const track = tracksOf(rows)[1] ?? "";
  const match = /^([\d.]+)%$/.exec(track);
  return match === null ? null : Number(match[1]) / 100;
}

/** Every share this layout can hold, at the resolution the seam writes. */
const SHARES = [];
for (let percent = Math.round(STACK_SHARE.min * 100); percent <= Math.round(STACK_SHARE.max * 100); percent += 1) {
  SHARES.push(percent / 100);
}

// ---------------------------------------------------------------------------
// Which pane is which before anything is pressed.
check("the post list is on top as shipped", stackTopPane(false) === "posts");
check("and the article is below it", stackBottomPane(false) === "article");
check("swapping puts the article on top", stackTopPane(true) === "article");
check(
  "and the post list below",
  stackBottomPane(true) === "posts",
  stackBottomPane(true),
);
check(
  "the two slots always name both panes, once each",
  new Set([stackTopPane(false), stackBottomPane(false)]).size === 2 &&
    new Set([stackTopPane(true), stackBottomPane(true)]).size === 2,
);

// ---------------------------------------------------------------------------
// The rows: four tracks — nothing above the top pane, the pane, the seam, the
// rest — so the list has the same length in every arrangement and CSS can slide
// between them instead of snapping.
const split = drawn();
check(
  "as shipped the column is nothing, half, the seam, and the rest",
  split.rows === "0px 50.00% 6px calc(100% - 50.00% - 6px)",
  split.rows,
);
check("the template is four tracks, always", tracksOf(split.rows).length === 4, String(tracksOf(split.rows).length));
check("and flat rows are the same four", tracksOf(FLAT_ROWS).length === 4, FLAT_ROWS);
check(
  "none of them is a fr or a keyword, so both can be interpolated",
  [...tracksOf(split.rows), ...tracksOf(FLAT_ROWS)].every((track) => /^-?[\d.]+(px|%)$/.test(track) || /^calc\(/.test(track)),
  [...tracksOf(split.rows), ...tracksOf(FLAT_ROWS)].join(" | "),
);
check("and the four of them are exactly the column", totalOf(split.rows).pct === 100 && totalOf(split.rows).px === 0, JSON.stringify(totalOf(split.rows)));
check(
  "the template knows only the share, so no order or tuck can invert the split",
  stackTemplate.length === 1,
  String(stackTemplate.length),
);
check("the top pane is the share of it", shareOf(split.rows) === STACK_SHARE.fallback, String(shareOf(split.rows)));
check("both panes are drawn", split.panes.length === 2, split.panes.join("+"));
check("and the seam is the same 6px it always was", tracksOf(split.rows)[2] === `${STACK_GUTTER}px`, tracksOf(split.rows)[2]);

// A swap is an order, not a re-division: the rows string is the share's alone.
{
  const sameRows = SHARES.every((share) => shareOf(stackTemplate(share)) === share);
  check(
    "the share survives a swap unchanged, at every step of the range",
    sameRows,
    SHARES.filter((share) => shareOf(stackTemplate(share)) !== share).join(","),
  );
  check(
    "and it is the column's, so the rows never name a pane",
    SHARES.every((share) => !/posts|article/.test(stackTemplate(share))),
  );
  const before = drawn({ share: 0.63 });
  const after = drawn({ share: 0.63, swapped: true });
  check("a 63/37 split stays 63/37 when the panes trade places", after.rows === before.rows, `${before.rows} vs ${after.rows}`);
  check("and the panes really did trade places", after.top === "article" && after.bottom === "posts");
  check(
    "half stays half, not a jump to the other half",
    shareOf(drawn({ share: 0.5, swapped: true }).rows) === 0.5 &&
      drawn({ share: 0.5 }).rows === drawn({ share: 0.5, swapped: true }).rows,
  );
  check("a swap draws both panes still", drawn({ swapped: true }).panes.length === 2);
  check(
    "and moves neither edge: the slots are the same two either way",
    JSON.stringify(drawn({ swapped: true }).slots) === JSON.stringify(drawn({ swapped: false }).slots),
  );
}

// ---------------------------------------------------------------------------
// A tuck press, as the button performs it.
//
// A tuck no longer rewrites the template. The pane that stayed spans every row
// and the seam is drawn over it at the share, so the split it comes back to
// stays visible while the pane is away — and the restore below is an equality,
// not a return to a remembered number.
{
  let tuck = null;
  const press = (side) => {
    tuck = nextTuck(tuck, side);
    return drawn({ tuck });
  };

  const tuckedTop = press("top");
  check(
    "tucking the top pane leaves the split where the seam will come back",
    tuckedTop.rows === split.rows,
    tuckedTop.rows,
  );
  check("so exactly one pane is drawn", tuckedTop.panes.length === 1, tuckedTop.panes.join("+"));
  check(
    "and it is the one that was below the seam",
    tuckedTop.panes[0] === "article",
    tuckedTop.panes[0],
  );
  check("while the seam is still there to be pressed", tuckedTop.slots.seamStack === true);
  check("the window and the split are untouched", tuckedTop.share === STACK_SHARE.fallback);

  const restored = press("top");
  check(
    "the same control again brings it back at the split it left",
    restored.rows === split.rows,
    restored.rows,
  );
  check("with both panes drawn again", restored.panes.length === 2);

  // The other side while one is away: that pane comes back, the other goes.
  press("top");
  const replaced = press("bottom");
  check(
    "tucking the other half restores the first rather than emptying the column",
    replaced.panes.length === 1 && replaced.panes[0] === "posts",
    replaced.panes.join("+") || "none",
  );
  check(
    "and the column keeps its four tracks, so the way back is not a re-layout",
    tracksOf(replaced.rows).length === 4 && replaced.rows === split.rows,
    replaced.rows,
  );
  const afterReplace = press("bottom");
  check("pressing that one again restores it too", afterReplace.panes.length === 2);
  check(
    "with the split still where it was",
    afterReplace.rows === split.rows,
    afterReplace.rows,
  );
}

// Every reachable tuck state, and a share that never moves through any of them.
{
  const sides = ["top", "bottom"];
  const seen = new Set();
  const walk = (tuck, depth) => {
    seen.add(tuck);
    if (depth === 0) return;
    for (const side of sides) walk(nextTuck(tuck, side), depth - 1);
  };
  walk(null, 3);
  check(
    "the reachable tuck states are three: none, top, bottom",
    seen.size === 3 && [...seen].every((tuck) => tuck === null || tuck === "top" || tuck === "bottom"),
    [...seen].join(","),
  );
  check(
    "and no sequence of presses ever leaves the column empty",
    [...seen].every((tuck) => drawn({ tuck }).panes.length >= 1),
  );
  check(
    "nor takes the seam away, which is the only way back",
    [...seen].every((tuck) => drawn({ tuck }).slots.seamStack === true),
  );
  check(
    "a tuck never rewrites the share, so a restore is a restore",
    [...seen].every((tuck) => drawn({ share: 0.42, tuck }).share === 0.42 && shareOf(drawn({ share: 0.42, tuck }).rows) === 0.42),
  );
  check(
    "and it is the same pair on the phone's one surface",
    [...seen].every((tuck) => {
      const phone = drawn({ tuck, mode: 1 });
      return JSON.stringify(phone.panes) === JSON.stringify(drawn({ tuck }).panes) && phone.rows === drawn({ tuck }).rows;
    }),
  );
}

// ---------------------------------------------------------------------------
// The state class: what a press writes, and what it deliberately does not.
check("the order is state", /stackSwapped = \$state\(false\)/.test(layout));
check("so is the tuck", /stackTuck = \$state<StackTuck>\(null\)/.test(layout));
check(
  "a swap press flips the order and saves it",
  /toggleStackSwap\(\): void \{\s*this\.stackSwapped = !this\.stackSwapped;\s*this\.save\(\);\s*\}/.test(layout),
);
check(
  "and touches nothing else — in particular not the split",
  (() => {
    const start = layout.indexOf("toggleStackSwap()");
    const body = layout.slice(start, layout.indexOf("tuckStack(side", start));
    return !body.includes("stackShare") && !body.includes("fitWindowTo") && !body.includes("stackTuck");
  })(),
);
check(
  "a tuck press goes through the one-at-a-time rule",
  /tuckStack\(side: StackSide\): void \{\s*this\.stackTuck = nextTuck\(this\.stackTuck, side\);\s*\}/.test(layout),
);
check(
  "and writes no storage: a tuck is temporary",
  (() => {
    const start = layout.indexOf("tuckStack(side");
    const body = layout.slice(start, layout.indexOf("dragShare(share", start));
    return !body.includes("this.save(") && !body.includes("fitWindowTo");
  })(),
);
check(
  "so neither control can resize the window or a column",
  (() => {
    const start = layout.indexOf("toggleStackSwap()");
    const body = layout.slice(start, layout.indexOf("dragShare(share", start));
    return !body.includes("fitWindowTo") && !body.includes("this.panes") && !body.includes("write(");
  })(),
);
check(
  "the drawn columns are the widths' alone: order and tuck cannot move a column",
  /columns\(drawnStack = this\.stacked\): string \{[\s\S]{0,300}?\n  \}/.test(layout) &&
    (() => {
      const start = layout.indexOf("columns(drawnStack = this.stacked)");
      const body = layout.slice(start, layout.indexOf("\n  }", start));
      return !body.includes("stackSwapped") && !body.includes("stackTuck") && !body.includes("stackShare");
    })(),
);
check(
  "the tuck is not in the saved payload",
  !/stackTuck: this\.stackTuck/.test(layout) && /stackSwapped: this\.stackSwapped,/.test(layout),
);
check(
  "the order is read back with the layout, and only an explicit true swaps",
  /this\.stackSwapped = saved\.stackSwapped === true;/.test(layout) &&
    !/this\.stackSwapped = saved\.stackSwapped \?\?/.test(layout),
);
check(
  "the saved shape names it beside the arrangement and the split",
  /stacked\?: boolean;[\s\S]{0,400}stackSwapped\?: boolean;[\s\S]{0,200}stackShare\?: number;/.test(layout),
);
check(
  "the drawn order and both slot names come from the one flag",
  /get stackTop\(\): StackPane \{\s*return stackTopPane\(this\.stackSwapped\);/.test(layout) &&
    /get stackBottom\(\): StackPane \{\s*return stackBottomPane\(this\.stackSwapped\);/.test(layout),
);
check(
  "the rows are the share's, and flat when no stack is drawn",
  /rows\(drawnStack: boolean\): string \{\s*if \(!drawnStack\) return FLAT_ROWS;\s*return stackTemplate\(this\.stacked \? this\.stackShare : STACK_SHARE\.fallback\);/.test(
    layout,
  ),
);
check(
  "and one getter hands the same string to anything that asks",
  /get stackRows\(\): string \{\s*return this\.rows\(this\.stacked\);\s*\}/.test(layout),
);
check(
  "a tuck that cannot be seen is dropped, not stored for later",
  /this\.stackTuck !== null && \(!this\.stacked \|\| this\.mode === 2\)\) this\.stackTuck = null;/.test(layout),
);
check(
  "and it survives on the one-pane surface, which draws the same pair",
  !/this\.mode !== 3[\)\s]*this\.stackTuck = null/.test(layout) &&
    /if \(this\.stackTuck !== null && \(!this\.stacked \|\| this\.mode === 2\)\)/.test(layout),
);

// ---------------------------------------------------------------------------
// The seam: three real buttons, beside the separator rather than inside it.
// Counted inside the stacked chip, because the feeds seam carries the fold's own
// button on the same pattern (see `collapse.mjs`).
const chipStart = gutter.indexOf('class="ctl-bar"');
const chip = chipStart < 0 ? "" : gutter.slice(chipStart, gutter.indexOf("</div>", chipStart));
const buttons = chip.match(/<button\b/g) ?? [];
check("the stacked seam carries three buttons", buttons.length === 3, String(buttons.length));
check(
  "all three are real buttons that cannot submit a form",
  (chip.match(/<button\b[\s\S]{0,120}?type="button"/g) ?? []).length === 3,
);
check(
  "each has an aria-label",
  (gutter.match(/aria-label=/g) ?? []).length >= 4 &&
    /aria-label="Swap the post list and the article"/.test(gutter) &&
    /aria-label=\{tuck === "top" \? `Show the \$\{topName\}` : `Tuck the \$\{topName\} away`\}/.test(gutter) &&
    /aria-label=\{tuck === "bottom" \? `Show the \$\{bottomName\}` : `Tuck the \$\{bottomName\} away`\}/.test(gutter),
);
check(
  "the swap says whether the order is swapped",
  /aria-pressed=\{layout\.stackSwapped\}/.test(gutter),
);
check(
  "each tuck says whether its pane is showing",
  (gutter.match(/aria-expanded=\{tuck !== "(?:top|bottom)"\}/g) ?? []).length === 2,
);
check(
  "the swap is disabled — visibly — while one pane is away",
  /disabled=\{tuck !== null\}/.test(gutter) &&
    /\.ctl-bar button:disabled \{[\s\S]{0,120}opacity: 0\.3;/.test(gutter),
);
check(
  "the disabled state explains itself rather than doing nothing quietly",
  /tuck === null\s*\?\s*`Put the \$\{bottomName\} above the \$\{topName\}`\s*:\s*"Show both panes to swap them"/.test(
    gutter,
  ),
);
check(
  "the buttons are siblings of the separator, not children of a widget role",
  (() => {
    const separator = gutter.indexOf('role="separator"');
    const group = gutter.indexOf('role="group"');
    const between = gutter.slice(separator, group);
    return separator > 0 && group > separator && !between.includes("<button");
  })(),
);
check(
  "the seam keeps its separator semantics and its keys",
  /role="separator"/.test(gutter) &&
    /aria-valuenow=\{vertical \? percent : layout\.width\(which\)\}/.test(gutter) &&
    /const back = vertical \? "ArrowUp" : "ArrowLeft"/.test(gutter),
);
check(
  "a press cannot start a drag: the chip passes pointer events through",
  /\.ctl-bar \{[\s\S]{0,400}pointer-events: none;/.test(gutter) &&
    /\.ctl-bar button \{[\s\S]{0,400}pointer-events: auto;/.test(gutter),
);
check(
  "the drag still measures the whole column through the seam's wrapper",
  /closest<HTMLElement>\("\.seam"\)\?\.parentElement/.test(gutter) &&
    /getBoundingClientRect\(\)\.height/.test(gutter),
);
check(
  "with a pane tucked the seam is drawn over the one that stayed, at the split",
  /const overlaid = \$derived\(vertical && layout\.stacked && tuck !== null\)/.test(gutter) &&
    /\.seam\.overlaid \{[\s\S]{0,160}position: absolute;[\s\S]{0,80}height: 6px;/.test(gutter) &&
    /style:top=\{overlaid \? offset : undefined\}/.test(gutter) &&
    /calc\(\$\{\(layout\.stackShare \* 100\)\.toFixed\(2\)\}% - \$\{STACK_GUTTER \/ 2\}px\)/.test(gutter),
);
check(
  "and its aria text names what is away, not only the percentage",
  /`\$\{percent\}% \$\{topName\}\$\{tuck === null \? "" : `, \$\{tuckedName\} tucked away`\}`/.test(gutter),
);

// ---------------------------------------------------------------------------
// One grid draws the stack, for the column and for the phone: the same pair,
// the same seam, the same rows — a phone is not a different behaviour with the
// same name.
{
  check(
    "one derived flag says when the pair is on screen, in either mode",
    /const stackDrawn = \$derived\(\s*layout\.stacked && \(mode === 3 \|\| \(mode === 1 && level === "article"\)\),\s*\)/.test(
      main,
    ),
  );
  const slotsCall =
    /const slots = \$derived\.by\(\(\) => \{\s*const drawn = paneSlots\(\{[\s\S]{0,300}?\}\);/.exec(main);
  check(
    "and which panes that draws comes from paneSlots, not from branches in the markup",
    slotsCall !== null && /tuck: layout\.stackTuck,/.test(slotsCall[0]) && /swapped: layout\.stackSwapped,/.test(slotsCall[0]),
    slotsCall === null ? "no call" : slotsCall[0].replace(/\s+/g, " "),
  );
  check(
    "not drawn is hidden, never removed",
    /\.slot\.away \{\s*visibility: hidden;/.test(main) && !/\{#if slots\./.test(main),
  );
  check(
    // One ReaderPane, one ArticleList, each in its own slot: a post read in the
    // list grows inside the list, so there is no second article drawn anywhere.
    "each pane is mounted once, in its own slot, whatever the mode",
    (main.match(/<ArticleList \/>/g) ?? []).length === 1 &&
      (main.match(/<ReaderPane /g) ?? []).length === 1 &&
      /class="slot posts" class:away=\{!slots\.posts\}/.test(main) &&
      /class="slot article" class:away=\{!slots\.article\}/.test(main),
  );
  check(
    "the article keeps its own handler for the walk and its close for the panes",
    /<ReaderPane onClose=\{closeArticle\} onLock=\{mode === 1 \? lockFromArticle : undefined\} \/>/.test(main),
  );
  check(
    "the seam is one component on the one grid",
    (main.match(/<PaneGutter axis="y" \/>/g) ?? []).length === 1,
    String((main.match(/<PaneGutter axis="y" \/>/g) ?? []).length),
  );
  check(
    "and its slot is the slot the tuck keeps, at every tuck",
    /class="slot seam-y gut-stack" class:away=\{!slots\.seamStack\}/.test(main) &&
      paneSlots({ mode: 3, level: "article", stacked: true, collapsed: false, tuck: null, swapped: false }).seamStack ===
        paneSlots({ mode: 3, level: "article", stacked: true, collapsed: false, tuck: "top", swapped: false }).seamStack,
  );
  check(
    "the grid is the containing block the overlaid seam is measured against",
    /\.panes \{[\s\S]{0,120}position: relative;/.test(main) &&
      /\.panes\.stacked\.tucked \.slot\.posts,\s*\.panes\.stacked\.tucked \.slot\.article,\s*\.panes\.stacked\.tucked \.slot\.gut-stack \{\s*grid-row: 1 \/ -1;/.test(
        main,
      ),
  );
}


// A tucked pane must be findable. The three-glyph chip is fine while both panes
// are there — the controls live where the seam is and the seam is between two
// things — but the moment one is away the only job left is putting it back, and
// the way back belongs on the edge that pane left, as a tab: the middle of the
// column belongs to the page being read.
check(
  "the chip's three glyphs are only drawn while both panes are there",
  /\{#if tuck === null\}\s*<div class="ctl-bar"/.test(gutter),
);
check(
  "a tucked pane is offered back by a tab on the edge it left",
  /class="restore-bar"\s*class:from-bottom=\{tuck === "bottom"\}/.test(gutter) &&
    /aria-label=\{`Show the \$\{tuckedName\}`\}/.test(gutter) &&
    /title=\{`Show the \$\{tuckedName\}`\}/.test(gutter) &&
    /onclick=\{showTucked\}/.test(gutter) &&
    // The name is in the label and the tooltip, not in the tab: a chevron with a
    // sentence beside it is the pill this replaced.
    !/<span>Show the \{tuckedName\}<\/span>/.test(gutter),
);
check(
  "the tab hangs off the top edge, and off the bottom when that is the pane away",
  /\.restore-bar \{[\s\S]{0,200}?top: 0;/.test(gutter) &&
    /\.restore-bar\.from-bottom \{[\s\S]{0,120}?bottom: 0;/.test(gutter) &&
    /\.restore-bar button \{[\s\S]{0,400}?border-radius: 0 0 10px 10px;/.test(gutter) &&
    /\.restore-bar\.from-bottom button \{[\s\S]{0,200}?border-radius: 10px 10px 0 0;/.test(gutter),
);
check(
  "and the press is the tuck's own toggle, on the side that is away",
  /function showTucked\(\): void \{\s*if \(tuck !== null\) layout\.tuckStack\(tuck\);/.test(gutter) &&
    nextTuck("top", "top") === null &&
    nextTuck("bottom", "bottom") === null &&
    nextTuck(null, "top") === "top",
);
check(
  // The chevron points the way the pane will move: down from the top tab, up
  // from the bottom one, like the drawer it is pulling open.
  "the chevron points into the space the pane will fill",
  /\{#if tuck === "top"\}\s*<path d="M3\.6 6\.4 8 10\.8l4\.4-4\.4"/.test(gutter) &&
    /\{:else\}\s*<path d="M3\.6 9\.6 8 5\.2l4\.4 4\.4"/.test(gutter),
);
check(
  "the tab is a target of its own, and the seam it sits on still drags",
  /\.restore-bar button \{[\s\S]{0,300}?width: 36px;\s*height: 22px;/.test(gutter) &&
    /\.restore-bar \{[\s\S]{0,400}pointer-events: none;/.test(gutter) &&
    /\.restore-bar button \{[\s\S]{0,700}pointer-events: auto;/.test(gutter),
);

/* Reading a post inside the posts column does not rearrange the frame: the row
   grows where it stands, so no mode, tuck or arrangement moves a track for it. */
check(
  "reading in the list never redraws the grid",
  !/\.slot\.posts\.reading/.test(main) &&
    !/class:reading=/.test(main) &&
    /if \(readInline && drawn\.article && !drawn\.posts\)/.test(main),
);

/* The option is about reading in the list instead of in the column beside it, so
   it is offered where that column is the only alternative: two plain panes. Three
   panes have an article column of their own, and one pane is a walk. */
check(
  "the read-here option is offered in two plain panes, and nowhere else",
  /\{#if layout\.mode === 2 && !layout\.sidebarCollapsed\}[\s\S]{0,320}?aria-label="Read posts here in the list"/.test(
    read("src/components/ArticleList.svelte"),
  ) &&
    /const readInline = \$derived\(\s*reading\.readInPane && reading\.listView === "regular" && mode === 2 && !folded,\s*\);/.test(
      main,
    ) &&
    /class:away=\{!slots\.posts\}/.test(main),
);

/* The bar's A− and A+ belong to whichever column is open. With no article drawn
   they are the list's buttons; the panel still names both sizes on their own. */
check(
  "the bar's size buttons follow the column that is open",
  /textTarget=\{articleShown \? "article" : "list"\}/.test(main) &&
    /const articleShown = \$derived\(\s*Boolean\(slots\.article\) \|\| \(readInline && reader\.selectedId !== null\) \|\| level === "article",\s*\);/.test(
      main,
    ) &&
    /<ReadingControls[\s\S]{0,160}?target=\{textTarget\}/.test(header) &&
    /let \{ target = "article", onopen \}: \{ target\?: "article" \| "list"; onopen\?: \(\) => void \} = \$props\(\);/.test(
      readingControls,
    ) &&
    /if \(onList\) reading\.stepRowScale\(direction\);\s*else reading\.stepTextScale\(direction\);/.test(
      readingControls,
    ),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
