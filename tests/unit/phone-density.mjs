/**
 * A phone's density: what its own chrome stops repeating, and where the money
 * goes instead.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/phone-density.mjs
 *
 * Four removals, one rule each, and every one of them is a *move* rather than a
 * deletion — the control still exists, on the surface that has room:
 *
 *   1. the sidebar's `Indent` row → `Settings → Feeds` (on a phone only);
 *   2. the posts bar's row ends, corner radius, picture fill and grid ruler →
 *      `Settings → Post list` (on a phone only);
 *   3. the band's fold handle and its two default words → one row while nothing
 *      is engaged;
 *   4. the title the bar already says → not said a second time by the pane
 *      under it.
 *
 * Read as source, the way `phone-header.mjs` reads the bar: the components are
 * compiled by Vite in the app and by nothing here, and what would break silently
 * is *which surface holds which control on which device*. What the rendered
 * sheet holds is `settings-panel.mjs`'s business; the band's three states are
 * `sidebar-band.mjs`'s. This file is the seam between them.
 *
 * What it cannot prove: that the freed rows actually land as content — that is a
 * measurement in the running app (390×844), and it is reported, not asserted.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const sidebar = read("src/components/Sidebar.svelte");
const band = read("src/components/SidebarBand.svelte");
const list = read("src/components/ArticleList.svelte");
const header = read("src/components/PhoneHeader.svelte");
const panel = read("src/components/SettingsPanel.svelte");
const indentControl = read("src/components/IndentControl.svelte");
const postList = read("src/components/PostListPanel.svelte");

/** The slice of `source` from `start` to the next `end`, or "" if either is gone. */
function between(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) return "";
  const to = source.indexOf(end, from + start.length);
  return to < 0 ? "" : source.slice(from, to);
}

/* ---------------------------------------------------------------------------
 * 1. The indent row: one slider, two homes, and the phone's home is the sheet.
 * ------------------------------------------------------------------------- */

check("the sidebar owns the row gate", /const phoneSidebar = \$derived\(layout\.device === "phone"\)/.test(sidebar));
check(
  "a phone does not draw the indent row, a window still does",
  /\{#if !phoneSidebar\}[\s\S]{0,900}class="indent"[\s\S]{0,900}<ThemeToggle \/>/.test(sidebar),
);
check(
  "...and the row mounts the shared slider rather than an input of its own",
  /<IndentControl \/>/.test(sidebar) && !/class="indent"[\s\S]{0,900}<input/.test(sidebar),
);
check(
  "the sheet's Feeds section mounts that exact component",
  /<IndentControl id="settings-indent" \/>/.test(panel) &&
    /import IndentControl from "\.\/IndentControl\.svelte"/.test(panel) &&
    /import IndentControl from "\.\/IndentControl\.svelte"/.test(sidebar),
);
check(
  "so the slider exists once, not once per surface",
  (sidebar.match(/type="range"/g) ?? []).length === 0 && (panel.match(/type="range"/g) ?? []).length === 0,
);
check(
  "and the write, the bound and the reason line are the component's",
  /reader\.setSidebarIndentPx\(Number\(event\.currentTarget\.value\), true\)/.test(indentControl) &&
    /max=\{reader\.sidebarIndent\.max\}/.test(indentControl) &&
    /reader\.indentDeviceOnly/.test(indentControl),
);

// The day / night switch lost its row, not its place: it sits beside the band in
// the same rail, and on a window the rail makes no box at all.
check(
  "the band and the phone's day / night switch share one rail",
  /<div class="rail">\s*<SidebarBand \/>\s*\{#if phoneSidebar\}\s*<ThemeToggle \/>/.test(sidebar),
);
check("the rail is no box on a window", /\.rail \{\s*display: contents;/.test(sidebar));
check(
  "and one row on a phone, with a thumb's target for the switch",
  /:global\(html\[data-device="phone"\]\) \.rail \{[^}]*display: flex;/.test(sidebar) &&
    /:global\(html\[data-device="phone"\]\) \.rail > :global\(\.mode\) \{[^}]*width: 34px/.test(sidebar),
);

/* ---------------------------------------------------------------------------
 * 2. The posts bar: what you read with stays, what you set once moves.
 * ------------------------------------------------------------------------- */

const bar = between(list, 'class="bar"', "</header>");
check("the posts bar is still there", bar !== "");
check(
  "the four shapes stay on the bar",
  (bar.match(/class="viewicon/g) ?? []).length >= 4,
);
check("and the filters stay", /class="filters"/.test(bar));
check(
  "the row ends, the corner and the picture fill are a window's only",
  /\{#if layout\.device !== "phone"\}[\s\S]{0,400}class="viewicon end"[\s\S]{0,900}<RowCurve \/>[\s\S]{0,900}class="viewicon flush"/.test(bar),
);
check(
  "the ruler is too, and still only in Grid",
  /\{#if view === "grid" && layout\.device !== "phone"\}[\s\S]{0,1600}aria-label="Tiles across"/.test(bar),
);
check(
  "the sheet's Post list section is a phone's, and mounts the panel",
  /\{ id: "list", label: "Post list", note: "[^"]*", phone: true \}/.test(panel) &&
    /\{:else if section\.id === "list"\}[\s\S]{0,200}<PostListPanel \/>/.test(panel),
);
check(
  "every row in it writes the store the bar's own control wrote",
  /reading\.setRowsEnd\("pill"\)/.test(postList) &&
    /reading\.setRowsEnd\("half"\)/.test(postList) &&
    /reading\.setCurve\(footed \? "half" : "pill"/.test(postList) &&
    /reading\.toggleFlushThumb\(\)/.test(postList) &&
    /reading\.setGridColumns\(Number\(event\.currentTarget\.value\)\)/.test(postList),
);
check(
  "it invents no state of its own",
  !/= \$state/.test(postList) && !/localStorage|writePrefs|savePrefs/.test(postList),
);
check(
  "and it follows the bar view for view",
  /\{#if reading\.listView === "regular"\}[\s\S]{0,400}Picture fill/.test(postList) &&
    /\{#if reading\.listView === "grid"\}[\s\S]{0,600}Tiles across/.test(postList),
);

/* ---------------------------------------------------------------------------
 * 3. The band, idle: one row instead of two, and nothing said that the glyphs
 *    and their pressed states do not already say.
 * ------------------------------------------------------------------------- */

check(
  "idle is the app's own two defaults, read rather than copied",
  /const idle = \$derived\(\s*!locked && reader\.hiddenView === "hidden" && reader\.pinView === "all",?\s*\)/.test(band),
);
check("the bandbox carries it", /class:collapsed=\{chrome\.bandCollapsed\} class:idle/.test(band));
check(
  "idle on a phone, the handle joins the row",
  /:global\(html\[data-device="phone"\]\) \.bandbox\.idle:not\(\.collapsed\) \{\s*display: grid;/.test(band),
);
check(
  "...and the two default words are hidden, not removed: the seats keep their names",
  /:global\(html\[data-device="phone"\]\) \.bandbox\.idle \.lbl \{\s*display: none;/.test(band) &&
    /<span class="lbl">\{facts\.hidden\.label\}<\/span>/.test(band),
);
check(
  "no idle rule is drawn on a window",
  !/^  \.bandbox\.idle/m.test(band),
);

/* ---------------------------------------------------------------------------
 * 4. The title, said once.
 * ------------------------------------------------------------------------- */

check(
  "the bar names the article's pane in a word, not by repeating the headline",
  /\{#if depth !== 3\}\s*<span class="where" title=\{title\}>\{title\}<\/span>\s*\{\/if\}/.test(header),
);
check(
  "...and still names the stream at the posts depth",
  /const title = \$derived\.by\(\(\) => \{[\s\S]{0,200}?return depth === 3 \?/.test(header),
);
check(
  "the posts pane stops drawing that same title on a phone",
  /\{#if !nested && layout\.device !== "phone"\}[\s\S]{0,80}<h1>\{reader\.activeTitle\}<\/h1>/.test(list),
);
check(
  "the count, the feed's mark and the filters are not part of that",
  /class="meta"/.test(between(list, 'class="headline"', "</header>")) &&
    /class="mark"/.test(between(list, 'class="headline"', "</header>")),
);

/* ---------------------------------------------------------------------------
 * The guardrail: nothing above is written for a window.
 * ------------------------------------------------------------------------- */

check(
  "every phone rule is scoped to the phone",
  !/^\s*\.rail \{/m.test(band) && !/^\s*\.bandbox\.idle/m.test(band),
);
check(
  "and the desktop's own controls are unmoved",
  /class="indent-label"/.test(sidebar) && /<RowCurve \/>/.test(list) && /class="sizer"/.test(list),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
