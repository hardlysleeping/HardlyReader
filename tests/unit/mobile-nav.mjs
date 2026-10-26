/**
 * The phone's sliding stack: where it is allowed to draw, and every layer it
 * can walk back through.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/mobile-nav.mjs
 *
 * `state/mobile-nav.svelte.ts` is a runes module, so it is type-stripped with the
 * project's TypeScript, compiled with Svelte's `compileModule`, and imported from
 * a throwaway directory inside the project — the same treatment `reader-state.mjs`
 * gives the reader. The state is real: these are the transitions the component
 * presses, not a description of them.
 *
 * The layout's preference is pressed for real too, because the thing worth
 * proving about it is a negative — that a rotation (which arrives as
 * `setAvailable`) cannot rewrite the answer the user gave. That cannot be shown
 * by reading the source alone.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/**
 * One runes module, compiled to plain ESM.
 *
 * Relative specifiers are rewritten to absolute file URLs: a generated file does
 * not sit next to the module it came from, so `./mobile-nav.svelte` would resolve
 * to nothing — and, worse, resolving to the `.ts` original would import runes
 * that no compiler had turned into signals.
 */
function build(sourcePath, outName, rewrites = []) {
  const source = readFileSync(join(ROOT, sourcePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  const compiled = compileModule(outputText, {
    generate: "client",
    filename: sourcePath,
  });
  let code = compiled.js.code;
  for (const [from, to] of rewrites) code = code.replaceAll(JSON.stringify(from), JSON.stringify(to));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, `${outName}.mjs`);
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const mobileNavPath = build("src/state/mobile-nav.svelte.ts", "mobile-nav");
const layoutPath = build("src/state/layout.svelte.ts", "layout", [
  ["./mobile-nav.svelte", mobileNavPath],
  ["../lib/account-key", absolute("src/lib/account-key.ts")],
  ["../lib/platform", absolute("src/lib/platform.ts")],
  ["../lib/panes", absolute("src/lib/panes.ts")],
  ["../lib/window-fit", absolute("src/lib/window-fit.ts")],
]);

const { MobileNavState, EDGE, PEEK, offsetFor, previousPane, slidesInPortrait } =
  await import(mobileNavPath);
// The name and its guard are layout vocabulary (`lib/panes.ts`), because the
// layout has to store the preference without importing a runes module.
const { isMobilePortraitMode } = await import(absolute("src/lib/panes.ts"));

// ---------------------------------------------------------------------------
// Where the stack is allowed to be drawn at all.
// ---------------------------------------------------------------------------
check("a phone held upright that chose sliding draws the stack", slidesInPortrait({ device: "phone", portrait: true, mode: "stack" }) === true);
check("the walk it shipped with is never replaced", slidesInPortrait({ device: "phone", portrait: true, mode: "single" }) === false);
// Landscape is the desktop three-pane layout, whatever the preference says.
check("turned sideways a phone keeps three columns", slidesInPortrait({ device: "phone", portrait: false, mode: "stack" }) === false);
check("and single, sideways, is single", slidesInPortrait({ device: "phone", portrait: false, mode: "single" }) === false);
// A desktop window is the window manager's business, at either shape.
check("a desktop window is never a phone stack", slidesInPortrait({ device: "desktop", portrait: true, mode: "stack" }) === false);
check("nor upright on a desktop", slidesInPortrait({ device: "desktop", portrait: false, mode: "stack" }) === false);
check("every combination is answered", [true, false].every((portrait) => [true, false].every((desktop) => ["single", "stack"].every((mode) =>
  typeof slidesInPortrait({ device: desktop ? "desktop" : "phone", portrait, mode }) === "boolean",
))));

check("only the two names are modes", isMobilePortraitMode("stack") && isMobilePortraitMode("single"));
check("anything else is not", ["", "Stack", "panes", null, undefined, 1].every((value) => !isMobilePortraitMode(value)));

// ---------------------------------------------------------------------------
// The two numbers, and the layer they put in front.
// ---------------------------------------------------------------------------
const nav = new MobileNavState();

check("a fresh stack rests on the list", nav.basePane === 2 && nav.overlayPane === null);
check("so the list is what is in front", nav.showing === 2);
check("with nothing behind it to walk out to", nav.depth === 0);
check("with the feeds there to slide in", nav.canOpenPrevious === true);
check("the pane behind the list is the feeds", previousPane(2) === 1);
check("the pane behind the article is the list", previousPane(3) === 2);

// The feeds, slid in over the list.
check("the previous pane slides in", nav.openPrevious() === true);
check("and it is the feeds", nav.overlayPane === 1 && nav.showing === 1);
check("over the list, which is still the base", nav.basePane === 2);
check("one layer to unwind", nav.depth === 1);
check("a layer is not stacked on itself", nav.openPrevious() === false && nav.overlayPane === 1);
check("and with one open there is nothing further out", nav.canOpenPrevious === false);
check("and it goes back where it came from", nav.closeOverlay() === true);
check("leaving the list in front", nav.overlayPane === null && nav.showing === 2);
check("closing nothing is honest about it", nav.closeOverlay() === false);

// Switching feeds while the feeds pane is open keeps it open. A feed switch does
// not change whether an article is open, so the level's answer is the same one
// it already gave — and a stack that closed the list on it would be closing the
// pane the reader is picking from.
nav.openPrevious();
nav.syncReading(false);
nav.syncReading(false);
check("picking feeds keeps the feeds pane open", nav.overlayPane === 1 && nav.showing === 1);

// ...and choosing a post is the opposite: the article is what was asked for, so
// it comes to the front and the list goes.
nav.landOnArticle();
check("a post comes to the front", nav.basePane === 3 && nav.overlayPane === null && nav.showing === 3);
check("nothing left over it", nav.depth === 1);

// The article's own pane: the list can be pulled over it, and put back without
// losing the article that was being read.
check("the list slides in over the article", nav.openPrevious() === true && nav.overlayPane === 2);
check("the article is still the base", nav.basePane === 3);
check("two layers now", nav.depth === 2);
check("put back, the article is still open", nav.closeOverlay() === true && nav.showing === 3 && nav.basePane === 3);

// Back, one layer at a time, and the order it takes them in.
const article = new MobileNavState();
article.landOnArticle();
check("back never leaves the article without closing it", article.back() === "article");
check("and says so rather than doing it", article.basePane === 3);
// The caller closes the reader; the base follows from the reading level alone.
article.syncReading(false);
check("closing the article rests the stack on the list", article.basePane === 2 && article.showing === 2);
check("at the root, back is the app's", article.back() === "app");
check("which changes nothing of the stack's", article.basePane === 2 && article.overlayPane === null);

const peek = new MobileNavState();
peek.landOnArticle();
peek.openPrevious();
check("an overlay is dismissed before the article is left", peek.back() === "overlay");
check("and the article survives being peeked past", peek.basePane === 3 && peek.showing === 3);
check("the next back is the article's", peek.back() === "article");

const listed = new MobileNavState();
listed.openPrevious();
check("over the list, back closes the feeds", listed.back() === "overlay" && listed.showing === 2);
check("and then the app has it", listed.back() === "app");

// Reading level: the base follows it, and only when it actually moves.
const followed = new MobileNavState();
followed.openPrevious();
followed.syncReading(true);
check("the article chosen over an open feeds pane wins", followed.basePane === 3 && followed.overlayPane === null);
followed.syncReading(true);
check("the same level again changes nothing", followed.basePane === 3 && followed.overlayPane === null);
followed.openPrevious();
// Picking a post while the list peeks over the old one is not a change of level
// (`syncReading` would rightly do nothing); it is the tap's own answer.
followed.landOnArticle();
check("a second post leaves the peeking list behind", followed.basePane === 3 && followed.overlayPane === null);

// Everything back to the start.
const reset = new MobileNavState();
reset.landOnArticle();
reset.openPrevious();
reset.reset();
check("reset is the fresh stack", reset.basePane === 2 && reset.overlayPane === null && reset.depth === 0);

// ---------------------------------------------------------------------------
// The geometry the component draws.
// ---------------------------------------------------------------------------
check("the pane in front sits at the edge", offsetFor(2, 2) === 0 && offsetFor(1, 1) === 0 && offsetFor(3, 3) === 0);
check("the pane behind peeks from the left", offsetFor(2, 1) === -PEEK && offsetFor(3, 2) === -PEEK);
check("and one further back peeks one step further", offsetFor(3, 1) === -2 * PEEK);
check("panes ahead wait a screen to the right", offsetFor(1, 2) === 100 && offsetFor(1, 3) === 200 && offsetFor(2, 3) === 100);
check("a peek is a sliver, not a column", PEEK > 0 && PEEK <= 30);
check("everything but the pane in front is off the edge", [[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]].every(([showing, pane]) => Math.abs(offsetFor(showing, pane)) >= PEEK));
check("the edge band is where the system gesture lives", EDGE > 0 && EDGE <= 32);

// ---------------------------------------------------------------------------
// The preference: chosen, kept, and never re-decided by a rotation.
// ---------------------------------------------------------------------------
const { layout } = await import(layoutPath);

check("the walk is what a phone starts on", layout.mobilePortraitMode === "single");
layout.setMobilePortraitMode("stack");
check("the panel's answer is taken", layout.mobilePortraitMode === "stack");
layout.setMobilePortraitMode("sideways");
check("and a value that is not a mode is ignored", layout.mobilePortraitMode === "stack");

// A rotation arrives as a measurement, at two widths and heights: the stack the
// user chose has to survive every one of them, or the setting is a setting that
// only lasts until the phone is turned.
for (const [width, height] of [[844, 390], [390, 844], [1200, 800], [320, 900]]) {
  layout.height = height;
  layout.setAvailable(width);
}
check("a rotation cannot rewrite the chosen mode", layout.mobilePortraitMode === "stack");
check("and the upright answer is the measurement's, not the preference's", typeof layout.upright === "boolean");
layout.setMobilePortraitMode("single");
check("the walk is one press away again", layout.mobilePortraitMode === "single");

// ---------------------------------------------------------------------------
// The surfaces: one stack, one preference, and no desktop in either.
// ---------------------------------------------------------------------------
const main = readFileSync(join(ROOT, "src/views/Main.svelte"), "utf8");
const stackSrc = readFileSync(join(ROOT, "src/components/MobilePaneStack.svelte"), "utf8");
const layoutSrc = readFileSync(join(ROOT, "src/state/layout.svelte.ts"), "utf8");
const navSrc = readFileSync(join(ROOT, "src/state/mobile-nav.svelte.ts"), "utf8");
const panel = readFileSync(join(ROOT, "src/components/ThemePanel.svelte"), "utf8");

check("the stack replaces the grid only when it is asked for", /\{#if slideStack\}[\s\S]{0,400}<MobilePaneStack[\s\S]{0,400}\{:else\}/.test(main));
check("and the grid is the else, untouched", /\{:else\}[\s\S]{0,900}<div\s+class="panes"/.test(main));
check("one grid, still", (main.match(/class="panes"/g) ?? []).length === 1);
// The drawer, the crumb strip and the inline feed list are the *grid's*: they
// live inside the `{:else}` branch, so a stack never draws a second one.
check(
  "the one-pane drawer is inside the grid branch, not the stack",
  main.indexOf('class="grab"') > main.indexOf("{:else}"),
);check("the stack is measured, so a rotation still reports a width", /onframe=\{\(element\) => \(panes = element\)\}/.test(main) && /onframe\?\.\(element\)/.test(stackSrc));
check(
  "the hamburger slides the feeds in, over the stack",
  /function showFeeds\(\) \{\s*\n\s*if \(slideStack\) \{[\s\S]{0,900}mobileNav\.show\(2\);\s*\n\s*mobileNav\.openPrevious\(\);/.test(main),
);
check("the preference is asked in one place", /slidesInPortrait\(\{[\s\S]{0,200}layout\.mobilePortraitMode/.test(main));
check("a saved layout carries the preference", /mobilePortraitMode: this\.mobilePortraitMode,/.test(layoutSrc));
check("and reads it back", /if \(isMobilePortraitMode\(saved\.mobilePortraitMode\)\)/.test(layoutSrc));
check(
  "a measurement never writes it",
  !/setAvailable\(px: number\): void \{[\s\S]{0,3000}mobilePortraitMode\s*=/.test(layoutSrc) &&
    !/settle\([^)]*\)[^{]*\{[\s\S]{0,1200}mobilePortraitMode\s*=/.test(layoutSrc),
);
// The field, the setter and the load: three writes, and no fourth.
check("nothing else in the app chooses it", (layoutSrc.match(/mobilePortraitMode\s*=(?!=)/g) ?? []).length === 3);

check("the layers are moved, not resized", /style:transform=\{`translateX\(\$\{offsetFor\(showing, pane\)\}%\)`\}/.test(stackSrc));
check("every pane is mounted, so a slide uncovers a drawn pane", /#each panes as pane/.test(stackSrc) && /<Sidebar inlinePosts=\{false\} \/>/.test(stackSrc) && /<ArticleList \/>/.test(stackSrc) && /<ReaderPane \{onClose\} \{onLock\} \/>/.test(stackSrc));
check("only the pane in front is reachable", /inert=\{showing !== pane\}/.test(stackSrc) && /\.layer:not\(\.front\) \{\s*\n\s*pointer-events: none;/.test(stackSrc));
check("the slide is the layout's own feel, and can be off", /--slide-ms/.test(stackSrc) && /motionMs\(layout\.motion\)/.test(stackSrc));

// The gesture: from the edge, sideways, and never in the way of anything else.
check("a swipe is only claimed near the left edge", /const touch = event\.touches\[0\];[\s\S]{0,300}if \(touch\.clientX > EDGE\) \{\s*\n\s*swipe = null;\s*\n\s*return;/.test(stackSrc));
check("and only when it travels sideways", /Math\.abs\(dx\) < Math\.abs\(dy\) \* 1\.6/.test(stackSrc));
check("a vertical drag is not touched at all", !/\.preventDefault\(\)/.test(stackSrc));
check("no touch-action jail on the pane surface", !/touch-action: none/.test(stackSrc));
check("in from the left opens the pane behind", /if \(dx > 0\) nav\.openPrevious\(\);/.test(stackSrc));
check("and back out closes it", /else nav\.closeOverlay\(\);/.test(stackSrc));
check("an overlay can be left without a gesture", /aria-label=\{`Back to the \$\{backTo\.toLowerCase\(\)\}`\}/.test(stackSrc));

// Android's back button, and the browser's own history behind it.
check("the system back button is taken over", /onBackButtonPress/.test(stackSrc));
check("and walks out one layer at a time", /function stepOut\(\): boolean \{[\s\S]{0,300}const step = nav\.back\(\);/.test(stackSrc));
check("at the root the app's own back is the answer", /if \(canGoBack\) \{\s*\n\s*window\.history\.back\(\);/.test(stackSrc) && /void exit\(0\);/.test(stackSrc));
check("history carries the stack while it has a layer", /if \(nav\.depth === 0 \|\| armed\) return;/.test(stackSrc) && /window\.history\.pushState/.test(stackSrc));
check("and a pop consumes one, not the page", /function onPopState\(\): void \{[\s\S]{0,120}armed = false;[\s\S]{0,80}stepOut\(\);/.test(stackSrc));
check("the listener is only alive while the stack is", /removeEventListener\("popstate", onPopState\)/.test(stackSrc));

// The panel: one row, on a phone, writing the preference and nothing else.
check("the panel offers exactly two shapes", /layout\.setMobilePortraitMode\("single"\)/.test(panel) && /layout\.setMobilePortraitMode\("stack"\)/.test(panel));
check("one control, not a second copy of the pane count", (panel.match(/setMobilePortraitMode/g) ?? []).length === 2);
check("and it is only drawn where a portrait frame exists", /\{#if layout\.device === "phone"\}[\s\S]{0,900}setMobilePortraitMode\("single"\)/.test(panel));

// The module's own promise: it cannot see an orientation, so a rotation cannot
// arrive here and start rearranging things.
check("the state module reads no orientation", !/matchMedia|innerWidth|orientationchange|screen\.width/.test(navSrc));
check("and holds exactly the two numbers", /basePane = \$state<BasePane>\(2\)/.test(navSrc) && /overlayPane = \$state<OverlayPane \| null>\(null\)/.test(navSrc));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
