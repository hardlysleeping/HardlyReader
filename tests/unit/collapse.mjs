/**
 * The fold in the two-pane frame: the chip in the feeds seam that collapses it,
 * the rail it leaves behind, and the pair that is drawn in the meantime.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/collapse.mjs
 *
 * `panes.mjs` owns the arithmetic (the folded template's five tracks and the
 * slot map in every state); this suite is about the wiring that arithmetic
 * cannot show — that the control is a real button on the seam rather than the
 * seam's hit area, that it is invisible until the seam is in use, that the rail
 * is drawn without being hovered for and can be reached from the keyboard, and
 * that neither of them asks the window to change size. Two things are asserted
 * as properties rather than as strings where they can be: the seam geometry the
 * chrome depends on, and the empty article pane the pair depends on.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUTTER, RAIL, gridTemplate, paneSlots } from "../../src/lib/panes.ts";

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

const main = read("src/views/Main.svelte");
const gutter = read("src/components/PaneGutter.svelte");
const layout = read("src/state/layout.svelte.ts");
const readerPane = read("src/components/ReaderPane.svelte");

/** The markup of one element's body: from its opening tag to the first close. */
function slice(source, opener, closer = "</div>") {
  const start = source.indexOf(opener);
  if (start < 0) return "";
  const end = source.indexOf(closer, start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

/** The body of one method in the state class, up to the brace at indent 2. */
function method(source, name) {
  const start = source.indexOf(`${name}(`);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  return source.slice(open, source.indexOf("\n  }", open));
}

// ---------------------------------------------------------------------------
// Two panes, not one. The fold hides pane 1; the frame it leaves still shows the
// posts and the article, side by side, with the rail in the seam's place.
{
  const slots = paneSlots({ mode: 2, level: "article", stacked: false, collapsed: true, tuck: null, swapped: false });
  const drawn = ["sidebar", "seam", "posts", "article"].filter((slot) => slots[slot]);
  check(
    "a folded two-pane frame draws two panes, not one",
    drawn.length === 2 && slots.posts && slots.article,
    drawn.join("+"),
  );
  check("its seams are the pair's, not the feeds'", slots.seamPosts && !slots.seam && !slots.seamStack);
  check("and the feeds are hidden rather than removed from the slot map", slots.sidebar === false);

  const template = gridTemplate(2, { sidebar: 300, list: 400 }, { available: 1100, collapsed: true });
  const tracks = template.split(/\s+/).map((track) => Number(track.replace("px", "")));
  check("the folded frame is five tracks", tracks.length === 5, template);
  check("the rail is the first thing in it, at 6px", tracks[0] === 0 && tracks[1] === RAIL && RAIL === 6);
  check("with both panes drawn after it", tracks[2] > 0 && tracks[4] > 0, template);
  check(
    "four of the five tracks are in use: rail, posts, seam, article",
    tracks.filter((value) => value > 0).length === 4,
    template,
  );
  check(
    "and they are the frame, not more than the frame",
    Math.abs(tracks.reduce((sum, value) => sum + value, 0) - 1100) < 0.02,
    String(tracks.reduce((sum, value) => sum + value, 0)),
  );
  check(
    "the pair's own seam is the gutter, like every other seam",
    tracks[3] === GUTTER,
    String(tracks[3]),
  );
  check(
    "and the fold is the same frame under Keep widths and Keep window",
    gridTemplate(2, { sidebar: 300, list: 400 }, { available: 1100, collapsed: true, keepWidths: false }) === template,
  );
}

// ---------------------------------------------------------------------------
// The chip in the feeds seam: a real button, beside the separator, invisible
// until the seam is in use so that the drag surface is still a drag surface.
{
  check(
    "the seam takes an optional fold, off by default",
    /fold = false,/.test(gutter) && /fold\?: boolean/.test(gutter),
  );
  check(
    "the chip exists only when the fold is offered",
    /\{#if fold\}[\s\S]{0,700}?class="fold-bar"/.test(gutter),
  );
  const bar = slice(gutter, 'class="fold-bar"');
  check("it is one button on a chip", (bar.match(/<button\b/g) ?? []).length === 1, String((bar.match(/<button\b/g) ?? []).length));
  check("a real button that cannot submit a form", /<button\s+type="button"/.test(bar));
  check(
    "named as a group so the chip reads as a control, not as the seam",
    /class="fold-bar" role="group" aria-label="Feeds pane"/.test(gutter),
  );
  check(
    "titled and labelled with what it does",
    /title="Collapse the feeds pane"/.test(bar) && /aria-label="Collapse the feeds pane"/.test(bar),
  );
  check("it points left, toward the pane it folds away", /M10 3\.5 5\.5 8 10 12\.5/.test(bar));
  check("and it is wired to the one fold there is", /onclick=\{\(\) => layout\.toggleSidebar\(\)\}/.test(bar));
  check(
    "the chip is the only fold control in the component",
    (gutter.match(/layout\.toggleSidebar\(\)/g) ?? []).length === 1,
    String((gutter.match(/layout\.toggleSidebar\(\)/g) ?? []).length),
  );

  // The seam's separator is the drag surface, and a button inside a widget role
  // would both vanish for a screen reader and take the drag with it.
  const separator = gutter.indexOf('class="gutter"');
  const separatorEnd = gutter.indexOf("</div>", gutter.indexOf('class="line"'));
  const inside = separator < 0 ? "<missing>" : gutter.slice(separator, separatorEnd);
  check(
    "the chip is beside the separator, not inside its hit area",
    separator > 0 && separatorEnd > separator && !inside.includes("<button"),
  );

  // Hidden until used, and hidden means not clickable: an invisible control over
  // the middle of a 6px seam would eat the drags that start there.
  const barCss = slice(gutter.slice(gutter.indexOf(".fold-bar {")), ".fold-bar {", "}");
  check("the chip is undrawn until the seam is used", /opacity: 0;/.test(barCss), barCss.replace(/\s+/g, " "));
  check("and takes no pointer events while it is", /pointer-events: none;/.test(barCss));
  check(
    "it appears when the seam is hovered or focused, and only then becomes pressable",
    /\.seam:hover \.fold-bar,\s*\.seam:focus-within \.fold-bar \{\s*opacity: 1;\s*pointer-events: auto;\s*\}/.test(gutter),
  );
  check(
    "so the seam's own drag handlers still start where the chip is not",
    /\{onpointerdown\}/.test(gutter) && !/onpointerdown/.test(bar),
  );
}

// ---------------------------------------------------------------------------
// The rail: what the folded feeds leave behind.
{
  const rail = slice(main, 'class="slot rail"', "</div>");
  check(
    "the rail is a slot of the one grid, hidden rather than removed",
    /class="slot rail" class:away=\{!slots\.rail\}/.test(main),
  );
  check("it is not rendered behind an {#if}", !/\{#if slots\.rail\}/.test(main));
  check("with a real button in it", (rail.match(/<button\b/g) ?? []).length === 1 && /<button\s+type="button"/.test(rail));
  check(
    "titled what it does: show the feeds pane",
    /title="Show the feeds pane"/.test(rail) && /aria-label="Show the feeds pane"/.test(rail),
  );
  check("pointing right, back toward the pane it restores", /M2 1\.5 6 6l-4 4\.5/.test(rail));
  check("wired to the same fold", /onclick=\{\(\) => layout\.toggleSidebar\(\)\}/.test(rail));
  check(
    "reachable by keyboard: a button, not a tabindex of minus one",
    /<button\s+type="button"/.test(rail) && !/tabindex="-1"/.test(rail),
  );

  // Visible to be found. A 6px strip that only appears on hover is a strip nobody
  // finds, so the strip itself is painted and the hover only strengthens it.
  const css = slice(main.slice(main.indexOf(".restore {")), ".restore {", "}");
  check(
    "the strip is painted without hovering: the button fills the rail",
    /width: 100%;/.test(css) && /height: 100%;/.test(css) && /background: color-mix\(in srgb, var\(--surface\) 70%, var\(--bg\)\);/.test(css),
    css.replace(/\s+/g, " "),
  );
  check("and it is not gated on a hover to be drawn at all", !/opacity: 0;/.test(css));
  check(
    "it strengthens on hover and on focus",
    /\.restore:hover,\s*\.restore:focus-visible \{[\s\S]{0,160}?color: var\(--text\);/.test(main),
  );
  check(
    "with a focus ring, so the keyboard can see where it is",
    /\.restore:focus-visible \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: -2px;\s*\}/.test(main),
  );
  check(
    "the rail stands in the seam's track, at the left edge of the frame",
    /\.slot\.rail \{\s*grid-column: 2 \/ 3;\s*grid-row: 1 \/ -1;\s*\}/.test(main),
  );
}

// ---------------------------------------------------------------------------
// Where the pair sits, and what tells the frame to draw it.
{
  check(
    "the frame is marked when it is the folded pair",
    /class:folded=\{mode === 2 && folded\}/.test(main),
  );
  check(
    "the article moves out of the posts column into the fifth track",
    /\.panes\.two\.folded \.slot\.article \{\s*grid-column: 5 \/ 6;\s*\}/.test(main),
  );
  check(
    "the posts keep the third track they always occupy",
    /\.panes\.two \.slot\.posts,\s*\.panes\.two \.slot\.article \{\s*grid-column: 3 \/ 4;\s*\}/.test(main),
  );
  check(
    // The seam is its own slot, drawn when the slot map says so — and away while
    // the posts column is reading in place, because the page it would split from
    // is over the list rather than beside it.
    "and the seam between them is their own slot",
    /class="slot seam-x gut-posts" class:away=\{!slots\.seamPosts\}/.test(main),
  );
  check(
    "the fold is offered to the seam in two panes only, and not once folded",
    /<PaneGutter which="sidebar" fold=\{mode === 2 && !folded\} \/>/.test(main),
  );
  check(
    "the flag the frame and the slot map share is the stored preference",
    /const folded = \$derived\(mode >= 2 && layout\.sidebarCollapsed\);/.test(main),
  );
  check(
    "the tracks are drawn from that same flag",
    /const columns = \$derived\(\s*gridTemplate\(mode, layout\.shown, \{[\s\S]{0,560}?collapsed: folded,/.test(main) &&
      /style:grid-template-columns=\{columns\}/.test(main),
  );
}

// ---------------------------------------------------------------------------
// Nothing else moves: the fold is a change inside the frame, never of it, and
// the three-pane fold and the stack keep their own controls.
{
  check(
    "nothing in the view fits the window: the fold happens inside the frame",
    !/from "\.\.\/lib\/window-fit"/.test(main) && !/fitWindowTo\s*\(/.test(main),
  );
  check("nor does the seam", !/fitWindowTo\s*\(/.test(gutter) && !/window-fit/.test(gutter));
  const toggle = method(layout, "toggleSidebar");
  check(
    "the fold itself writes one flag and nothing else",
    /this\.sidebarCollapsed = !this\.sidebarCollapsed;/.test(toggle) && !/fitWindowTo/.test(toggle),
    toggle.replace(/\s+/g, " "),
  );
  check(
    "it leaves the dragged widths alone",
    !/this\.panes\s*=/.test(toggle) && !/this\.write\(/.test(toggle),
  );
  check(
    "two call sites in the view: the header's fold and the rail, and nothing else",
    (main.match(/layout\.toggleSidebar\(\)/g) ?? []).length === 2,
    String((main.match(/layout\.toggleSidebar\(\)/g) ?? []).length),
  );
  check(
    "the three-pane fold stays in the header, where it was",
    // Three panes fold the feeds; a split is a different family and has no fold
    // to offer, so the button is the three-pane header's alone.
    /\{#if mode === 3 && !split\.active\}\s*<button\s+class="fold"/.test(main) &&
      /ontogglesidebar=\{showFeeds\}/.test(main),
  );
  check(
    "the stacked pair keeps its own three controls, untouched by the fold",
    (gutter.match(/class="ctl-bar"/g) ?? []).length === 1 &&
      // Two tuck buttons while both panes are there, and one more press — the
      // labelled way back — for when one of them is not.
      (gutter.match(/layout\.tuckStack\(/g) ?? []).length === 3 &&
      (gutter.match(/layout\.toggleStackSwap\(\)/g) ?? []).length === 1,
  );
  check(
    "and the one rows string still drives every arrangement",
    (main.match(/style:grid-template-rows=/g) ?? []).length === 1,
  );
  check(
    "mode 3's fold still draws the stack alone, unchanged by the rail",
    gridTemplate(3, { sidebar: 300, list: 400 }, { available: 1100, stacked: true, collapsed: true }) ===
      "0px 0px 1100px 0px 0px",
  );
}

// ---------------------------------------------------------------------------
// The article with nothing open: an honest empty state, which is what keeps the
// collapsed pair reading as two panes rather than as a list and a blank.
{
  const placeholder = slice(readerPane, '<div class="placeholder"', "</div>");
  check("the empty article says so", /<p>Select an article\.<\/p>/.test(placeholder), placeholder.replace(/\s+/g, " "));
  check(
    "and fills the pane it is drawn in, so the column reads as a pane",
    /\.placeholder \{\s*display: grid;\s*place-items: center;\s*height: 100%;\s*\}/.test(readerPane),
  );
  check(
    "with the pane's own name on it, which the fold does not change",
    /data-pane="article" aria-label="Article"/.test(readerPane),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
