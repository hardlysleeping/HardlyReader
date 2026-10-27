/**
 * Cards are one per row, and the fit is a press.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/cards-one-per-row.mjs
 *
 * Two things are pinned here, both about the Cards view:
 *
 * 1. There is one card per row and nothing to choose. Cards once offered a
 *    Pinterest arrangement — a masonry button and a 2/3/4 column count — with a
 *    store, a storage key and a namespace of its own. The option is gone: the
 *    column CSS, the pick in the bar, the model behind it and the preference it
 *    travelled in. A single row is the shape, and the checks below say so by
 *    looking for what must not be there.
 * 2. The fit is a press, and the arithmetic behind it. A lit fit had to answer
 *    whenever the stream moved under it, and every answer was a window resize
 *    the reader did not ask for; a press measures the card in the middle once,
 *    against the picture's share of the pane, and nothing watches the stream.
 *
 * No browser and no server: the markup, the sheet and the modules are read as
 * source, and the arithmetic is read out of the function that does it.
 */
import { existsSync, readFileSync } from "node:fs";
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

const list = read("src/components/ArticleList.svelte");
const shapes = read("src/lib/list-view.ts");

// ------------------------------------------------- one card per row, always --

check(
  "the cards are a column, one per row",
  /\.cards \{[\s\S]{0,200}?display: flex;[\s\S]{0,80}?flex-direction: column;/.test(list),
);

check(
  "no rule lays the cards out in columns",
  !/^\s*columns:/m.test(list) && !/column-gap:/.test(list) && !/break-inside:/.test(list) && !/column-span:/.test(list),
);

check("no masonry class survives in the list", !/masonry/i.test(list), list.match(/masonry/i)?.[0] ?? "");
check("and no card-layout state is read by it", !/cardLayout/.test(list));

check(
  "the model offers no arrangement to pick",
  !/masonry|CARD_LAYOUT|MASONRY/i.test(shapes),
  shapes.match(/masonry|CARD_LAYOUT|MASONRY/i)?.[0] ?? "",
);

check("the card layout module is gone", !existsSync(join(ROOT, "src/lib/card-layout.svelte.ts")));
check("its storage rules went with it", !existsSync(join(ROOT, "src/lib/card-prefs.ts")));
check(
  "and the preferences carry no namespace for it",
  !/["']cards["']/.test(read("src/lib/prefs-sync.ts")),
);

// The cards' branch: no second card per row, and the fit is the only control.
const cardsBranch = list.slice(
  list.indexOf('{:else if view === "cards"}'),
  list.indexOf('<div class="filters"'),
);
check("the cards branch exists", cardsBranch.length > 0);
check("no column count is offered there", !/\d+ columns|MASONRY|Masonry/.test(cardsBranch));
check("the fit is offered there, as a press", /class="sizebtn fit"/.test(cardsBranch) && !/aria-pressed/.test(cardsBranch));
check(
  "and the sizer exists only where a window can be sized",
  /\{#if canFitWindow\(\)\}[\s\S]{0,400}?class="sizer"/.test(cardsBranch),
);

// ------------------------------------------------------------ the fit press --

// The feeds pane's width is subtracted and never asked for, the picture's own
// pixels are a ceiling, and the monitor's room is the other.
check(
  "fit to comic is a press: cards only, own width kept out of it, screen a ceiling",
  (() => {
    const fn = list.slice(list.indexOf("async function fitToComic"), list.indexOf("function syncSnap"));
    const btn = list.slice(list.indexOf('class="sizebtn fit"'), list.indexOf("</button>", list.indexOf('class="sizebtn fit"')));
    return (
      /\{#if canFitWindow\(\)\}[\s\S]{0,400}?<div class="sizer" role="group" aria-label="Cards">[\s\S]{0,200}?class="sizebtn fit"/.test(list) &&
      /import \{ canFitWindow, fitWindowTo, screenSize \} from "\.\.\/lib\/window-fit";/.test(list) &&
      /onclick=\{\(\) => void fitToComic\(\)\}/.test(btn) &&
      // a press, not a lit mode: nothing to leave switched on
      !/aria-pressed/.test(btn) &&
      !/class:on/.test(btn) &&
      /const pane1 = feeds \? Math\.round\(feeds\.getBoundingClientRect\(\)\.width\) : 0;/.test(fn) &&
      // The room the page needs, capped by its own pixels and the monitor.
      /const room = Math\.min\(availH \* natural, img\.naturalWidth \/ share, availW\);/.test(fn) &&
      /const paneNext = Math\.round\(Math\.min\(room, availW\)\);/.test(fn) &&
      /async function fitToComic\(\): Promise<void>/.test(fn) &&
      /await fitWindowTo\(pane1 \+ rest \+ paneNext, height\);/.test(fn) &&
      /if \(fitting \|\| view !== "cards"\) return;/.test(fn)
    );
  })(),
);

// A resize is the one thing that moves every card at once: the port is watched
// and the card being read is put back where it was. The window is not touched.
check(
  "a resize puts the card being read back where it was, and asks the snap again",
  (() => {
    const settle = list.slice(list.indexOf("function settleResize"), list.indexOf("function cardResize"));
    const watch = list.slice(list.indexOf("function cardResize"), list.indexOf("$effect(() => {", list.indexOf("function cardResize")));
    return (
      /use:cardResize/.test(list) &&
      /new ResizeObserver\(\(\) => \{/.test(watch) &&
      /observer\.observe\(el\);/.test(watch) &&
      /seen = \{ w, h \};\s*settleResize\(\);/.test(watch) &&
      // the reading place inside a page taller than the pane is a fraction of
      // it, not a number of pixels down the column
      /let heldFrac = 0;/.test(list) &&
      /heldFrac = Math\.min\(Math\.max\(\(port\.top - box\.top\) \/ Math\.max\(box\.height, 1\), 0\), 1\)/.test(list) &&
      /el\.scrollTop = box\.top - port\.top \+ el\.scrollTop \+ heldFrac \* box\.height;/.test(settle) &&
      /if \(cardFits\(card\)\) \{\s*landOn\(card\);/.test(settle) &&
      /\}\s*syncSnap\(\);\s*\}\);/.test(settle)
    );
  })(),
);

check(
  "and nothing but a press moves the window: no fit hides in a resize or a scroll",
  (() => {
    const watch = list.slice(list.indexOf("function cardResize"), list.indexOf("$effect(() => {", list.indexOf("function cardResize")));
    const settle = list.slice(list.indexOf("function settleResize"), list.indexOf("function cardResize"));
    const sync = list.slice(list.indexOf("function syncSnap"), list.indexOf("function onCardsScroll"));
    return (
      // the splitter changes the port but never the window
      !/fitToComic/.test(settle) &&
      // a scrolled card changes what is read there, not how big the window is
      !/fitToComic/.test(sync) &&
      // and a window resize is the reader's own hand: it is left alone
      !/fitToComic|addEventListener\("resize"/.test(watch) &&
      /observer\.observe\(el\);/.test(watch)
    );
  })(),
);

// A post that carries several pictures draws one panel at a time, each narrower
// than the pane so the pages share one zoom. A fit that sized the window to a
// panel's own pixels without knowing that asked for a window wider than the
// panel needed, and the picture did not change size at all.
check(
  "fit knows how much of the pane the picture is drawn across",
  (() => {
    const ask = list.slice(list.indexOf("async function fitToComic"), list.indexOf("function syncSnap"));
    return (
      /const share = Math\.min\(\s*1,\s*Math\.max\(0\.1, img\.getBoundingClientRect\(\)\.width \/ Math\.max\(1, pane2\)\),\s*\);/.test(ask) &&
      /img\.naturalWidth \/ share/.test(ask) &&
      /const pictureH = Math\.round\(\(paneNext \* share\) \/ natural\);/.test(ask) &&
      // one picture is the whole width, so the single-page case is unchanged
      !/const room = Math\.min\(availH \* natural, img\.naturalWidth, availW\)/.test(ask)
    );
  })(),
);

// A lit fit had to decide what to do when the stream moved under it, and every
// answer was a window resize the reader did not ask for. As a press there is no
// such question: one press, one measured answer, and nothing else moves the
// window.
check(
  "the fit is a press, so nothing refits behind the reader's back",
  (() => {
    const fn = list.slice(list.indexOf("async function fitToComic"), list.indexOf("function syncSnap"));
    return (
      // no mode to be lit, and none to consult before acting
      !/fitComic|fittedCards|fitStamps|fitAsked|toggleFitComic/.test(list) &&
      // the picture's shape is still waited for, once
      /img\.addEventListener\("load", \(\) => void fitToComic\(\), \{ once: true \}\)/.test(fn) &&
      // and a press is measured against the pane it is in, not kept as state
      /const pane2 = el\.clientWidth;/.test(fn)
    );
  })(),
);

// Asking for a window shorter than the shell's own floor gets clamped, and a
// clamp is a size the fit did not ask for — which it then asks for again. The
// floor the fit uses is the one in tauri.conf.json, read from there so the two
// cannot drift apart.
check(
  "and a fit never asks for a window shorter than the one the shell allows",
  (() => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    const min = conf.app?.windows?.[0]?.minHeight;
    const declared = Number(/const FIT_FLOOR_H = (\d+);/.exec(list)?.[1]);
    return (
      Number.isFinite(min) &&
      declared === min &&
      /const height = Math\.min\(\s*screen\.height,\s*Math\.max\(FIT_FLOOR_H, chrome \+ pictureH \+ 2 \* CARD_PEEK\),\s*\);/.test(list) &&
      // the height asked for is the page's, not whatever the window happens to
      // be: a fit that kept the current height could not fit a short strip
      (() => {
        const at = list.indexOf("const height = Math.min(");
        const line = list.slice(at, list.indexOf(";", at));
        return !/innerHeight/.test(line) && !/\b240\b/.test(line);
      })()
    );
  })(),
);

// ------------------------------------------------- the pull, on a tall card --

// One card per row makes a comic taller than the pane the normal case, and there
// the wheel used to belong to the scroll in both directions and nothing else: no
// pull, no filling line, no step. The article pane has always turned a pull at
// the bottom of a document; the card column now does the same at the end of a
// card, so the gesture and its effort setting are reachable on the cards that
// are actually read.
check(
  "a card taller than the pane pulls once its end has run out",
  (() => {
    const at = list.indexOf("function atCardEnd");
    const fn = list.slice(at, at + 700);
    const wheel = list.slice(list.indexOf("function onListWheel"), list.indexOf("function onListWheel") + 2200);
    return (
      /card\.bottom <= port\.bottom \+ 2/.test(fn) &&
      /card\.top >= port\.top - 2/.test(fn) &&
      // the wheel asks for the card's end before giving up on the gesture
      /!cardFits\(row\) && !atCardEnd\(row, towards\)/.test(wheel) &&
      // and the direction the pull was heading is what steps
      /const away = listPull > 0 \? 1 : -1;/.test(wheel) &&
      /stepCard\(away\)/.test(wheel)
    );
  })(),
);

check(
  "and a card that fits still steps without the end test",
  (() => {
    const wheel = list.slice(list.indexOf("function onListWheel"), list.indexOf("function onListWheel") + 2000);
    return /const towards = event\.deltaY > 0 \? 1 : -1;/.test(wheel) && /cardFits\(row\)/.test(wheel);
  })(),
);

// ------------------------------------------------------ the whole card fits --

// A window sized to the picture alone leaves the card's own furniture — star,
// read, headline, byline — under the window's edge, so the reader fits a comic
// and then cannot star it. The card is what the fit has to show whole.
check(
  "the fit sizes the window to the whole card, not the picture",
  (() => {
    const fn = list.slice(list.indexOf("async function fitToComic"), list.indexOf("function syncSnap"));
    return (
      /const chrome =\s*card\.offsetHeight - Math\.round\(img\.getBoundingClientRect\(\)\.height\) \+\s*\(header \? Math\.round\(header\.getBoundingClientRect\(\)\.height\) : 0\)/.test(fn) &&
      // …and it is `chrome` the height is built from, not the picture alone
      /chrome \+ pictureH/.test(fn)
    );
  })(),
);

// A window that ends exactly on the card's edges says the stream ends there. Room
// for the neighbours says it does not — and the sheet fades them by the same
// length, so a fitted card sits just past its own fade and stays crisp.
check(
  "and it leaves the sliver of the card above and below",
  (() => {
    const declared = Number(/const CARD_PEEK = (\d+);/.exec(list)?.[1]);
    const faded = Number(/\.cards \{[\s\S]{0,1600}?--card-peek: (\d+)px;/.exec(list)?.[1]);
    return (
      declared === 24 &&
      faded === declared &&
      /chrome \+ pictureH \+ 2 \* CARD_PEEK/.test(list)
    );
  })(),
  `fit ${/const CARD_PEEK = (\d+);/.exec(list)?.[1]}, sheet ${/\.cards \{[\s\S]{0,1600}?--card-peek: (\d+)px;/.exec(list)?.[1]}`,
);

check(
  "the edges of the cards' column fade into the pane",
  (() => {
    const block = list.slice(list.indexOf("  .cards {"), list.indexOf("  .cards::-webkit-scrollbar"));
    const fades = (block.match(/#000 calc\(100% - var\(--card-peek\)\)/g) ?? []).length;
    const ends = (block.match(/transparent 100%/g) ?? []).length;
    return (
      // both edges, both spelled for WebKitGTK and for Chromium: two of each
      fades === 2 &&
      ends === 2 &&
      /mask-image: linear-gradient\(/.test(block) &&
      /-webkit-mask-image: linear-gradient\(/.test(block)
    );
  })(),
  "fades/ends",
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
