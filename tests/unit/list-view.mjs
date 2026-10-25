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
  ROW_ENDS,
  ROW_END_DEFAULT,
  isRowEnd,
  FLUSH_THUMB_DEFAULT,
  ROW_CURVE,
  CURVE_DEFAULT,
  clampCurve,
  LIST_VIEW_LABELS,
  LIST_VIEW_TITLES,
  isListView,
  picturePlacement,
  showsPreview,
} from "../../src/lib/list-view.ts";
import { GUTTER, gridTemplate, paneSlots } from "../../src/lib/panes.ts";
import {
  CARD_LAYOUTS,
  CARD_LAYOUT_DEFAULT,
  CARD_WINDOW,
  CARD_SIZES,
  GRID_COLUMN_MAX,
  GRID_COLUMN_MIN,
  gridColumnValue,
  GRID_COLUMNS_DEFAULT,
  GRID_TILE_MIN,
  MASONRY_COLUMN_CHOICES,
  MASONRY_COLUMNS_DEFAULT,
  MASONRY_GAP,
  gridIsSquare,
  gridTemplate as gridColumnsTemplate,
  isCardLayout,
  isCardSize,
  isGridColumns,
  isMasonryColumns,
  masonryColumns,
  masonryTrack,
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
const frame = { available: 1100 };

check(
  "unfolded two panes keep the sidebar and its seam",
  gridTemplate(2, widths, frame) === "300px 6px 794px 0px 0px",
  gridTemplate(2, widths, frame),
);
check(
  "folded two panes keep two panes: a rail, the posts, and the article beside them",
  gridTemplate(2, widths, { ...frame, collapsed: true }) === "0px 6px 400px 6px 688px",
  gridTemplate(2, widths, { ...frame, collapsed: true }),
);
check(
  "folded three panes start at the posts column",
  gridTemplate(3, widths, { ...frame, collapsed: true }) === "0px 0px 400px 6px 694px",
  gridTemplate(3, widths, { ...frame, collapsed: true }),
);
check(
  "unfolded three panes split posts and article",
  gridTemplate(3, widths, frame) === "300px 6px 400px 6px 388px",
  gridTemplate(3, widths, frame),
);
check(
  "unfolded three panes are unchanged by the flag",
  gridTemplate(3, widths, { ...frame, collapsed: false }) === gridTemplate(3, widths, frame),
);
check(
  "one column fits the frame while the window follows the pane",
  gridTemplate(1, widths, frame) === "1100px 0px 0px 0px 0px",
  gridTemplate(1, widths, frame),
);
check(
  "and expands to the whole frame it must not resize",
  gridTemplate(1, widths, { ...frame, keepWidths: false }) === "1100px 0px 0px 0px 0px",
  gridTemplate(1, widths, { ...frame, keepWidths: false }),
);

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
const acts = list.indexOf('<div class="acts" data-no-drag-scroll>');
check("star and read are drawn once, for every shape", acts > 0 && list.indexOf('<div class="acts" data-no-drag-scroll>', acts + 1) === -1);
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
// the post. The third is the card pager: flipping a multi-picture card is the
// one other thing on a row that must not open the article.
const stops = list.match(/stopPropagation\(\)/g) ?? [];
// star, read, open at source — and the card pager's flip, which stops a click
// on a clicker from opening the post.
check("no control on a row also opens the post", stops.length === 4, String(stops.length));
check(
  "the handlers are the reader's own writes",
  /void reader\.toggleStar\(item\)/.test(list) && /void reader\.setRead\(item, !isRead\(item\)\)/.test(list),
);

const main = read("src/views/Main.svelte");
check("the pane switch carries the fold", /layout\.toggleSidebar\(\)/.test(main));
// The fold used to unmount the sidebar. Panes are no longer destroyed on a
// layout change — a folded pane is hidden and keeps its rows, images and
// scroll — so the guarantee is now that the fold reaches `paneSlots` (which
// drops the sidebar and its seam) rather than that an `{#if}` removes them.
check(
  "the fold is decided in the slot map, not by unmounting",
  paneSlots({ mode: 2, level: "feeds", collapsed: true }).sidebar === false &&
    paneSlots({ mode: 2, level: "feeds", collapsed: true }).seam === false &&
    paneSlots({ mode: 2, level: "feeds", collapsed: true }).rail === true &&
    paneSlots({ mode: 3, level: "feeds", collapsed: true }).sidebar === false &&
    paneSlots({ mode: 3, level: "feeds", collapsed: true }).seam === false,
);
check(
  "and unfolding brings both back",
  paneSlots({ mode: 2, level: "feeds", collapsed: false }).sidebar === true &&
    paneSlots({ mode: 2, level: "feeds", collapsed: false }).seam === true &&
    paneSlots({ mode: 2, level: "feeds", collapsed: false }).rail === false &&
    paneSlots({ mode: 3, level: "feeds", collapsed: false }).seam === true,
);
check(
  "a folded pane is hidden rather than removed from the grid",
  /class:away=\{!slots\.sidebar\}/.test(main) && /class:away=\{!slots\.seam\}/.test(main),
);
// The header's fold belongs to three panes. In two the fold is the seam's own
// chip (see `collapse.mjs`), and in one column there is nothing to fold.
check("the header's fold is for three panes", /mode === 3\}/.test(main) && /layout\.collapsed/.test(main));
check("one column offers no fold", /\{#if mode !== 1\}/.test(main) === false);

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
check(
  "every count the ruler can reach produces a template",
  ["auto", ...Array.from({ length: GRID_COLUMN_MAX - GRID_COLUMN_MIN + 1 }, (_, i) => GRID_COLUMN_MIN + i)].every(
    (c) => /^repeat\(/.test(gridColumnsTemplate(c)),
  ),
);
check("the ruler runs from two to eight", GRID_COLUMN_MIN === 2 && GRID_COLUMN_MAX === 8);
check("nine across is not a count any more", isGridColumns(9) === false && isGridColumns(8) === true);
check("neither is one across, nor a fraction", isGridColumns(1) === false && isGridColumns(3.5) === false);
check("auto is still a count of its own", isGridColumns("auto") === true);
check(
  "with auto the ruler sits at its preview rather than inventing a count",
  gridColumnValue("auto") === 4 && gridColumnValue(7) === 7,
);
check("a fixed count means square tiles", gridIsSquare(4) && !gridIsSquare("auto"));
// The window is a page's shape at the column's width; the sizes change how tall
// that window is, which is what makes a contained picture bigger or smaller.
check("the cards' default window is a 2:3 page", CARD_WINDOW.auto === 1.5);
check(
  "a shorter window for S, a taller one for L",
  CARD_WINDOW.small < CARD_WINDOW.auto && CARD_WINDOW.large > CARD_WINDOW.auto,
);
check("the window is a height per unit of width", CARD_WINDOW.auto * 5 === 7.5);
check("stored sizes are validated", isCardSize("large") && !isCardSize("huge") && isGridColumns(3) && isGridColumns(7) && !isGridColumns(9));
check("the card sizes are three", CARD_SIZES.length === 3);

// Cards' second arrangement is a pick, not a fifth shape: two layouts, and the
// one that already shipped is the default.
check("cards have two arrangements", CARD_LAYOUTS.join(",") === "rows,masonry", CARD_LAYOUTS.join(","));
check("one card per row is the default", CARD_LAYOUT_DEFAULT === "rows");
check("a stored layout is checked, not trusted", isCardLayout("masonry") && !isCardLayout("Masonry") && !isCardLayout(null));
check(
  "the views did not gain a fifth shape",
  LIST_VIEWS.length === 4 && !LIST_VIEWS.includes("masonry"),
  String(LIST_VIEWS.length),
);
check("the column counts are 2, 3 and 4", MASONRY_COLUMN_CHOICES.join(",") === "2,3,4", MASONRY_COLUMN_CHOICES.join(","));
check("two columns unless another is chosen", MASONRY_COLUMNS_DEFAULT === 2);
check("counts are numbers, not sizes", !isMasonryColumns("3") && !isMasonryColumns(1) && !isMasonryColumns(5));
check("an unknown stored count falls back to two", masonryColumns(3) === 3 && masonryColumns(9) === 2 && masonryColumns("4") === 2);
check("the container is handed a column count, not a length", masonryTrack(4) === "4" && masonryTrack(undefined) === "2");
check("columns and their gutter are the same 10px the rows were apart", MASONRY_GAP === 10);

// The controls live in the bar and belong to one view each.
check("the sizer is in the bar, not a panel", /class="bar"[\s\S]{0,6000}class="sizer"/.test(listSource));
check(
  "the grid's count is offered only in the grid",
  /\{#if view === "grid"\}[\s\S]{0,1600}type="range"/.test(listSource),
);
check(
  "and the range is bounded by the same two numbers the type allows",
  /min=\{GRID_COLUMN_MIN\}[\s\S]{0,120}max=\{GRID_COLUMN_MAX\}/.test(listSource),
);
check(
  "auto is a button, not the end of the range",
  /class="sizebtn"[\s\S]{0,320}onclick=\{\(\) => reading\.setGridColumns\("auto"\)\}/.test(listSource),
);
// The cards' branch holds the shape picks, the masonry toggle and the column
// counts, so it is sliced by its own delimiters rather than a character window.
const cardsBranch = listSource.slice(
  listSource.indexOf('{:else if view === "cards"}'),
  listSource.indexOf('<div class="filters"'),
);
check(
  "cards offer no picture size: a height can only shorten a tall picture, never widen a strip",
  !/CARD_SIZES|CARD_SHAPES|setCardSize/.test(cardsBranch),
);
check("the list and regular views show no sizer", !/view === "list"[^}]*class="sizer"/.test(listSource));
check("the count reaches the container", /style:--grid-template=\{gridTemplate\(reading\.gridColumns\)\}/.test(listSource));
check("the card window reaches the container", /style:--card-window=/.test(listSource));
check("tiles are square only for a fixed count", /class:square=\{view === "grid" && gridIsSquare\(reading\.gridColumns\)\}/.test(listSource));
// The bug this sized control exposed: tracks sized without the picture.
check("grid tracks take the tile's real height", /\.grid \{[\s\S]{0,1400}?grid-auto-rows: max-content;/.test(listSource));

check(
  "a list row keeps its side gutter small so the headline gets the width",
  /\.compact \.item \{[^}]*padding: calc\(6px \* var\(--row-scale, 1\)\) 8px;/.test(listSource),
);

check(
  "a list row's toggles are thumb-sized and stand off the pane's edge",
  /\.items\.compact \.acts \{[^}]*padding: 2px 28px 2px 0;/.test(listSource) &&
    /\.compact \.act \{[^}]*width: 24px;[^}]*height: 24px;/.test(listSource) &&
    /\.compact \.act svg \{[^}]*width: 16px;/.test(listSource),
);

check(
  "on touch the list's toggles grow again",
  /\.compact \.act \{[^}]*width: 30px;[^}]*height: 30px;/.test(listSource),
);

// Regular rows say "unread" with the row itself. The dot took its width off the
// headline's left edge, which is the pane's left edge.
check(
  "only the one-line row carries the marker",
  /\{#if view === "list"\}\s*<span class="dot"/.test(listSource),
);
check(
  "an unread row draws an accent rim along its bottom",
  /\.row:not\(\.read\) \{[^}]*box-shadow:[^}]*var\(--accent\) 62%/.test(listSource),
);
check(
  "a read row steps back as a whole",
  /\.row\.read \{[^}]*opacity: 0\.48;/.test(listSource) &&
    /\.row\.read:hover,\s*\n?\s*\.row\.read\.selected \{[^}]*opacity: 0\.85;/.test(listSource),
);

// The rim does not stop at the bottom hairline in a row: it turns the corner and
// runs up the right edge, thicker than the hairline, so an unread post is marked
// on the side you scroll past. Only the rows view gets it; Cards, the one-line
// list and the grid keep the rim they had.
// A regular row ends in a turn rather than a corner, and the unread mark is the
// accent of that turn: borders on the box the row already is, so there is no
// region outside the accent left to fill in, and no wedge painted behind it.
check(
  "an unread row's rim turns the corner into an edge up the right",
  (() => {
    const rule = listSource.slice(
      listSource.indexOf(".items:not(.compact):not(.cards):not(.grid) .row:not(.read)::after"),
    );
    const body = rule.slice(0, rule.indexOf("\n  }"));
    return (
      /content: "";/.test(body) &&
      /border-right: 5px solid color-mix\(in srgb, var\(--accent\) 92%, transparent\);/.test(body) &&
      /border-bottom: 1px solid color-mix\(in srgb, var\(--accent\) 58%, transparent\);/.test(body) &&
      /border-top: 1px solid color-mix\(in srgb, var\(--accent\) 58%, transparent\);/.test(body) &&
      /border-radius: 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\) 0;/.test(body)
    );
  })(),
  "5px up the edge, a hairline either side, and the row's own turn",
);

check(
  "the end is pulled in from the pane's edge, so the turn is a turn",
  (() => {
    const rule = listSource.slice(
      listSource.indexOf(".items:not(.compact):not(.cards):not(.grid) .row {"),
    );
    const body = rule.slice(0, rule.indexOf("\n  }"));
    return (
      /margin-right: 9px;/.test(body) &&
      !/overflow: hidden;/.test(body) &&
      // Held against the edge the end reads as a cut-off corner, or asks for the
      // two corners the turn leaves to be filled in — and a filled gap between
      // two pills reads as a rail down the column rather than as a row ending.
      !/::before/.test(
        listSource.slice(
          listSource.indexOf(".items:not(.compact):not(.cards):not(.grid) .row:not(.read)"),
          listSource.indexOf(".row.read {"),
        ),
      )
    );
  })(),
  "9px of air at the edge, and no fill between one end and the next",
);

check(
  "one post is separated from the next by space, not by a rule",
  (() => {
    const rule = listSource.slice(
      listSource.indexOf(".items:not(.compact):not(.cards):not(.grid) .row {"),
    );
    const body = rule.slice(0, rule.indexOf("\n  }"));
    return /margin-bottom: 4px;/.test(body) && /border-bottom: 0;/.test(body);
  })(),
  "4px between rows, and the hairline gone with it",
);

check(
  "the end has a shadow of its own, so it reads as something you could press",
  (() => {
    const rule = listSource.slice(
      listSource.indexOf(".items:not(.compact):not(.cards):not(.grid) .row {"),
    );
    const body = rule.slice(0, rule.indexOf("\n  }"));
    // Flat: a shadow dropped to the right, not an inner light or a bevel. The row
    // stays a 2D shape with a curve; the shadow is the only relief it gets.
    return (
      /box-shadow: 3px 2px 7px -4px rgba\(0, 0, 0, 0\.55\);/.test(body) &&
      !/inset/.test(body)
    );
  })(),
);

check(
  "the trim is drawn over the row, never in the way of it",
  /\.items:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row:not\(\.read\)::after \{[^}]*pointer-events: none;/.test(
    listSource,
  ) && /\.row \{\s*position: relative;/.test(listSource),
);


// Star and read were the only two acts. "Open at source" is the third, and it
// lives in the one `acts` group every view draws — a card, a regular row, a
// compact line and a grid tile all get it because none of them own the group.
check(
  "a row can be opened at its source, in every view",
  (() => {
    const acts = listSource.slice(listSource.indexOf('<div class="acts" data-no-drag-scroll>'));
    const group = acts.slice(0, acts.indexOf("</div>"));
    return (
      /class="act open"/.test(group) &&
      /aria-label="Open at source"/.test(group) &&
      /onclick=\{\(event\) => openAtSource\(item, event\)\}/.test(group) &&
      // No view condition inside the group: whatever the shape, the same acts.
      !/\{#if view/.test(group)
    );
  })(),
);
// Three glyphs on every row are the busiest thing in the list, so each one says
// what it is by colour — and the same three names collapse to one ink when the
// theme is set to Monotone. A class per act is what lets the stylesheet do that
// without a second copy of the markup.
check(
  "each act wears its own colour, and one setting can take them all away",
  (() => {
    const group = listSource.slice(listSource.indexOf('<div class="acts" data-no-drag-scroll>'));
    const acts = group.slice(0, group.indexOf("</div>"));
    return (
      /class="act star"/.test(acts) &&
      /class="act mark"/.test(acts) &&
      /class="act open"/.test(acts) &&
      /\.act\.star \{\s*color: var\(--act-star\);/.test(listSource) &&
      /\.act\.mark \{\s*color: var\(--act-read\);/.test(listSource) &&
      /\.act\.open \{\s*color: var\(--act-link\);/.test(listSource)
    );
  })(),
);

check(
  "it opens the link and nothing else",
  (() => {
    const fn = listSource.slice(listSource.indexOf("function openAtSource"));
    const where = listSource.slice(listSource.indexOf("function sourceUrl"));
    return (
      /event\.stopPropagation\(\);/.test(fn) &&
      /void openExternal\(url\);/.test(fn) &&
      // and it is only drawn when the feed said where the post lives
      /\{#if source !== null\}/.test(listSource) &&
      /const href = item\.alternate\?\.\[0\]\?\.href \?\? item\.canonical\?\.\[0\]\?\.href \?\? null;/.test(where) &&
      /return isExternalHttp\(href\) \? href : null;/.test(where)
    );
  })(),
);
check(
  "a link leaves the app rather than replacing it",
  (() => {
    const lib = read("src/lib/open-external.ts");
    return (
      /__TAURI_INTERNALS__/.test(lib) &&
      /plugin-opener/.test(lib) &&
      /window\.open\(url, "_blank", "noopener,noreferrer"\)/.test(lib) &&
      // a prompt would be a dialog; this is meant to just go
      !/confirm\(|prompt\(|alert\(/.test(lib)
    );
  })(),
);


// The list view folds its dates into tabs. The rule that matters is that the
// fold is the list's alone: cards, grid and regular rows are read by shape, and
// a tab between two cards would cut the page of them in half.
check(
  "only the list view folds its dates",
  (() => {
    const derive = listSource.slice(listSource.indexOf("const entries = $derived"));
    return (
      /view === "list"\s*\? tabbed\(reader\.listItems, closedTabs\)/.test(derive) &&
      /: reader\.listItems\.map/.test(derive)
    );
  })(),
);
check(
  "a tab is a button that opens and shuts",
  (() => {
    const tab = listSource.slice(listSource.indexOf('class="tab"'));
    return (
      /class:closed=\{entry\.closed\}/.test(tab.slice(0, 400)) &&
      /aria-expanded=\{!entry\.closed\}/.test(tab.slice(0, 400)) &&
      /onclick=\{\(\) => toggleTab\(entry\.tab\.key\)\}/.test(tab.slice(0, 400))
    );
  })(),
);
check(
  "the tabs step in: month at the edge, week in, day further in",
  (() => {
    const css = listSource.slice(listSource.indexOf(".items .tab {"));
    const rule = css.slice(0, css.indexOf("}"));
    return (
      /var\(--depth, 0\) \* 14px/.test(rule) &&
      /border-radius: 8px 8px 0 0/.test(rule) &&
      /border-bottom-color: transparent/.test(rule)
    );
  })(),
);
check(
  "a month is the level that speaks up",
  /class:month=\{entry\.tab\.level === 0\}/.test(listSource) &&
    /\.items \.tab\.month \{/.test(listSource),
);

/*
 * Reading in the column itself.
 *
 * The Rows view can hold the article a tap opened, instead of sending it to the
 * column beside it. Three facts make that a promise rather than a drawing: the
 * switch exists only for Rows, the choice is remembered, and marking the post
 * read is what ends the visit — marking it unread is a correction, not a finish.
 */
const readingSource = readFileSync(join(root, "src/state/reading.svelte.ts"), "utf8");
const mainSource = readFileSync(join(root, "src/views/Main.svelte"), "utf8");
const readerSource = readFileSync(join(root, "src/components/ReaderPane.svelte"), "utf8");

check(
  "the read-here switch belongs to Rows, and sits beside the four views",
  (() => {
    const views = listSource.slice(listSource.indexOf('class="views"'));
    const group = views.slice(0, views.indexOf("<!-- Sizing lives"));
    return (
      /\{#if view === "regular"\}/.test(group) &&
      /aria-label="Read posts in this column"/.test(group) &&
      /onclick=\{\(\) => reading\.toggleReadInPane\(\)\}/.test(group) &&
      /class:on=\{reading\.readInPane\}/.test(group)
    );
  })(),
);
check(
  "the choice is remembered, off by default",
  /readInPane = \$state\(false\)/.test(readingSource) &&
    /if \(typeof saved\.readInPane === "boolean"\) this\.readInPane = saved\.readInPane;/.test(readingSource) &&
    /readInPane: this\.readInPane,/.test(readingSource),
);
check(
  "the page is drawn over the list, not instead of it",
  /inert=\{inPane\}/.test(mainSource) &&
    /\.slot\.posts \.over \{\s*position: absolute;/.test(mainSource) &&
    /class:reading=\{inPane\}/.test(mainSource),
);
check(
  "the list keeps its place: the cover borrows the article column's room",
  /\.panes\.three \.slot\.posts\.reading,\s*\.panes\.two\.folded \.slot\.posts\.reading \{\s*grid-column: 3 \/ -1;/.test(
    mainSource,
  ),
);
check(
  "marking read ends the visit; marking unread does not",
  /if \(isRead\(item\)\) \{\s*reader\.setRead\(item, false\);\s*return;\s*\}/.test(readerSource) &&
    /reader\.markRead\(item\);\s*onRead\?\.\(\);/.test(readerSource) &&
    /onRead=\{closeInPane\}/.test(mainSource),
);

/* ---- how a row ends: half a turn, or the pill it used to be ---------------- */

check(
  "a row's end has two shapes, and both are shapes a row can have",
  ROW_ENDS.length === 2 && ROW_ENDS.includes("half") && ROW_ENDS.includes("pill") &&
    isRowEnd("half") && isRowEnd("pill") &&
    !isRowEnd("full") && !isRowEnd(null) && !isRowEnd(undefined) && !isRowEnd(1),
);
check(
  "the half turn is the shape that is drawn, and the pill is still one press away",
  ROW_END_DEFAULT === "half" &&
    /rowsEnd = \$state<RowEnd>\(ROW_END_DEFAULT\)/.test(readingSource) &&
    /setRowsEnd\(next: RowEnd\)/.test(readingSource) &&
    /toggleRowsEnd\(\): void \{\s*this\.setRowsEnd\(this\.rowsEnd === "half" \? "pill" : "half"\);/.test(
      readingSource,
    ),
);
check(
  "the shape survives a reload",
  /if \(isRowEnd\(saved\.rowsEnd\)\) this\.rowsEnd = saved\.rowsEnd;/.test(readingSource) &&
    /rowsEnd: this\.rowsEnd,/.test(readingSource),
);
check(
  "the option is offered where Rows is drawn, and says which shape is showing",
  /class:on=\{reading\.rowsEnd === "half"\}/.test(listSource) &&
    /aria-pressed=\{reading\.rowsEnd === "half"\}/.test(listSource) &&
    /onclick=\{\(\) => reading\.toggleRowsEnd\(\)\}/.test(listSource),
);
check(
  "half a turn is only the bottom, and the foot is as thick as the edge",
  /\.items\.half-end:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row \{[\s\S]{0,400}?--foot: 2px;[\s\S]{0,200}?border-radius: 0 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\);/.test(
    listSource,
  ) &&
    /\.items\.half-end[^{]*\.row:not\(\.read\)::after \{[^}]*border-radius: 0 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\);[^}]*border-bottom-width: var\(--foot\);[^}]*border-right-width: var\(--foot\);[^}]*border-left: var\(--foot\) solid/.test(
      listSource,
    ),
);
check(
  "the pill steps in from the foot it would otherwise sit on, by the foot's own thickness",
  /\.items\.half-end[^{]*\.acts \{\s*margin: 2px 11px 4px 0;\s*border-radius: max\(0px, calc\(var\(--row-turn, 30px\) - var\(--foot\)\)\);/.test(listSource),
);
check(
  "the old shape is untouched: both right-hand corners, one-pixel foot",
  /\.items:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row \{[\s\S]{0,300}?border-radius: 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\) 0;/.test(
    listSource,
  ) &&
    /\.row:not\(\.read\)::after \{[\s\S]{0,1600}?border-right: 5px solid[\s\S]{0,200}?border-bottom: 1px solid/.test(
      listSource,
    ),
);
check(
  "the new shape only ever applies to a row, never to cards, the grid or the compact list",
  (listSource.match(/\.items\.half-end/g) ?? []).length === 13 &&
    (listSource.match(/\.items\.half-end[^,{]*\{/g) ?? []).every((rule) =>
      rule.includes(":not(.compact):not(.cards):not(.grid)"),
    ) &&
    /class:half-end=\{view === "regular" && reading\.rowsEnd === "half"\}/.test(listSource),
);

/* The foot matches itself: the left edge is the right edge's weight, the row
   steps in from the pane's edge on both sides by the same 9px, and the row's
   content clears the new left edge by the 11px the actions clear the right.
   The right-hand numbers are asserted above and are not restated here. */
check(
  "both ends of the foot are the same: one thickness on three sides, 9px in from the pane, 12px of clearance",
  /\.items\.half-end[^{]*\.row \{[^}]*margin-left: 9px;/.test(listSource) &&
    /\.items\.half-end[^{]*\.row:not\(\.read\)::after \{[^}]*border-right-width: var\(--foot\);[^}]*border-left: var\(--foot\) solid/.test(
      listSource,
    ) &&
    /\.items\.half-end[^{]*\.item \{[^}]*padding: calc\(4px \* var\(--row-scale, 1\)\) 6px calc\(4px \* var\(--row-scale, 1\)\) 12px;/.test(
      listSource,
    ) &&
    // The right side keeps its own 9px: the left is a copy, not a replacement.
    /\.items:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row \{[\s\S]{0,1600}?margin-right: 9px;/.test(
      listSource,
    ),
);

/* Tighter than the pill's row: the foot makes a slab, and a slab with the pill's
   air reads as a loose row. The picture grew and everything around it shrank,
   and its size stays fixed — a picture that stretches sets the row's height. */
check(
  "the footed row is tighter than the pill's, with a bigger picture",
  /\.items\.half-end[^{]*\.thumb \{[^}]*width: calc\(50px \* var\(--row-scale, 1\) \* var\(--thumb-scale, 1\)\);[^}]*height: calc\(50px \* var\(--row-scale, 1\) \* var\(--thumb-scale, 1\)\);[^}]*align-self: flex-start;/.test(
    listSource,
  ) &&
    !/\.items\.half-end:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.thumb \{[^}]*align-self: stretch;/.test(
      listSource,
    ) &&
    /\.items\.half-end[^{]*\.body \{\s*gap: 2px;/.test(listSource) &&
    /\.items\.half-end[^{]*\.thumb\.left \{[^}]*margin-right: 4px;/.test(listSource),
);

/* The turn's radius: one slider per shape, from square to a full semicircle,
   with the numbers the rows had before it was a setting as the defaults. */
check("the slider runs from square to a full turn", ROW_CURVE.min === 0 && ROW_CURVE.max === 60);
check("a radius that is not a number falls back to the old one", clampCurve("30") === ROW_CURVE.initial);
check("a radius is kept inside the range", clampCurve(-10) === 0 && clampCurve(400) === 60);
check("a radius is a whole number of pixels", clampCurve(27.6) === 28);
check(
  "each shape starts at its own default, and the pill is the squarer of the two",
  CURVE_DEFAULT.pill === 24 && CURVE_DEFAULT.half === 30 && CURVE_DEFAULT.pill < CURVE_DEFAULT.half,
);

const curveComponent = read("src/components/RowCurve.svelte");
check(
  "the list carries the turn it is drawn with",
  /const rowTurn = \$derived\(reading\.rowsEnd === "half" \? reading\.curveHalf : reading\.curvePill\);/.test(
    listSource,
  ) && /style:--row-turn=\{`\$\{rowTurn\}px`\}/.test(listSource),
);
check(
  "the rows turn by that number, and the action pill keeps its parallel curve",
  /border-radius: 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\) 0;/.test(listSource) &&
    /border-radius: 0 0 var\(--row-turn, 30px\) var\(--row-turn, 30px\);/.test(listSource) &&
    /border-radius: max\(0px, calc\(var\(--row-turn, 30px\) - 5px\)\);/.test(listSource) &&
    /border-radius: max\(0px, calc\(var\(--row-turn, 30px\) - var\(--foot\)\)\);/.test(listSource),
);
check(
  "the corners have their own button and popup on the list's bar, for the rows view only",
  /\{#if view === "regular"\}[\s\S]{0,3600}?<RowCurve \/>/.test(listSource) &&
    /class="corner"/.test(curveComponent) &&
    /role="dialog" aria-label="Row corners"/.test(curveComponent) &&
    // Live, not on release: the list is the preview.
    /oninput=\{\(event\) => reading\.setCurve\("pill", Number\(event\.currentTarget\.value\)\)\}/.test(
      curveComponent,
    ) &&
    /oninput=\{\(event\) => reading\.setCurve\("half", Number\(event\.currentTarget\.value\)\)\}/.test(
      curveComponent,
    ) &&
    /reading\.resetCurves\(\)/.test(curveComponent),
);
check(
  "both radii are saved with the rest of the reading preferences",
  /curvePill: this\.curvePill,/.test(readingSource) &&
    /curveHalf: this\.curveHalf,/.test(readingSource) &&
    /this\.curvePill = clampCurve\(saved\.curvePill\)/.test(readingSource) &&
    /this\.curveHalf = clampCurve\(saved\.curveHalf\)/.test(readingSource) &&
    /if \(which === "pill"\) \{[\s\S]{0,200}?this\.curvePill = value;/.test(readingSource),
);

/* The picture that fills the corner instead of sitting in it. The row clips, the
   box is the row's height and square, and nothing is inset — so a picture can
   take the whole left end and the turn is what cuts it. */
check("the inset picture is the default, and filling the corner is asked for", FLUSH_THUMB_DEFAULT === false);
check(
  "the filled picture is the row's corner: flush, square, and clipped by the row",
  /class:flush-thumb=\{view === "regular" && reading\.rowsEnd === "half" && reading\.flushThumb\}/.test(
    listSource,
  ) &&
    /\.items\.half-end\.flush-thumb:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row \{\s*overflow: hidden;/.test(
      listSource,
    ) &&
    /\.items\.half-end\.flush-thumb[^{]*\.item \{\s*padding: 0;/.test(listSource) &&
    /\.items\.half-end\.flush-thumb[^{]*\.thumb \{[^}]*aspect-ratio: 1;[^}]*align-self: stretch;[^}]*margin: 0;[^}]*border-radius: 0;/.test(
      listSource,
    ) &&
    // Out of the box's measurements, or the picture's own width would decide the corner.
    /\.items\.half-end\.flush-thumb[^{]*\.thumb img \{\s*position: absolute;\s*inset: 0;/.test(
      listSource,
    ),
);
check(
  "the text keeps the inset the picture no longer takes",
  /\.items\.half-end\.flush-thumb[^{]*\.body \{\s*padding: calc\(4px \* var\(--row-scale, 1\)\) 6px calc\(4px \* var\(--row-scale, 1\)\) 12px;/.test(
    listSource,
  ),
);
check(
  "the toggle is only drawn in the one shape that has a corner to fill",
  /\{#if reading\.rowsEnd === "half"\}[\s\S]{0,700}?aria-label="Picture fills the row's corner"[\s\S]{0,400}?onclick=\{\(\) => reading\.toggleFlushThumb\(\)\}/.test(
    listSource,
  ),
);
check(
  "and it is saved with the shape it belongs to",
  /flushThumb: this\.flushThumb,/.test(readingSource) &&
    /if \(typeof saved\.flushThumb === "boolean"\) this\.flushThumb = saved\.flushThumb;/.test(readingSource) &&
    /toggleFlushThumb\(\): void \{\s*this\.flushThumb = !this\.flushThumb;\s*this\.save\(\);/.test(readingSource),
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
