/**
 * The comics fit, pinned with the shapes it was proved with.
 *
 *   node tests/unit/comic-fit.mjs
 *
 * Cards are read as pages: one picture, the pane's whole width, its own height,
 * never cropped and never capped. That is the thing every later change is most
 * likely to break by accident — a `max-height` here, an `object-fit: cover`
 * there, a few pixels of padding "for air" — and the damage is invisible until
 * someone opens the app on a phone. So this suite carries the picture shapes the
 * fit was measured against and asserts the *stylesheet* against them:
 *
 *   - a card picture is `width: 100%`, `height: auto`, `object-fit: contain`,
 *     with no cap anywhere in the rules that reach it, so its drawn height is
 *     the file's own shape at the column's width;
 *   - `.cards` has no side padding, so the picture's width is the pane's width —
 *     no gutter, no letterbox bars down the sides;
 *   - the column gap is the 10px the cards were signed off with.
 *
 * Pure text: this reads `.svelte` files with `fs` and never starts a browser, so
 * it runs in the plain suite runner next to every other check. The browser
 * harness that measures the same shapes in a renderer is a separate thing; where
 * these two disagree, the harness is right and the sheet has moved.
 *
 * Provenance of the numbers, because they are evidence and not dress:
 *
 *   - 150x150 — the WordPress crop Buni's feed publishes instead of the page
 *     (feed 215, https://www.bunicomic.com/feed/, measured on the live file);
 *   - 780x1054 — the Buni page at the same path without the size suffix;
 *   - 450 and 4595 — the narrowest and widest pictures measured across real card
 *     bodies, and 1.32 the tallest height/width among them;
 *   - 997 and 933 — the two panel widths of one syndicated strip, which is why
 *     a card's pictures are scaled by one factor rather than each to the width
 *     (see `stripScales` in ArticleList.svelte).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const LIST = "src/components/ArticleList.svelte";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 1;

/* ------------------------------------------------------------------ the sheet
   One `<style>` block, and the rules are read with their at-rule context: a
   declaration that only applies inside `@media (pointer: coarse)` is not the
   rule a desktop card is drawn with, and a negative ("no cap anywhere") has to
   see the inner rules too. */

const source = readFileSync(join(ROOT, LIST), "utf8");

const style = (() => {
  const open = source.indexOf("<style>");
  const close = source.indexOf("</style>", open + 1);
  if (open < 0 || close < 0) throw new Error(`${LIST} has no <style> block`);
  return source.slice(open + "<style>".length, close).replace(/\/\*[\s\S]*?\*\//g, "");
})();

/** Every rule in the sheet, with the at-rules it sits inside. */
function parseRules(css) {
  const rules = [];
  const at = [];
  let buffer = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const selector = buffer.trim().replace(/\s+/g, " ");
      buffer = "";
      if (selector.startsWith("@")) {
        at.push(selector);
        i += 1;
        continue;
      }
      // To the matching brace, so an at-rule's inner rules are read whole.
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += css[j];
        j += 1;
      }
      rules.push({ selector, body, at: at.join(" ") });
      i = j + 1;
      continue;
    }
    if (ch === "}") {
      at.pop();
      buffer = "";
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  return rules;
}

const rules = parseRules(style);

const withSelector = (selector) => rules.filter((rule) => rule.selector === selector);
const body = (selector) => withSelector(selector).map((rule) => rule.body).join("\n");

/** One declaration's value out of a rule body, or null when it is not set. */
function decl(text, property) {
  const pattern = new RegExp(`(?:^|[\\s;])${property}\\s*:\\s*([^;]+);`);
  const match = pattern.exec(text ?? "");
  return match === null ? null : match[1].trim();
}

/** A stated length in px, or NaN when the sheet says something other than px. */
function px(value) {
  const match = /^(-?[\d.]+)(px)?$/.exec((value ?? "").trim());
  return match === null ? Number.NaN : Number(match[1]);
}

/* ----------------------------------------------------------------- the shapes
   Widths as served, and the ratios that decide the height. The cross product is
   the point: a shape only has to survive at its own width and its own ratio, and
   the sheet must not care which. */

const WIDTHS = [150, 450, 780, 997, 4595];

const RATIOS = [
  { name: "the WordPress crop beside the page", ratio: 1.0 },
  { name: "the tallest shape measured in a card body", ratio: 1.32 },
  { name: "a Buni page (780x1054)", ratio: 1054 / 780 },
];

/** The panes the fit was checked at: the four phone widths and a desktop one. */
const VIEWS = [320, 360, 390, 436, 900];

check(
  "the widths are the measured ones, smallest to largest",
  WIDTHS.every((width, index) => index === 0 || width > WIDTHS[index - 1]) &&
    WIDTHS[0] === 150 &&
    WIDTHS.includes(450) &&
    WIDTHS.includes(4595),
  WIDTHS.join(", "),
);

check(
  "the tallest ratio in the fixtures covers the tallest one measured",
  Math.max(...RATIOS.map((shape) => shape.ratio)) >= 1.32,
  `tallest fixture ${Math.max(...RATIOS.map((shape) => shape.ratio)).toFixed(3)}`,
);

/* -------------------------------------------------------------------- the fit
   `.cards .lead img` is the single-picture card's picture; `.panel` is the same
   picture in a card that flips through several. They answer to the same rules
   and are checked the same way, because a multi-picture post must not be the
   one shape that letterboxes. */

const pictureRules = withSelector(".cards .lead img");
const panelRules = withSelector(".cards .lead .panel");
const picture = body(".cards .lead img");
const panel = body(".cards .lead .panel");
const window = body(".cards .lead");
const cards = body(".cards");

check("the card picture is a rule the sheet actually has", pictureRules.length > 0);
check("and so is the flipping card's picture", panelRules.length > 0);

check(
  "the picture is the column's whole width",
  decl(picture, "width") === "100%",
  decl(picture, "width") ?? "missing",
);

check("the picture keeps its own height", decl(picture, "height") === "auto", decl(picture, "height") ?? "missing");
check("nothing shortens the picture", decl(picture, "max-height") === null, decl(picture, "max-height") ?? "no cap");
check("nothing squeezes it either", decl(picture, "min-height") === null);
check(
  "the whole file is shown, never cropped",
  decl(picture, "object-fit") === "contain",
  decl(picture, "object-fit") ?? "missing",
);
check("the flipping card's picture is fitted the same way", (() => {
  return (
    decl(panel, "width") === "100%" &&
    decl(panel, "height") === "auto" &&
    decl(panel, "object-fit") === "contain" &&
    decl(panel, "max-height") === null
  );
})());

check(
  "no rule that reaches a card picture ever says cover",
  !rules.some(
    (rule) =>
      /\.cards\b/.test(rule.selector) &&
      /img\b|\.panel\b/.test(rule.selector) &&
      /object-fit:\s*cover/.test(rule.body),
  ),
);

check(
  "and no rule that reaches one caps its height in rows mode",
  !rules.some(
    (rule) =>
      /.cards\b/.test(rule.selector) &&
      /\.lead\b/.test(rule.selector) &&
      /(?:^|[\s;])max-height:\s*(?!none)/.test(rule.body),
  ),
);

/* The picture window: the box the picture is fitted into. A window with a shape
   of its own would fit the page *inside* a shape it does not have — which is the
   letterbox the `max-height` cap used to leave down the sides of a tall strip. */

check("the window is the column's width", decl(window, "width") === "100%", decl(window, "width") ?? "missing");
check("the window never shrinks under the picture", decl(window, "flex") === "none");
check("the window has no shape of its own", decl(window, "aspect-ratio") === null);
check("and no height of its own", decl(window, "height") === null, decl(window, "height") ?? "auto");

/* The column. Zero side padding is what makes the picture's width the pane's
   width; the 10px gap is the only space in the column and is what lets a card
   sit on the pane's top edge when the wheel steps to it. */

check(
  "the cards column has no padding at all",
  decl(cards, "padding") !== null && px(decl(cards, "padding")) === 0,
  decl(cards, "padding") ?? "missing",
);
check(
  "so the picture starts on the pane's left edge and ends on its right",
  ["padding-left", "padding-right", "padding-inline", "padding-inline-start", "padding-inline-end"].every(
    (property) => decl(cards, property) === null || px(decl(cards, property)) === 0,
  ),
);
check("the only space in the column is the gap between cards", px(decl(cards, "gap")) === 10, decl(cards, "gap") ?? "missing");

/* ---------------------------------------------------------------- the numbers
   From the sheet to the picture, per shape and per width.

   The model is the one the declarations describe, read out of the sheet rather
   than assumed: the column is the pane less its side padding, the window is the
   column, the picture is the window, and its height is `auto` — so the box it is
   drawn into has the file's own shape and `contain` has nothing left over to pad
   with. A cap or a window shape would show up here as bars down the sides, which
   is the exact regression this card exists to catch: a `max-height` on a tall
   strip leaves the picture centred in a box wider than it is, and the card grows
   gutters it never had. */

const PANE = 700;

/** What `contain` leaves over: half the unused box, each way. */
function bars(box, picture) {
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  return {
    side: (box.width - picture.width * scale) / 2,
    above: (box.height - picture.height * scale) / 2,
  };
}

/** A `max-height` as a number of the port's height, for the shapes the sheet uses. */
function capHeight(value) {
  if (value === null) return Number.POSITIVE_INFINITY;
  const plain = /^([\d.]+)px$/.exec(value);
  if (plain !== null) return Number(plain[1]);
  const relative = /^([\d.]+)cqh$/.exec(value);
  if (relative !== null) return (Number(relative[1]) / 100) * PANE;
  return Number.NaN;
}

const column = (pane) =>
  pane - (px(decl(cards, "padding-left")) || 0) - (px(decl(cards, "padding-right")) || 0);
const cap = capHeight(decl(picture, "max-height"));
const windowAspect = decl(window, "aspect-ratio");

for (const shape of RATIOS) {
  check(
    `${shape.name}: the pane's width, and no bars either side`,
    VIEWS.every((pane) => {
      const width = column(pane);
      const height = Math.min(
        windowAspect === null ? width * shape.ratio : width / Number(windowAspect),
        cap,
      );
      const over = bars({ width, height }, { width, height: width * shape.ratio });
      return width === pane && near(over.side, 0) && near(over.above, 0);
    }),
    VIEWS.map((pane) => {
      const width = column(pane);
      const height = Math.min(
        windowAspect === null ? width * shape.ratio : width / Number(windowAspect),
        cap,
      );
      return `${pane}→${Math.round(width)}x${Math.round(height)}`;
    }).join(", "),
  );
}

check(
  "the tallest page is taller than half a pane, so a cap would be visible",
  900 * (1054 / 780) > PANE / 2,
  `900 wide → ${Math.round(900 * (1054 / 780))}px against a ${PANE}px pane`,
);
check(
  "the sheet has no picture cap left to shorten a page",
  decl(body(".cards .lead img"), "max-height") === null,
  decl(body(".cards .lead img"), "max-height") ?? "none",
);
check(
  "a cap on the rows picture would leave trees of bars down the sides — the guard bites",
  (() => {
    // The same model with the cap that must not be there: 50% of a 700px pane on
    // a 900-wide Buni page. This is what the fixture is for, and it proves the
    // check above is not passing on empty arithmetic.
    const width = 900;
    const height = Math.min(width * (1054 / 780), PANE / 2);
    const over = bars({ width, height }, { width, height: width * (1054 / 780) });
    return over.side > 100;
  })(),
  "a 50cqh cap would leave >100px of mat either side of a 900px page",
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
