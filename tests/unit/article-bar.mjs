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
  /<header class="toolbar" class:floating=\{discOverBar\} class:bottom=\{barAtBottom\}>/.test(pane) &&
    /\.toolbar\.bottom \{[\s\S]{0,200}?order: 2;/.test(pane),
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
  "the floating disc hides the bar's arrow only while they share a corner",
  /const discOverBar = \$derived\(floatingBack && !barAtBottom\);/.test(pane) &&
    /\{#if !discOverBar\}\s*<button class="icon" onclick=\{\(\) => onClose\?\.\(\)\} aria-label="Back to list">←<\/button>/.test(
      pane,
    ),
  "at the bottom the disc is at the other end, so the bar keeps its arrow",
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

check(
  "the star is still one button with two answers",
  /aria-label=\{isStarred\(item\) \? "Remove star" : "Add star"\}/.test(pane),
);

check(
  "the read mark is still two answers, not one",
  /\{isRead\(item\) \? "◯" : "●"\}/.test(pane),
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
