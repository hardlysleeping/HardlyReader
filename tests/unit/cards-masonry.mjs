/**
 * Headless checks for Pinterest masonry as a pick inside the Cards view.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/cards-masonry.mjs
 *
 * Three things are being pinned, and they are deliberately different kinds:
 *
 * 1. The storage rules in `src/lib/card-prefs.ts` — a first run, a relaunch,
 *    corrupt JSON, an older blob and no storage at all.
 * 2. The store itself (`src/lib/card-layout.svelte.ts`), which is a runes
 *    module: it is compiled with Svelte's `compileModule` and imported from a
 *    throwaway directory inside the project, the way `reader-state.mjs` does.
 *    Toggling has to survive a reload, and the two fields must not clobber
 *    each other.
 * 3. The markup and CSS in `ArticleList.svelte`: one toggle at the left of the
 *    existing sizer group, never both sets of three at once, never a fifth
 *    view pill, the card's comic-page window with the picture fitted inside it,
 *    and the masonry rules that make the columns work (`break-inside: avoid`, a
 *    column count, the picture at its own aspect, and a rows fallback where
 *    columns are unsupported).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  CARD_PREFS_DEFAULT,
  CARD_PREFS_KEY,
  readCardPrefs,
  writeCardPrefs,
} from "../../src/lib/card-prefs.ts";
import { CARD_WINDOW, MASONRY_GAP } from "../../src/lib/list-view.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

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

/** A localStorage stand-in: one map, and the two methods the app uses. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

// ---------------------------------------------------------- storage rules --

const fresh = readCardPrefs(fakeStorage());
check("a first run is one card per row", fresh.mode === "rows");
check("a first run is two columns", fresh.columns === 2);
check("no storage at all is the same answer", readCardPrefs(undefined).mode === "rows");

const storage = fakeStorage();
writeCardPrefs(storage, { mode: "masonry" });
check("the mode is written under its own key", storage.data.has(CARD_PREFS_KEY), CARD_PREFS_KEY);
check("and read back", readCardPrefs(storage).mode === "masonry");
writeCardPrefs(storage, { columns: 4 });
check("a column count keeps the mode", readCardPrefs(storage).mode === "masonry");
check("and is read back", readCardPrefs(storage).columns === 4);
writeCardPrefs(storage, { mode: "rows" });
check("turning masonry off keeps the columns", readCardPrefs(storage).columns === 4);

check(
  "a corrupt blob falls back to rows and two",
  readCardPrefs(fakeStorage({ [CARD_PREFS_KEY]: "{not json" })).mode === "rows" &&
    readCardPrefs(fakeStorage({ [CARD_PREFS_KEY]: "{not json" })).columns === 2,
);
const stale = readCardPrefs(fakeStorage({ [CARD_PREFS_KEY]: JSON.stringify({ mode: "wide", columns: 9 }) }));
check("an unknown mode falls back to rows", stale.mode === "rows");
check("an unknown count falls back to two", stale.columns === 2);
check(
  "an old blob with only a count keeps it",
  readCardPrefs(fakeStorage({ [CARD_PREFS_KEY]: JSON.stringify({ columns: 3 }) })).columns === 3,
);
check("the defaults are the shipped view", CARD_PREFS_DEFAULT.mode === "rows" && CARD_PREFS_DEFAULT.columns === 2);

// An invalid write is not stored: the setter's guard is enforced at the key
// too, so a bad value cannot arrive from a second caller either.
const guarded = fakeStorage();
writeCardPrefs(guarded, { mode: "diagonal" });
check("an invalid mode is not written", readCardPrefs(guarded).mode === "rows");
writeCardPrefs(guarded, { columns: 7 });
check("an invalid count is not written", readCardPrefs(guarded).columns === 2);

// ---------------------------------------------------------------- the store --

/**
 * `card-layout.svelte.ts` is a runes module, so Node cannot import it directly:
 * type-strip it, compile it with Svelte, rewrite its relative imports to
 * absolute paths (the generated file does not sit next to the originals) and
 * import it from inside the project so `svelte/reactivity` still resolves.
 */
function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

let storeRuns = 0;

async function loadStore(storageLike) {
  const source = read("src/lib/card-layout.svelte.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "card-layout.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "card-layout.svelte.ts" });
  const code = compiled.js.code
    .replaceAll('"./card-prefs"', JSON.stringify(absolute("src/lib/card-prefs.ts")))
    .replaceAll('"./chrome-prefs"', JSON.stringify(absolute("src/lib/chrome-prefs.ts")))
    .replaceAll('"./list-view"', JSON.stringify(absolute("src/lib/list-view.ts")));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, `card-layout.${storeRuns}.mjs`);
  writeFileSync(out, code);
  const url = `${pathToFileURL(out).href}?run=${storeRuns}`;
  storeRuns++;
  // `load()` runs at import, so the storage has to be in place first — which is
  // also the real order: the store is read before the first paint.
  globalThis.localStorage = storageLike;
  return import(url);
}

const firstRun = await loadStore(fakeStorage());
check("the store starts as rows", firstRun.cardLayout.mode === "rows" && firstRun.cardLayout.masonry === false);
check("the store starts at two columns", firstRun.cardLayout.columns === 2);
firstRun.cardLayout.toggleMasonry();
check("the toggle turns masonry on", firstRun.cardLayout.masonry === true);
check("and writes it, not just remembers it", readCardPrefs(globalThis.localStorage).mode === "masonry");
firstRun.cardLayout.setColumns(3);
check("a column count is kept", firstRun.cardLayout.columns === 3);
check("and written", readCardPrefs(globalThis.localStorage).columns === 3);
firstRun.cardLayout.setMode("rows");
check("turning masonry off does not forget the columns", firstRun.cardLayout.columns === 3);
firstRun.cardLayout.setMode("sideways");
check("an unknown mode is refused by the store", firstRun.cardLayout.mode === "rows");

const relaunch = await loadStore(globalThis.localStorage);
check("a relaunch comes back in the layout that was chosen", relaunch.cardLayout.mode === "rows");
check("with the columns that were chosen", relaunch.cardLayout.columns === 3);

const wasMasonry = await loadStore(fakeStorage({ [CARD_PREFS_KEY]: JSON.stringify({ mode: "masonry", columns: 4 }) }));
check("a stored masonry choice is honoured", wasMasonry.cardLayout.masonry === true);
check("a stored count is honoured", wasMasonry.cardLayout.columns === 4);

const broken = await loadStore(fakeStorage({ [CARD_PREFS_KEY]: "{oops" }));
check("a corrupt blob starts at rows and two", broken.cardLayout.mode === "rows" && broken.cardLayout.columns === 2);

const closed = await loadStore(undefined);
check("no storage is not an error", closed.cardLayout.mode === "rows");
closed.cardLayout.toggleMasonry();
check("and toggling still works for the session", closed.cardLayout.masonry === true);

// --------------------------------------------------- markup and CSS guards --

const list = read("src/components/ArticleList.svelte");

const cardsAt = list.indexOf('{:else if view === "cards"}');
const filtersAt = list.indexOf('<div class="filters"');
const cardsBranch = list.slice(cardsAt, filtersAt);
check("the cards branch exists", cardsAt > 0 && filtersAt > cardsAt);

const sizerAt = cardsBranch.indexOf('class="sizer"');
const toggleAt = cardsBranch.indexOf('class="sizebtn masonry"');
const ifAt = cardsBranch.indexOf("{#if cardLayout.masonry}");
const sizesAt = cardsBranch.indexOf("CARD_SIZES");
const countsAt = cardsBranch.indexOf("MASONRY_COLUMN_CHOICES");

check("the masonry pick is inside the cards sizer", sizerAt >= 0 && toggleAt > sizerAt);
check(
  "it sits among the shape picks, before the column counts",
  toggleAt > 0 && toggleAt < ifAt && ifAt < countsAt,
);
check("it is a pressed toggle with a name", /aria-label="Masonry"/.test(cardsBranch) && /aria-pressed=\{cardLayout\.masonry\}/.test(cardsBranch));
check("the toggle is the only thing it writes", /cardLayout\.toggleMasonry\(\)/.test(cardsBranch));

// The column counts exist only under masonry, and the old picture-height set
// is gone: three buttons where two of them left a page's card unchanged.
check(
  "the column counts appear only once masonry is on",
  /\{#if cardLayout\.masonry\}[\s\S]{0,700}MASONRY_COLUMN_CHOICES[\s\S]{0,900}\{\/if\}/.test(cardsBranch),
);
check("cards no longer offer a picture height", !/CARD_SIZES/.test(cardsBranch));
check("the column counts are buttons, not labels", /cardLayout\.setColumns\(count\)/.test(cardsBranch));
check("each count is named for a screen reader", /aria-label=\{`\$\{count\} columns`\}/.test(cardsBranch));
check(
  "every card is drawn at the one window",
  /style:--card-window=\{`\$\{\(CARD_WINDOW\.auto \* reading\.thumbScale\)/.test(list),
);

// No new view and no second row of controls.
const viewsAt = list.indexOf("{#each LIST_VIEWS as option");
check("no fifth view pill", viewsAt > 0 && (list.match(/LIST_VIEWS as option/g) ?? []).length === 1);
check("masonry is not a view", !/view === "masonry"/.test(list));
check("the bar gained no second row of controls", (list.match(/class="sizer"/g) ?? []).length === 2);
check("the bar has no new sibling group", !/class="(masonrybar|masonry-sizer|columns)"/.test(list));

// The container and the CSS: the count, the gutter, and the unbroken card.
check(
  "the column count reaches the container",
  /style:--masonry-columns=\{masonryTrack\(cardLayout\.columns\)\}/.test(list),
);
check(
  "the container becomes masonry only in cards",
  /class:masonry=\{view === "cards" && cardLayout\.masonry\}/.test(list),
);
const masonryBlock = list.slice(list.indexOf(".cards.masonry {"), list.indexOf("@supports not (columns: 2)"));
check(
  "a masonry picture may take half the visible column, no more",
  /\.cards\.masonry \.lead img \{[^}]*max-height: 50cqh;/.test(list),
);
check(
  "the port is the measure of that half",
  /\.items \{[^}]*container-type: size;/.test(list),
);
check(
  "and a nested list is not a size container",
  /\.list\.nested \.items \{[^}]*container-type: normal;/.test(list),
);
check("columns are the container's", /\.cards\.masonry \{[\s\S]{0,300}?columns: var\(--masonry-columns, 2\);/.test(masonryBlock));
check("with the cards' own 10px between them", new RegExp(`column-gap: ${MASONRY_GAP}px;`).test(masonryBlock));
check("a block container, because columns do not apply to a flex one", /\.cards\.masonry \{[\s\S]{0,400}?display: block;/.test(masonryBlock));
check(
  "no card is split across a break",
  /\.cards\.masonry \.row \{[\s\S]{0,300}?break-inside: avoid;/.test(masonryBlock),
);
check(
  "and the vertical gap is the card's own",
  new RegExp(`\\.cards\\.masonry \\.row \\{[\\s\\S]{0,300}?margin-bottom: ${MASONRY_GAP}px;`).test(masonryBlock),
);
check(
  "the picture keeps its own aspect",
  /\.cards\.masonry \.lead \{[\s\S]{0,200}?aspect-ratio: auto;[\s\S]{0,120}?max-height: none;/.test(masonryBlock) &&
    /\.cards\.masonry \.lead img \{[\s\S]{0,120}?height: auto;/.test(masonryBlock),
);
check("load more spans the columns", /\.cards\.masonry \.more \{[\s\S]{0,80}?column-span: all;/.test(masonryBlock));

// Rows mode: one window for every post, shaped like a comic page, and the whole
// picture fitted inside it. The 16:9 band it replaced cropped the top and bottom
// off a page, which is the one thing a comics reader cannot lose.
const cardsLead = list.slice(list.indexOf(".cards .lead {"), list.indexOf(".cards .body {"));
check(
  "a card's picture is not capped, so a vertical strip has no bars beside it",
  /\.cards \.lead img \{[^}]*width: 100%;[^}]*height: auto;[^}]*max-height: none;/.test(list) ||
    (/\.cards \.lead img \{[^}]*width: 100%;/.test(list) &&
      !/\.cards \.lead img \{[^}]*max-height:/.test(list)),
);
check(
  "the picture takes the whole width and keeps its own height below the cap",
  /width: 100%;/.test(cardsLead) && /\.cards \.lead img \{[^}]*height: auto;/.test(list),
);
check("a capped picture sits even in the card", /margin-inline: auto;/.test(list));
check(
  "the window sets the cap, not the width",
  /\.cards \.lead \{[^}]*container-type: inline-size;/.test(cardsLead) &&
    /CARD_WINDOW\.auto \* reading\.thumbScale/.test(list),
);
check(
  "the whole picture is fitted inside the window, not cropped to it",
  /\.cards \.lead img \{[^}]*object-fit: contain;/.test(list) &&
    !/\.cards \.lead[^{]*\{[^}]*object-fit: cover/.test(list),
);
check("rows are still one under the next", /\.cards \{[\s\S]{0,120}?display: flex;/.test(list));
check("the masonry rules come after the card rules they refine", list.indexOf(".cards.masonry {") > list.indexOf(".cards .lead {"));

// Where columns do not exist, the same cards are drawn as rows.
const fallback = list.slice(list.indexOf("@supports not (columns: 2)"));
check("there is a fallback for engines without columns", fallback.length > 0);
check(
  "the fallback is the same full-width card, one under the next",
  /@supports not \(columns: 2\) \{[\s\S]{0,200}?\.cards\.masonry \{[\s\S]{0,160}?display: flex;[\s\S]{0,700}?container-type: inline-size;/.test(
    list,
  ),
);

// A post with no picture draws no image band at all: the lead is behind the
// placement, and a null picture is `none`.
check(
  "no picture means no image band",
  /\{@const placement = picture === null \? "none" : picturePlacement\(view\)\}/.test(list) &&
    /\{#if placement === "top"\}[\s\S]{0,120}?<span class="lead"/.test(list),
);

// The consequence is written down, not hidden: multi-column is column-major.
check("the column-major consequence is stated in the code", /column-major/.test(list));

// No transition was added to the layout switch: the cards appear, they do not
// animate, so there is nothing for prefers-reduced-motion to suppress.
check("the switch is not animated", !/\.cards\.masonry[^{]*\{[^}]*transition/.test(list));

// ------------------------------------------------------------ card content --
// A card is not a row with a picture on top: it has the width for a longer
// headline, more of the post under it, and room for both the feed and the
// author. Cards had the row's two-line 160-character stub in a 16:9 tile.
check(
  "a card takes a longer cut of the post than a row does",
  /summary\(item, view === "cards" \? 320 : 160\)/.test(list),
);
check("the card's headline gets a third line", /\.cards \.title \{[^}]*-webkit-line-clamp: 3/.test(list));
check("and is drawn larger than a row's", /\.cards \.title \{[^}]*font-size: calc\(15px/.test(list));
check("the card preview is three lines", /\.cards \.preview \{[^}]*-webkit-line-clamp: 3/.test(list));
check(
  "a card says the feed and the author, not one instead of the other",
  /\{feedNameOf\(item\) \|\| bylineOf\(item\)\}/.test(list) && /class="author-name"/.test(list),
);
check(
  "but a feed whose posts are pictures reserves no blank line",
  /blurb !== ""/.test(list) && /\{@const blurb = summary\(item, view === "cards"/.test(list),
);
check(
  "the row keeps its two-line headline and preview",
  /\.title \{[^}]*-webkit-line-clamp: 2/.test(list) && /\.preview \{[^}]*-webkit-line-clamp: 2/.test(list),
);

// --------------------------------------------------- the whole picture --
// Cards used to crop every lead to a 16:9 band, then (later) measure each image
// and give the tall ones a card of their own. One comic-shaped window and
// `contain` settles both: nothing is measured at load, nothing is cut, and a
// wide photograph letterboxes instead of losing its sides.
check("no image is measured at load any more", !/measureShape|isTallPicture|class:tall/.test(list));
check(
  "the window is the column's whole width, not a thumbnail's",
  /\.cards \.lead \{[^}]*width: 100%/.test(list) && !/--card-lead/.test(list),
);
check(
  "a picture keeps its own height at the card's width, whatever its shape",
  /\.cards \.lead img \{[^}]*width: 100%;[^}]*height: auto;/.test(list) &&
    !/\.cards \.lead img \{[^}]*max-height: calc\(100cqw/.test(list),
);
check(
  "a picture is never cropped inside a card, only fitted",
  /\.cards \.lead img \{[^}]*object-fit: contain;/.test(list) &&
    /\{@const picture = image\(item\)\}/.test(list),
);
check(
  "a small picture is scaled up to the card's width rather than left in a box",
  /\.cards \.lead img \{[^}]*width: 100%;/.test(list) && !/object-fit: cover/.test(cardsLead),
);
check(
  "a column still lets a picture keep its own aspect",
  /\.cards\.masonry \.lead \{[^}]*width: 100%;[^}]*aspect-ratio: auto;/.test(list),
);
check(
  "the cards stay one shape each, not a per-image shape",
  !/\.cards \.lead \{[^}]*aspect-ratio:/.test(list) &&
    !/measureShape|isTallPicture|class:tall/.test(list),
);

check(
  "a multi-picture card flips in place instead of opening the post",
  /function flip\(event: Event, item: StreamItem, count: number, step: number\)/.test(read("src/components/ArticleList.svelte")) &&
    /event\.stopPropagation\(\)/.test(read("src/components/ArticleList.svelte")) &&
    /class="edge back"/.test(read("src/components/ArticleList.svelte")) &&
    /class="edge on"/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the pips count the pictures and fill the current one",
  /\{#each strip as _, index \(index\)\}/.test(read("src/components/ArticleList.svelte")) &&
    /class="pip" class:on=\{index === page\}/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \.pip\.on \{[^}]*background: var\(--accent\)/.test(read("src/components/ArticleList.svelte")),
);

check(
  "one picture means no clickers and no pips",
  /\{#if strip\.length > 1\}/.test(read("src/components/ArticleList.svelte")) &&
    /\{:else\}\s*\n\s*<img\s+src=\{shown\(picture \?\? ""\)\}/.test(read("src/components/ArticleList.svelte")) &&
    /\{#if strip\.length > 1\}[\s\S]{0,80}<span class="edge back"/.test(read("src/components/ArticleList.svelte")) === false,
);

check(
  "a single-picture post still draws exactly one image",
  (read("src/components/ArticleList.svelte").match(/src=\{shown\(picture \?\? ""\)\}/g) ?? []).length === 1,
);

check(
  "the card is the pane: no side gutter, and none above or below the column",
  /\.cards \{[^}]*padding: 0;/.test(read("src/components/ArticleList.svelte")) &&
    !/padding-inline|padding-left|padding-right/.test(read("src/components/ArticleList.svelte").split(".cards {")[1].split("}")[0]) &&
    /\.cards \.row \{[^}]*border-inline: 0/.test(read("src/components/ArticleList.svelte")) &&
    /border-radius: 0/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the space between cards is the column's gap, not a margin on the edge ones",
  /\.cards \{[^}]*gap: 10px;/.test(read("src/components/ArticleList.svelte")) &&
    !/first-child|:last-child/.test(read("src/components/ArticleList.svelte").split(".cards {")[1].split("}")[0]),
);

check(
  "the column has no gutter to clear before the first card sits in it",
  /padding: 0;/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \{[^}]*gap: 10px;/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the flip edge is a setting, not a fixed fifth of the card",
  /--flip-edge=\{reading\.flipEdge\}/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \.edge \{[^}]*width: calc\(var\(--flip-edge, 10\) \* 1%\)/.test(read("src/components/ArticleList.svelte")) &&
    !/\.cards \.edge \{[^}]*width: 20%/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the card list steps a card with the article pane's own pull",
  /import \{ SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor \} from "\.\.\/lib\/scroll-advance"/.test(read("src/components/ArticleList.svelte")) &&
    /thresholdFor\(reading\.scrollEffort\)/.test(read("src/components/ArticleList.svelte")) &&
    /use:cardWheel/.test(read("src/components/ArticleList.svelte")) &&
    /addEventListener\("wheel", onListWheel, \{ passive: false \}\)/.test(read("src/components/ArticleList.svelte")) &&
    /listSettleUntil = performance\.now\(\) \+ SETTLE_MS/.test(read("src/components/ArticleList.svelte")) &&
    /event\.preventDefault\(\)/.test(read("src/components/ArticleList.svelte")),
);

check(
  "a card that fits is stepped whole; one taller than the pane keeps the wheel",
  /function cardFits\(row: HTMLElement\): boolean/.test(read("src/components/ArticleList.svelte")) &&
    /if \(!row \|\| !cardFits\(row\)\) \{/.test(read("src/components/ArticleList.svelte")) &&
    /listPullTimer = setTimeout\(\(\) => \{/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the card being read is the one nearest the middle of the pane",
  /function currentCard\(\): HTMLElement \| null/.test(read("src/components/ArticleList.svelte")) &&
    /const middle = el\.getBoundingClientRect\(\)\.top \+ el\.clientHeight \/ 2;/.test(read("src/components/ArticleList.svelte")) &&
    /Math\.abs\(box\.top \+ box\.height \/ 2 - middle\)/.test(read("src/components/ArticleList.svelte")) &&
    // The first-bottom-past-the-middle rule names the card below when the middle
    // falls in the gap between two cards, which steps two along instead of one.
    !/bottom > middle/.test(read("src/components/ArticleList.svelte")),
);

check(
  "a step centres the card, so its neighbours peek above and below",
  /function centreCard\(card: HTMLElement\): void/.test(read("src/components/ArticleList.svelte")) &&
    /const place = box\.top - port\.top \+ el\.scrollTop;/.test(read("src/components/ArticleList.svelte")) &&
    /landOn\(target\);/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the landing is a position, not a nudge the webview can add to",
  // `scrollTop +=` inherits any scroll the webview ran on its own account — the
  // native wheel it may still apply, or a snap it decided on — so the step landed
  // a card further on, in whichever direction the wheel went. The position is
  // written as an absolute place in the column instead.
  (() => {
    const src = read("src/components/ArticleList.svelte");
    return (
      !/el\.scrollTop \+=/.test(src) &&
      /const place = box\.top - port\.top \+ el\.scrollTop;/.test(src) &&
      /place - \(el\.clientHeight - box\.height\) \/ 2;/.test(src) &&
      /function landOn\(card: HTMLElement\): void \{\s*centreCard\(card\);/.test(src)
    );
  })(),
);
check(
  "the column is released from snapping while the thread places a card",
  /:global\(\.cards\.stepping\) \{\s*scroll-snap-type: none;/.test(
      read("src/components/ArticleList.svelte"),
    ) &&
    /el\.classList\.add\("stepping"\)/.test(read("src/components/ArticleList.svelte")),
);

check(
  "a step moves the list without opening the post",
  /function stepCard\(direction: 1 \| -1\): void/.test(read("src/components/ArticleList.svelte")) &&
    /landOn\(target\);/.test(read("src/components/ArticleList.svelte")) &&
    /data-id=\{item\.id\}/.test(read("src/components/ArticleList.svelte")) &&
    !/stepCard[\s\S]{0,600}?reader\.select\(/.test(read("src/components/ArticleList.svelte")),
);

check(
  "one delay is shared, so both panes settle the same way",
  /export const SETTLE_MS = 420;/.test(read("src/lib/scroll-advance.ts")) &&
    /import \{ SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor \} from "\.\.\/lib\/scroll-advance"/.test(read("src/components/ReaderPane.svelte")),
);

check(
  "the next card's picture is fetched before the step moves",
  /function prefetchFrom\(id: string \| undefined\): void/.test(read("src/components/ArticleList.svelte")) &&
    /prefetchFrom\(target\.dataset\.id \?\? undefined\);/.test(read("src/components/ArticleList.svelte")) &&
    /img\.src = shown\(first\)/.test(read("src/components/ArticleList.svelte")),
);

check(
  "a card asked for ahead of time draws its picture, and does not defer it again",
  /const loadNow = \(id: string\): boolean => nearIds\[id\] === true \|\| aheadIds\[id\] === true;/.test(read("src/components/ArticleList.svelte")) &&
    /\{#if loadNow\(item\.id\)\}/.test(read("src/components/ArticleList.svelte")) &&
    /loading=\{aheadIds\[item\.id\] \? "eager" : "lazy"\}/.test(read("src/components/ArticleList.svelte")),
);

check(
  "only the next two cards are held, so a long feed does not load everything",
  /for \(const step of \[1, 2\]\)/.test(read("src/components/ArticleList.svelte")) &&
    /aheadIds = next;/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the cards column takes the scrollbar's width too",
  /scrollbar-width: none;/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards::-webkit-scrollbar \{/.test(read("src/components/ArticleList.svelte")),
);

check(
  "a card's toggles are big, spaced, and stand off the corner",
  /\.cards \.act \{[^}]*width: calc\(30px \* var\(--row-scale, 1\)\);/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \.acts \{[^}]*gap: calc\(8px \* var\(--row-scale, 1\)\);/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \.acts \{[^}]*right: calc\(12px \* var\(--row-scale, 1\)\);/.test(read("src/components/ArticleList.svelte")),
);

check(
  "the words under a card are compact",
  /\.cards \.body \{[^}]*gap: calc\(4px \* var\(--row-scale, 1\)\);/.test(read("src/components/ArticleList.svelte")) &&
    /\.cards \.preview \{[^}]*line-clamp: 3;/.test(read("src/components/ArticleList.svelte")),
);

/**
 * A finger has no wheel. The column snaps card to card so letting go finishes
 * the gesture, the same place the wheel steps to.
 */
check(
  "the cards column snaps, and only as far as it needs to",
  /\.cards \{[^}]*-?scroll-snap-type: y proximity;/.test(read("src/components/ArticleList.svelte")),
);
check(
  "each card snaps to the middle, where the wheel puts it",
  /\.cards \.row \{[^}]*scroll-snap-align: center;/.test(read("src/components/ArticleList.svelte")),
);
check(
  "a card taller than the pane opts the column out of snapping",
  /\.cards\[data-tallcard="true"\] \{\s*scroll-snap-type: none;/.test(read("src/components/ArticleList.svelte")) &&
    /data-tallcard=\{tallCard \? "true" : undefined\}/.test(read("src/components/ArticleList.svelte")),
);
// A finger has no settle window to lean on, so the fling itself has to be
// stopped: without this a 300px flick crossed three cards in a 390x740 viewport
// and the snap picked whichever one momentum died near.
check(
  "a thumb gets one card per push, where a mouse gets one card per step",
  /@media \(pointer: coarse\) \{\s*\.cards \.row \{\s*scroll-snap-stop: always;/.test(
    read("src/components/ArticleList.svelte"),
  ),
);

check(
  "a masonry wall of cards does not snap at all",
  /\.cards\.masonry \{\s*scroll-snap-type: none;/.test(read("src/components/ArticleList.svelte")),
);
check(
  "the column reads its own scroll to know which card is in the middle",
  /onscroll=\{onCardsScroll\}/.test(read("src/components/ArticleList.svelte")) &&
    /function syncSnap\(\): void \{[\s\S]{0,200}cardFits\(card\)/.test(read("src/components/ArticleList.svelte")),
);

// Unread and read are marks on the row, and a card is a row: the same treatment
// reaches the comics view instead of stopping at the text views.
check(
  "a card says unread and read the same way a row does",
  !/\.items:not\(\.cards\)/.test(read("src/components/ArticleList.svelte")) &&
    /\.row:not\(\.read\) \{[\s\S]{0,200}?var\(--accent\) 62%/.test(read("src/components/ArticleList.svelte")) &&
    /\.row\.read \{\s*opacity: 0\.48;/.test(read("src/components/ArticleList.svelte")),
);
check(
  "a card carries no marker beside its headline",
  /\{#if view === "list"\}\s*<span class="dot"/.test(read("src/components/ArticleList.svelte")),
);

// One flick used to cross five cards: the handler returned early during the
// settle window without stopping the event, so the column scrolled natively
// under the step it had just made and snapped onto whatever it landed near.
check(
  "a whole wheel gesture belongs to one step, its tail included",
  (() => {
    const src = read("src/components/ArticleList.svelte");
    const fn = src.slice(src.indexOf("function onListWheel"));
    const stop = fn.indexOf("event.preventDefault()");
    const settle = fn.indexOf("if (performance.now() < listSettleUntil)");
    const branch = fn.slice(settle, fn.indexOf("listPull = accumulate", settle));
    // The stop comes before the settle check, so the tail of a gesture cannot
    // scroll the list natively under the step. The window is a fixed interval
    // though: extending it on every arriving delta meant a hand that keeps
    // scrolling never goes quiet, and scrolling without moving the mouse did
    // nothing at all.
    return stop > 0 && settle > stop && !/listSettleUntil =/.test(branch);
  })(),
);

// A mouse drag on the cards is a move, not a scroll that happens to stop
// somewhere: the hand drags the column, and the release lands on the card the
// drag crossed. Snapping has to stay off for the length of the pan, or the snap
// engine pulls the column back to where it started and the drag does nothing —
// which is what made it feel like it only worked now and then.
check(
  "a drag on the cards lands on a card",
  (() => {
    const src = read("src/components/ArticleList.svelte");
    const fn = src.slice(src.indexOf("function onPanUp"));
    return (
      /const PAN_STEP = 24;/.test(src) &&
      /if \(view !== "cards" \|\| event\.pointerType !== "mouse"\) return;/.test(src) &&
      /if \(Math\.abs\(moved\) < PAN_STEP\) \{\s*landOn\(from\);/.test(fn) &&
      /const crossed = Math\.max\(1, Math\.round\(Math\.abs\(moved\) \/ Math\.max\(1, stride\)\)\);/.test(fn) &&
      /landOn\(target\);/.test(fn)
    );
  })(),
);
check(
  "the cards do not snap while a drag has hold of them",
  /:global\(\.drag-panning\) \.cards \{\s*scroll-snap-type: none;/.test(read("src/components/ArticleList.svelte")),
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
