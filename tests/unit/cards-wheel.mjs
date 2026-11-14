/**
 * The cards wheel: a page scrolls, a card turns.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/cards-wheel.mjs
 *
 * A card is as tall as the comic it carries — a page and a half of a laptop
 * pane — and the wheel used to turn one over per notch. That made the middle of
 * every comic unreachable by wheel: the notch teleported 1,800px down the
 * column, so the reader saw the top of one page, then the top of the next.
 *
 * The rule pinned here is the article pane's, applied to cards:
 *
 * 1. A card taller than the pane is scrolled by the wheel. The notch is only
 *    the column's until the card has no more to give in that direction, and
 *    until then nothing is `preventDefault`ed and no step is taken.
 * 2. Past that edge the notch becomes the same pull the article pane uses:
 *    `accumulate`/`shouldAdvance` against `thresholdFor(reading.scrollEffort)`,
 *    drawn by the same filling line, and it buys exactly one card.
 * 3. A card that fits is still one notch, one card, centred — and the tail of
 *    one push never coasts into a second.
 *
 * No browser and no server: the component and the pane are read as source, and
 * the order of the branches is part of what is checked, because "the column
 * gets the notch" is exactly an order-of-operations promise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** The body of a top-level `function name(...)` in a component, by brace count. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, at + 1);
    }
  }
  return source.slice(open);
}

const articleList = read("src/components/ArticleList.svelte");
const readerPane = read("src/components/ReaderPane.svelte");
const wheel = functionBody(articleList, "onListWheel");

check("the wheel handler exists", wheel.length > 0);

// 1. A tall card is scrolled, not turned: the branch is tested before anything
//    is refused, so the browser gets the notch.
check("the wheel asks whether the card is taller than the pane", /!cardFits\(row\)/.test(wheel));
check("the test is the card in the middle", /const row = currentCard\(\)/.test(wheel));
const noEdge = wheel.indexOf("if (!pastEdge)");
const refuse = wheel.indexOf("event.preventDefault()");
check(
  "a notch inside a page is never refused",
  noEdge !== -1 && refuse !== -1 && noEdge < refuse,
  `pastEdge at ${noEdge}, preventDefault at ${refuse}`,
);
check(
  "the edge is the card's own, in the direction of travel",
  /direction > 0 \? box\.bottom <= port\.bottom \+ 2 : box\.top >= port\.top - 2/.test(wheel),
);

// 2. Past the edge it is the article pane's pull, not a second scheme.
check(
  "the pull is the article pane's accumulator",
  /accumulate\(listPull, event\.deltaY, listThreshold\)/.test(wheel) &&
    /accumulate\(pull, event\.deltaY, threshold\)/.test(readerPane),
);
check(
  "the turn is the article pane's threshold",
  /shouldAdvance\(listPull, listThreshold\)/.test(wheel) &&
    /shouldAdvance\(pull, threshold\)/.test(readerPane),
);
check(
  "both read the same effort setting",
  /thresholdFor\(reading\.scrollEffort\)/.test(articleList) &&
    /thresholdFor\(reading\.scrollEffort\)/.test(readerPane),
);
check(
  "a pull left half-made is given back",
  /listPullTimer = setTimeout\(resetListPull, 700\)/.test(wheel),
);
check(
  "the pull buys exactly one card, through the one placement",
  /stepCard\(direction\)/.test(wheel) && /landOn\(target\)/.test(functionBody(articleList, "stepCard")),
);
check(
  "the pull is drawn by a line that fills with progress",
  /class="card-pull"/.test(articleList) &&
    /progressOf\(listPull, listThreshold\)/.test(articleList) &&
    /\.card-pull\b/.test(articleList),
);

// 3. A card that fits keeps the notch: one push, one card, never two.
check(
  "a fitted card is still refused so the step is the only movement",
  /event\.preventDefault\(\);\s*\n\s*if \(listStepSpent\)/.test(wheel),
);
check(
  "one push spends one step, and a slow scroll is told apart from it",
  /isNewGesture\(now, listWheelAt, tall \? GESTURE_GAP_MS : LIST_GESTURE_GAP_MS\)/.test(wheel) &&
    /listStepSpent = true/.test(wheel),
);
check(
  "the fitting card keeps the wheel's one meaning",
  /view !== "cards" \|\| !reading\.advanceOnScroll/.test(wheel),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;