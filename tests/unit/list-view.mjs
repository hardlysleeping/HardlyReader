/**
 * Headless checks for the posts column's four shapes.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/list-view.mjs
 *
 * Two things are being pinned here. First the model: four views, one default,
 * and which of them has room for a preview or a picture. Second the promise
 * that made the views worth adding — that starring and marking read are
 * available in *every* shape, not only the one that happens to look like the
 * old row. That is checked in the markup, because it is a rule about what is
 * drawn, not a computation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  LIST_VIEWS,
  LIST_VIEW_DEFAULT,
  LIST_VIEW_LABELS,
  LIST_VIEW_TITLES,
  isListView,
  picturePlacement,
  showsPreview,
} from "../../src/lib/list-view.ts";
import { GUTTER, gridTemplate } from "../../src/lib/panes.ts";
import {
  CARD_LEAD,
  CARD_SIZES,
  GRID_COLUMN_CHOICES,
  GRID_COLUMNS_DEFAULT,
  GRID_TILE_MIN,
  gridIsSquare,
  gridTemplate as gridColumnsTemplate,
  isCardSize,
  isGridColumns,
} from "../../src/lib/list-view.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

// --- the four shapes ---------------------------------------------------------

check(
  "four shapes, in the order they appear in the bar",
  LIST_VIEWS.join(",") === "regular,list,cards,grid",
  LIST_VIEWS.join(","),
);
check("the tuned row is the default", LIST_VIEW_DEFAULT === "regular");
check(
  "every shape is named and explained",
  LIST_VIEWS.every((view) => LIST_VIEW_LABELS[view] && LIST_VIEW_TITLES[view]),
);
check("a stored value is checked, not trusted", isListView("grid") && !isListView("Grid") && !isListView(null) && !isListView(3));

check("regular rows show two lines of the post", showsPreview("regular"));
check("cards show two lines of the post", showsPreview("cards"));
check("the one-line list shows no preview", !showsPreview("list"));
check("tiles show no preview", !showsPreview("grid"));

check("regular rows put the picture beside the text", picturePlacement("regular") === "side");
check("cards put it above the headline", picturePlacement("cards") === "top");
check("tiles put it above the headline", picturePlacement("grid") === "top");
check("the one-line list has no picture at all", picturePlacement("list") === "none");

// --- the folded sidebar ------------------------------------------------------

const widths = { sidebar: 300, list: 400 };

check(
  "unfolded two panes keep the sidebar and its seam",
  gridTemplate(2, widths) === `300px ${GUTTER}px minmax(0, 1fr)`,
  gridTemplate(2, widths),
);
check(
  "folded two panes lose both, not just the width",
  gridTemplate(2, widths, true) === "minmax(0, 1fr)",
  gridTemplate(2, widths, true),
);
check(
  "folded three panes start at the posts column",
  gridTemplate(3, widths, true) === `400px ${GUTTER}px minmax(0, 1fr)`,
  gridTemplate(3, widths, true),
);
check(
  "unfolded three panes are unchanged by the flag",
  gridTemplate(3, widths, false) === gridTemplate(3, widths),
);
check("one column has nothing to fold", gridTemplate(1, widths, true) === "minmax(0, 1fr)");

// --- what the components promise --------------------------------------------

const list = read("src/components/ArticleList.svelte");
check("the bar offers every shape", /LIST_VIEWS as option/.test(list));
check("the choice is written to reading state", /reading\.setListView\(/.test(list));
check("the column takes its shape from the setting", /reading\.listView/.test(list));
check(
  "all three arrangements are driven from markup",
  /class:compact=\{view === "list"\}/.test(list) &&
    /class:cards=\{view === "grid"|class:cards=\{view === "cards"\}/.test(list) &&
    /class:grid=\{view === "grid"\}/.test(list),
);

// The actions block must not sit inside a per-view conditional: one `.acts`
// for the whole list is the shape that cannot go missing in a new view.
const acts = list.indexOf('<div class="acts">');
check("star and read are drawn once, for every shape", acts > 0 && list.indexOf('<div class="acts">', acts + 1) === -1);
const actsTail = list.slice(acts, list.indexOf("</div>", acts));
check(
  "the star button is inside that block",
  /toggleStar\(item, event\)/.test(actsTail) && /aria-pressed=\{isStarred\(item\)\}/.test(actsTail),
);
check(
  "the read button is inside that block",
  /toggleRead\(item, event\)/.test(actsTail) && /aria-pressed=\{isRead\(item\)\}/.test(actsTail),
);
// Both handlers live in the script and both stop the click from also opening
// the post: two stopPropagation calls, no more (a third would mean a third
// control on the row that nobody asked for).
const stops = list.match(/stopPropagation\(\)/g) ?? [];
check("neither button also opens the post", stops.length === 2, String(stops.length));
check(
  "the handlers are the reader's own writes",
  /void reader\.toggleStar\(item\)/.test(list) && /void reader\.setRead\(item, !isRead\(item\)\)/.test(list),
);

const main = read("src/views/Main.svelte");
check("the pane switch carries the fold", /layout\.toggleSidebar\(\)/.test(main));
check(
  "the folded sidebar is not rendered at all",
  (main.match(/\{#if !layout\.collapsed\}/g) ?? []).length === 2,
  String((main.match(/\{#if !layout\.collapsed\}/g) ?? []).length),
);
// The fold is offered in three panes only. In two it would leave one full-width
// column — which is what one-pane mode already is, minus the surface that walks
// feeds to article and back.
check("one column offers no fold", /\{#if mode !== 1\}/.test(main) === false);
check("two panes offer no fold either", /\{#if mode === 3\}/.test(main));

const reading = read("src/state/reading.svelte.ts");
check("the shape is stored", /listView: this\.listView/.test(reading));
check("and read back through the guard", /isListView\(saved\.listView\)/.test(reading));

const layout = read("src/state/layout.svelte.ts");
check("the fold is stored", /collapsed: this\.sidebarCollapsed/.test(layout));
check("and read back", /typeof saved\.collapsed === "boolean"/.test(layout));
check("collapsing keeps the dragged widths", !/toggleSidebar\(\)[\s\S]{0,200}widths\s*=/.test(layout));


// The feed's own mark, in the posts pane: the same local pin the sidebar row
// shows, so a feed can be pinned while reading it rather than by going back.
check("the posts pane knows which feed it is showing", /reader\.subscriptions\.find\(\(candidate\) => candidate\.id === reader\.activeStream\)/.test(list));
check("it reads the pin state", /reader\.isFeedPinned\(feed\.id\)/.test(list));
check("and writes it", /reader\.setFeedPinned\(feed\.id, !reader\.isFeedPinned\(feed\.id\)\)/.test(list));
check("the mark is only drawn for a feed", /\{#if feed\}/.test(list));
check("it is a pressed toggle, not a one-way button", /aria-pressed=\{reader\.isFeedPinned\(feed\.id\)\}/.test(list));
check("and it marks, rather than restyling the row", /class="mark"/.test(list));


// One implementation of the posts list, three places it appears: pane two, pane
// three, and the one-pane block under a feed row. The one-pane list used to be
// a second, smaller component — a title, a time and a picture — which is why a
// phone had no view switch and no way to star a post.
const sidebar = read("src/components/Sidebar.svelte");
check("the one-pane posts are the real list", /<ArticleList nested \/>/.test(sidebar));
check("and there is no second post row implementation", !/class="post-title"/.test(sidebar));
check("the nested flag exists", /nested = false \}: \{ onOpen\?: \(\) => void; nested\?: boolean \}/.test(list));
check("nesting drops the second title", /\{#if !nested\}[\s\S]{0,80}<h1>/.test(list));
check("and the nested block does not make its own scrollbar", /\.list\.nested \.items \{[\s\S]{0,80}overflow: visible/.test(list));
check("touch gets a real target for the toggles", /@media \(pointer: coarse\)[\s\S]{0,120}width: 34px/.test(list));


// Pins while locked: the control leaves the band and sits above it, outside
// both the fold and the curtain, so asking for pinned-only never depends on
// being unlocked.
const band = read("src/components/SidebarBand.svelte");
check("the pin control is defined once", (band.match(/\{#snippet pinControl\(\)\}/g) ?? []).length === 1);
check("and rendered in the band", /\{@render pinControl\(\)\}/.test(band));
check("it also renders while locked", /\{#if locked\}[\s\S]{0,200}\{@render pinControl\(\)\}/.test(band));
check("the locked copy is outside the reveal", /\{#if locked\}[\s\S]{0,200}lockpin[\s\S]{0,300}?<button[\s\S]{0,40}class="bar"/.test(band));
check("there is only one pin control in the markup", (band.match(/class="ctl pin"/g) ?? []).length === 0 || (band.match(/class="ctl pin"/g) ?? []).length === 1);

// Layout, not just labels: each of these was a flex child shrunk to nothing by
// the scroll port it sits in, which is how a view looks broken while its markup
// is right.
const listSource = read("src/components/ArticleList.svelte");
check("a card row keeps its height", /\.cards \.row \{[\s\S]{0,600}?flex: none;/.test(listSource));
check("a card picture keeps its height", /\.cards \.lead \{[\s\S]{0,300}?flex: none;/.test(listSource));
check("a grid picture keeps its height", /\.grid \.lead \{[\s\S]{0,300}?flex: none;/.test(listSource));
check("one line per post means one line of actions", /\.compact \.acts \{[\s\S]{0,120}?flex-direction: row;/.test(listSource));

// ------------------------------------------------------------ sizing -- Sizing is per view, and its default is the way the view
// already looked: `auto` for the grid is the same auto-fill it has always used,
// and the middle card size is the 150px cap cards already had.
check("the grid's default is its own judgement", GRID_COLUMNS_DEFAULT === "auto");
check(
  "auto is the grid that existed",
  gridColumnsTemplate("auto") === `repeat(auto-fill, minmax(${GRID_TILE_MIN}px, 1fr))`,
  gridColumnsTemplate("auto"),
);
check("a count is a promise, not a suggestion", gridColumnsTemplate(4) === "repeat(4, minmax(0, 1fr))");
check("every offered count produces a template", GRID_COLUMN_CHOICES.every((c) => /^repeat\(/.test(gridColumnsTemplate(c))));
check("a fixed count means square tiles", gridIsSquare(4) && !gridIsSquare("auto"));
check("the cards' default is the height they had", CARD_LEAD.auto === 150);
check("small is smaller and large is larger", CARD_LEAD.small < CARD_LEAD.auto && CARD_LEAD.large > CARD_LEAD.auto);
check("stored sizes are validated", isCardSize("large") && !isCardSize("huge") && isGridColumns(3) && !isGridColumns(7));
check("the card sizes are three", CARD_SIZES.length === 3);

// The controls live in the bar and belong to one view each.
check("the sizer is in the bar, not a panel", /class="bar"[\s\S]{0,4000}class="sizer"/.test(listSource));
check("the grid's count is offered only in the grid", /\{#if view === "grid"\}[\s\S]{0,900}GRID_COLUMN_CHOICES/.test(listSource));
check("the cards' size is offered only in the cards", /\{:else if view === "cards"\}[\s\S]{0,900}CARD_SIZES/.test(listSource));
check("the list and regular views show no sizer", !/view === "list"[^}]*class="sizer"/.test(listSource));
check("the count reaches the container", /style:--grid-template=\{gridTemplate\(reading\.gridColumns\)\}/.test(listSource));
check("the card height reaches the container", /style:--card-lead=/.test(listSource));
check("tiles are square only for a fixed count", /class:square=\{view === "grid" && gridIsSquare\(reading\.gridColumns\)\}/.test(listSource));
// The bug this sized control exposed: tracks sized without the picture.
check("grid tracks take the tile's real height", /\.grid \{[\s\S]{0,1400}?grid-auto-rows: max-content;/.test(listSource));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
