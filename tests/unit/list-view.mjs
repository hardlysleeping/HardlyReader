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
check("one column offers no fold", /\{#if mode !== 1\}/.test(main));

const reading = read("src/state/reading.svelte.ts");
check("the shape is stored", /listView: this\.listView/.test(reading));
check("and read back through the guard", /isListView\(saved\.listView\)/.test(reading));

const layout = read("src/state/layout.svelte.ts");
check("the fold is stored", /collapsed: this\.sidebarCollapsed/.test(layout));
check("and read back", /typeof saved\.collapsed === "boolean"/.test(layout));
check("collapsing keeps the dragged widths", !/toggleSidebar\(\)[\s\S]{0,200}widths\s*=/.test(layout));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
