/**
 * The article's own bar, at the bottom of the article.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/article-bar.mjs
 *
 * The owner's ask (2026-11-01): *"in article view the top bar for articles
 * (with font buttons, star, etc.) not for the whole app, should be at the
 * bottom instead with option to flip it so its at top".*
 *
 * Two things are asserted here. The preference: one value, both answers, saved
 * with the rest of the reading settings so a phone and a window agree. And the
 * parity contract: every control the bar carried at the top is still on it —
 * the move is a move, not a tidy-up that drops a button.
 *
 * Read as source, like `phone-density.mjs`. What it looks like — the bar under
 * the words, the article above it, the flip at the far right — is a
 * measurement in the running app (390×844), reported rather than asserted here.
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

const pane = read("src/components/ReaderPane.svelte");
const state = read("src/state/reading.svelte.ts");
const lib = read("src/lib/reading-layout.ts");

/* ---------------------------------------------------------------------------
 * 1. The preference: bottom by default, both answers valid, saved and pulled.
 * ------------------------------------------------------------------------- */

check(
  "the value is one of two, and nothing else",
  /export type ArticleBarSide = "top" \| "bottom";/.test(state) &&
    /export function isArticleBarSide\(value: unknown\): value is ArticleBarSide \{\s*return value === "top" \|\| value === "bottom";/.test(
      state,
    ),
);

check(
  "it starts at the bottom: that is the request, not a preference nobody set",
  /articleBar = \$state<ArticleBarSide>\("bottom"\)/.test(state) &&
    /private defaults\(\): void \{[\s\S]{0,200}?this\.articleBar = "bottom";/.test(state),
);

check(
  "it travels with the rest of the reading settings",
  /snapshot\(\): Record<string, unknown> \{[\s\S]{0,200}?articleBar: this\.articleBar,/.test(state) &&
    /if \(isArticleBarSide\(saved\.articleBar\)\) this\.articleBar = saved\.articleBar;/.test(state),
  "a corrupt value falls back rather than throwing",
);

check(
  "and there is exactly one way to flip it",
  /toggleArticleBar\(\): void \{\s*this\.articleBar = this\.articleBar === "bottom" \? "top" : "bottom";\s*this\.save\(\);/.test(
    state,
  ),
);

/* ---------------------------------------------------------------------------
 * 2. The pane: the same header, ordered last, with its edge turned round.
 * ------------------------------------------------------------------------- */

check(
  "the bar reads the preference once",
  /const barAtBottom = \$derived\(reading\.articleBar === "bottom"\);/.test(pane),
);

check(
  "the header is the same header, put last",
  /<header class="toolbar" class:floating=\{discOverBar\} class:bottom=\{barAtBottom\} bind:clientHeight=\{barHeight\}>/.test(
    pane,
  ) && /\.toolbar\.bottom \{[\s\S]{0,200}?order: 2;/.test(pane),
  "a second header would be a second set of controls",
);

check(
  "its border moves to the top, and the home indicator's inset comes with it",
  /\.toolbar\.bottom \{[\s\S]{0,260}?padding-bottom: max\(0px, env\(safe-area-inset-bottom\)\);[\s\S]{0,160}?border-top: 1px solid var\(--edge-soft\);[\s\S]{0,80}?border-bottom: 0;/.test(
    pane,
  ),
);

check(
  "a narrow column scrolls the bar rather than dropping a control",
  /overflow-x: auto;[\s\S]{0,40}?overflow-y: hidden;[\s\S]{0,40}?scrollbar-width: none;/.test(pane),
);

check(
  "the way out floats in the thumb's corner, not the top left",
  // Owner, 2026-11-02: "i want the floating back button where the floating
  // collapse button is on article view, bottom right, not top left". The numbers
  // are the unfolded feed's own collapse disc (`Sidebar.svelte` `.unfold-close`:
  // right 10, bottom 30 + the inset) so the two controls sit in one place.
  /\.float-back \{[\s\S]{0,400}?right: 10px;[\s\S]{0,120}?bottom: calc\(30px \+ var\(--safe-bottom, 0px\)\);/.test(
    pane,
  ) && !/top: 7px;/.test(pane),
);

check(
  "and it is lifted clear of the bar when the bar is at the bottom",
  // The bar is a full-width row and at the bottom by default; the disc would be
  // drawn over its right-hand controls. The height is the bar's own measured one
  // (`bind:clientHeight`), because it carries the home indicator's inset.
  /\.reader\.bar-bottom \.float-back \{\s*bottom: calc\(var\(--bar-h, 40px\) \+ 10px\);/.test(pane) &&
    /style:--bar-h=\{`\$\{barHeight\}px`\}/.test(pane) &&
    /class:bar-bottom=\{barAtBottom\}/.test(pane),
);

check(
  "the floating disc hides the bar's arrow while the disc is the way out",
  /const discOverBar = \$derived\(floatingBack && !barAtBottom\);/.test(pane) &&
    /\{#if !discOverBar\}\s*<button class="icon" onclick=\{\(\) => onClose\?\.\(\)\} aria-label="Back to list">←<\/button>/.test(
      pane,
    ),
  "at the bottom the bar keeps its own arrow, so the way out is never missing",
);

/* ---------------------------------------------------------------------------
 * 3. Parity: every control the bar had at the top is still on it.
 * ------------------------------------------------------------------------- */

const labels = [
  "Previous article",
  "Next article",
  "Smaller pictures",
  "Larger pictures",
  "Continue to the next article when scrolling past the end",
  "Open original",
  "Lock hidden categories and go to feeds",
];

for (const label of labels) {
  check(`the bar still carries "${label}"`, pane.includes(`aria-label="${label}"`));
}

check(
  "the extract control is still two answers, and experimental",
  /aria-label=\{showingArticle \? "Show what the feed sent" : "Load the full article"\}/.test(pane),
);

// The read mark is the post list's own glyph, not a second alphabet for one
// state: a hollow ring until the post is read, a tick inside it after. The
// toolbar used to say it with the text glyphs ● and ◯, which is why the two
// panes disagreed about what "read" looked like (owner's report).
check(
  "the read mark is one ring that gains a tick",
  (() => {
    const at = pane.indexOf('class="icon mark"');
    const button = pane.slice(at, pane.indexOf("</button>", at));
    return (
      at > 0 &&
      /<circle cx="8" cy="8" r="5\.4" \/>\{#if isRead\(item\)\}<path/.test(button) &&
      /d="M5\.2 8\.2l2 2 3\.6-3\.9"/.test(button) &&
      !/◯|●/.test(button)
    );
  })(),
);

check(
  "the star is still one button with two answers, in the Favourites vocabulary",
  /aria-label=\{isStarred\(item\) \? "Remove favourite" : "Add to favourites"\}/.test(pane) &&
    !/Remove star|Add star|"Starred" : "Star"/.test(pane),
);

check(
  "the bar still has one spacer, so the controls group as they did",
  (pane.match(/class="spacer"/g) ?? []).length === 1,
);

check(
  "the flip is the bar's own last control",
  (() => {
    const header = pane.slice(pane.indexOf('<header class="toolbar"'), pane.indexOf("</header>"));
    const side = header.indexOf('class="icon side"');
    const lock = header.indexOf('class="icon lock"');
    const lastButton = header.lastIndexOf("<button");
    return side > 0 && lock > 0 && side > lock && lastButton > lock && header.slice(lastButton).includes('class="icon side"');
  })(),
  "it moves to the other edge when pressed, so its place is the end it is not at",
);

check(
  "the flip says where the bar is going, not where it is",
  /aria-label=\{barAtBottom \? "Move the article bar to the top" : "Move the article bar to the bottom"\}/.test(pane) &&
    /onclick=\{\(\) => reading\.toggleArticleBar\(\)\}/.test(pane),
);

check(
  "the reading row's own source of truth is untouched",
  lib.length > 0 && !/articleBar/.test(lib),
  "the bar's placement is chrome, not layout arithmetic",
);

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
