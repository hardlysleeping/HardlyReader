/**
 * The one-column walk: two levels, a crumb strip that only exists where there is
 * somewhere to go back to, and the phone's stacked pair.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/one-pane.mjs
 *
 * The walk's arithmetic lives in `src/lib/one-pane.ts` and is pressed here for
 * real. The surface itself is one grid now, so the crumb strip sits outside it
 * as a flex sibling rather than as a reserved row: the grid's four tracks are
 * the same with a strip and without one, and the strip is drawn only below the
 * feeds. The stacked phone is the same grid as the desktop stack — same slots,
 * same rows string, same handlers — which is what the last block checks.
 */
import { readFileSync } from "node:fs";

import { backLabel, levelOf, stepBackTarget, whereLabel } from "../../src/lib/one-pane.ts";
import { paneSlots } from "../../src/lib/panes.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// One column has two levels. A feed unfolds its posts where it sits, so there is
// no posts screen and nothing may pretend there is one.
check("the feed list is the feeds level", levelOf(null) === "feeds");
check("an open article is the article level", levelOf("item/42") === "article");

// Back is one step, never a jump.
check("back from an article closes it", stepBackTarget("article") === "close-article");
check("back from feeds has nowhere to go", stepBackTarget("feeds") === null);

// Walking in and back out, one level at a time.
let level = levelOf(null);
const walk = [level];
level = levelOf("item/7");
walk.push(level);
for (let press = 0; press < 1; press += 1) {
  level = stepBackTarget(level) === "close-article" ? "feeds" : "feeds";
  walk.push(level);
}
check("the walk is feeds then article then feeds", walk.join(">") === "feeds>article>feeds", walk.join(">"));

// What the bar says.
check("at feeds it says Feeds", whereLabel("feeds", "Ars", null) === "Feeds");
check("at an article it names feed and post", whereLabel("article", "Ars", "Big news") === "Ars › Big news");
check("a missing article title falls back to the feed", whereLabel("article", "Ars", null) === "Ars");
check("the back tooltip names the destination", backLabel("article", "Ars") === "Back to Ars");
check("back at the root is honest about it", backLabel("feeds", "Ars") === "Already at feeds");

// Collapsing is not a crop: one column starts at its first pane, the feeds.
// Shrinking the window while an article was open used to leave that article
// alone on screen — the second pane's content on the surface whose first pane
// is the feeds.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(join(root, "src/views/Main.svelte"), "utf8");
const layout = readFileSync(join(root, "src/state/layout.svelte.ts"), "utf8");

check(
  "landing on one pane closes the article",
  /if \(now === 1 \|\| now === 2\) reader\.closeReader\(\)/.test(main),
);
check(
  "and on two as well, so the second column is the posts, not the open article",
  /now === 2\) reader\.closeReader\(\)/.test(main),
);
check(
  "and it is the transition that decides, not the width at render",
  /let drawn = layout\.mode;[\s\S]{0,200}\$effect/.test(main),
);
check("the drawn mode is state, so it can remember what it was", /mode = \$state<PaneMode>\(1\)/.test(layout));
check("a threshold change is banded", /setThreshold[\s\S]{0,1600}this\.settle\(\);/.test(layout));
// The panes are the source of truth: every path that moves one re-derives the
// thresholds, so the settings panel cannot disagree with the layout.
check("a drag re-derives the thresholds", /dragTo\([\s\S]{0,900}this\.syncThresholds\(\);/.test(layout));
check("commit trims the requirement to the window", /commit\(\)[\s\S]{0,300}settleRequirement/.test(layout));
check("the drawn widths come from the panes", /get shown\(\)[\s\S]{0,200}layoutWidths\(this\.panes, this\.mode\)/.test(layout));
check("two and three keep separate posts widths", /this\.mode === 3 \? "list3" : "list2"/.test(layout));
check("only the one-pane width is saved as a threshold", /thresholds: \{ one: this\.thresholds\.one \}/.test(layout));
check(
  "a measurement that repeats the last one answers nothing",
  /const sameWidth = px === this\.available;/.test(layout) &&
    /if \(sameWidth && sameHeight && this\.pressTarget === null\) return;/.test(layout),
);
check("a resize is banded", /setAvailable[\s\S]{0,3000}this\.settle\(\);/.test(layout));
// Except the one resize the user asked for by pressing a mode: that must answer
// at once, or "3" would grow the window and still show two panes.
check(
  "but a resize answering a mode press is not banded",
  /if \(Date\.now\(\) < this\.pressUntil\)[\s\S]{0,300}this\.settle\(false\)/.test(layout),
);
// Armed before the resize travels: the observer can report the new width while
// the call is still in flight, and a banded answer would undo the press.
check(
  "a press arms the answer before the resize is asked for",
  /this\.pressUntil = Date\.now\(\) \+ PRESS_GRACE_MS;[\s\S]{0,700}fitWindowTo\(target\)/.test(layout),
);
// Two presses in flight are answered in order, so the window cannot keep the
// width of a press that was superseded.
check(
  "a press waits for the resize before it",
  /const ask = this\.resizing\.then\(\(\) => fitWindowTo\(target\)\)/.test(layout),
);
// Pane one is one number: the slider writes the sidebar, and the threshold is
// read back from it, so a dragged divider and the settings panel agree. The
// fourth argument is the arrangement — three columns and a stack need different
// windows, so the threshold cannot be derived without it.
check(
  "the one-pane threshold comes from the sidebar",
  /thresholdsFor\(this\.panes, this\.device, this\.panes\.sidebar,/.test(layout),
);
check("a choice is not", /setMode[\s\S]{0,600}this\.settle\(false\);/.test(layout));

// Arrow keys are shaped like the panes: Right goes in a column, Left comes back
// out one, and Up/Down belong to whichever pane is in hand.
check(
  "Left closes the article before it gives up a pane",
  /case "back":[\s\S]{0,700}if \(reader\.back\(\)\) return;/.test(main),
);
check(
  "Left with nothing open drops a column",
  /if \(reader\.back\(\)\) return;[\s\S]{0,700}layout\.collapseOne\(\);/.test(main),
);
check(
  "a column collapse never resizes the window",
  /collapseOne\(\): boolean \{[\s\S]{0,400}this\.setMode/.test(layout) &&
    !/collapseOne\(\): boolean \{[\s\S]{0,400}fitWindowTo/.test(layout),
);
check("Left stops at one pane", /collapseOne\(\): boolean \{[\s\S]{0,200}return false;/.test(layout));
check(
  "Down in the posts pane steps the post, not the feed",
  /case "stream":[\s\S]{0,700}reader\.selectedId !== null[\s\S]{0,200}reader\.stepItem\(intent\.delta\)/.test(main),
);
check("with no post open they still step the feed", /case "stream":[\s\S]{0,1000}reader\.stepStream\(intent\.delta\)/.test(main));

// Pressing 3 from two panes extends the columns on screen; it does not divide
// the window they were already sharing.
check(
  "pressing 3 from two panes extends instead of re-dividing",
  /chooseMode\(mode: PaneMode\)[\s\S]{0,1400}extendToThree\(this\.panes, this\.available/.test(layout),
);
// Only when it has to: a window already wide enough for its three columns keeps
// them, so 2 ↔ 3 does not grow the window a little on every press.
// Only when it has to, and only for a layout that is fitting the window to its
// panes: sharing the room, the frames squeeze and the window is never grown to
// make space for the third column.
check(
  "and only when the window is too narrow for them",
  /mode === 3 &&[\s\S]{0,120}this\.mode === 2 &&[\s\S]{0,120}this\.keepWidths &&[\s\S]{0,120}this\.available < this\.thresholds\.three/.test(
    layout,
  ),
);

// The crumb strip belongs to the levels that have somewhere to go back to. On
// the feeds surface both buttons were dead, and the 34px it took came out of a
// column that on a phone has no 34px to spare. It sits outside the pane grid, so
// the grid never has a row that appears and disappears: with no strip it is the
// whole height, with one it is what the strip left.
check(
  "the crumb strip is not drawn on the feeds surface",
  /\{#if mode === 1 && level !== "feeds"\}\s*<nav class="crumbs"/.test(main),
);
check(
  "and it is not a row of the grid, so it cannot resize the panes",
  main.indexOf('class="crumbs"') < main.indexOf('class="panes"') && !/crumbed/.test(main),
);
check(
  "the surface takes the whole height when there is no strip",
  (() => {
    const panes = /\.panes \{([\s\S]*?)\n  \}/.exec(main)?.[1] ?? "";
    const crumbs = /\.crumbs \{([\s\S]*?)\n  \}/.exec(main)?.[1] ?? "";
    return (
      /\.main \{[\s\S]{0,200}display: flex;[\s\S]{0,120}flex-direction: column;/.test(main) &&
      /flex: 1;/.test(panes) &&
      /min-height: 0;/.test(panes) &&
      /flex: none;/.test(crumbs)
    );
  })(),
);
check(
  "the strip follows the level, not a stored flag",
  /const level = \$derived\(levelOf\(reader\.selectedId\)\)/.test(main) &&
    !/layout\.[a-zA-Z]*[Cc]rumb/.test(main),
);

// With the stack on, the phone's second and third panes are one surface: the
// posts on top and the article below, arriving together out of the feed list.
// That is one level of the walk, not two — which is why `level` gained no new
// value and back still leaves everything it brought. The surface is one grid, so
// "one surface" is now `paneSlots` saying both panes are drawn at once.
check(
  "one column never stacks: a post opened there is the whole pane",
  (() => {
    const pair = paneSlots({ mode: 1, level: "article", stacked: true, collapsed: false, tuck: null, swapped: false });
    return pair.article && !pair.posts && !pair.seamStack && !pair.sidebar;
  })(),
);
check(
  "and the feeds level still starts the walk from the feed list",
  (() => {
    const feeds = paneSlots({ mode: 1, level: "feeds", stacked: true, collapsed: false, tuck: null, swapped: false });
    return feeds.sidebar && !feeds.posts && !feeds.article && !feeds.seamStack;
  })(),
);
check(
  "and back from it leaves the whole surface, one level",
  /const stackDrawn = \$derived\(layout\.stacked && mode === 3\)/.test(
    main,
  ) &&
    /<ReaderPane onClose=\{closeArticle\} onLock=\{mode === 1 \? lockFromArticle : undefined\} \/>/.test(main) &&
    /function closeArticle\(\): void \{\s*if \(mode === 1\) stepBack\(\);/.test(main),
);
check(
  "the walk still has two levels, so the crumb names the surface once",
  /export type OnePaneLevel = "feeds" \| "article";/.test(
    readFileSync(join(root, "src/lib/one-pane.ts"), "utf8"),
  ),
);
check(
  "with the stack off the phone is what it was: one pane, no posts beside it",
  (() => {
    const flat = paneSlots({ mode: 1, level: "article", stacked: false, collapsed: false, tuck: null, swapped: false });
    return flat.article && !flat.posts && !flat.seamStack && !flat.sidebar;
  })(),
);
// The list, in one column, with a post open: a drawer over the page rather than a
// second pane. Pulled down from the top edge, pushed back up, one press each.
check(
  "and the list is a drawer over the open post, not a pane beside it",
  /const drawer = \$derived\(mode === 1 && level === "article"\);/.test(main) &&
    /if \(drawer\) return \{ \.\.\.drawn, posts: true, article: true \};/.test(main) &&
    /class:drawer[\s\S]{0,80}?class:pulled=\{drawer && \(pulled \|\| dragging\)\}/.test(main),
);
check(
  "the drawer is the list's own box: it animates its height, and the page keeps its size",
  /\.panes\.one \.slot\.posts\.drawer \{[\s\S]{0,400}?height: 0;[\s\S]{0,400}?background: var\(--bg\);[\s\S]{0,400}?transition:\s*height var\(--slide-ms/.test(main) &&
    /\.panes\.one \.slot\.posts\.drawer\.pulled \{[\s\S]{0,200}?height: var\(--sheet-h\);/.test(main) &&
    /\.panes\.one \{\s*--sheet-h: min\(62%, 560px\);/.test(main) &&
    /grid-column: 1 \/ -1;\s*\n\s*grid-row: 1 \/ -1;/.test(main),
);
check(
  "the pull is one tab on the drawer's edge, in the same language as the tuck's tab",
  /class="grab"/.test(main) &&
    /aria-label=\{pulled \? "Put the post list back up" : "Pull the post list down"\}/.test(main) &&
    /aria-expanded=\{pulled\}/.test(main) &&
    /\.panes\.one \.grab \{[\s\S]{0,300}?width: 44px;[\s\S]{0,80}?height: 24px;/.test(main) &&
    /\.panes\.one \.grab\.down \{\s*top: var\(--sheet-h\);/.test(main),
);
check(
  "it hangs off the frame, not off a slot, so a slide cannot restretch it",
  /<\/div>\n\n    \{#if drawer\}/.test(main) &&
    !/\.slot\.article \.grab/.test(main),
);
check(
  "choosing a post puts it back up: choosing is the end of browsing",
  /<ArticleList onOpen=\{\(\) => \(pulled = false\)\} \/>/.test(main),
);
check(
  "and back, and escape, put it up before they leave the article",
  (main.match(/if \(pulled\) \{\n\s*pulled = false;\n\s*return;\n\s*\}/g) ?? []).length === 1 &&
    /case "escape":\s*\n\s*if \(pulled\) \{/.test(main),
);
check(
  "the page underneath dims rather than disappears, and a press on it is the press back",
  /\.panes\.one \.scrim \{[\s\S]{0,120}?inset: var\(--sheet-h\) 0 0;/.test(main) &&
    /<div class="scrim" role="presentation" onclick=\{\(\) => \(pulled = false\)\}><\/div>/.test(main),
);
check(
  "while it is up the list is out of the tab order and out of reach",
  /inert=\{drawer && !pulled\}/.test(main),
);
// A press slides the drawer and a phone closes one with a thumb: the same edge
// takes a drag, follows the finger, and lets go into the nearest half — or the way
// it was thrown, because a flick is how a drawer actually gets shut.
check(
  "the drawer's edge can be dragged, not only pressed",
  /onpointerdown=\{grabDown\}/.test(main) &&
    /onpointermove=\{grabMove\}/.test(main) &&
    /onpointerup=\{grabUp\}/.test(main) &&
    /onpointercancel=\{grabCancel\}/.test(main) &&
    /\.panes\.one \.grab \{[\s\S]{0,200}?touch-action: none;/.test(main),
);
check(
  "and the sheet follows the finger instead of jumping to an end",
  /let dragH = \$state<number \| null>\(null\);/.test(main) &&
    /style:height=\{dragH === null \? null : `\$\{dragH\}px`\}/.test(main) &&
    /style:top=\{dragH === null \? null : `\$\{dragH\}px`\}/.test(main) &&
    /style:transition-duration=\{dragging \? "0ms" : null\}/.test(main) &&
    /dragMaxH = Math\.min\(frame\.clientHeight \* 0\.62, 560\);/.test(main),
);
check(
  "a drag is not also a press, and a press is still a press",
  /if \(dragMoved\) \{\s*dragMoved = false;\s*return;\s*\}\s*pulled = !pulled;/.test(main) &&
    /if \(Math\.abs\(event\.clientY - dragFromY\) > 4\) dragMoved = true;/.test(main),
);
check(
  "and letting go is nearest half, unless it was thrown",
  /const thrown = Math\.abs\(dragSpeed\) > 0\.5 \? dragSpeed > 0 : null;/.test(main) &&
    /pulled = thrown === null \? height > dragMaxH \* 0\.42 : thrown;/.test(main),
);
check(
  "the height goes back to the stylesheet after the release, so it slides",
  /requestAnimationFrame\(\(\) => \{\s*if \(!dragging\) dragH = null;\s*\}\);/.test(main),
);
check(
  "and the drag is view state: nothing about it is stored",
  !/dragH/.test(layout) &&
    !/dragH/.test(readFileSync(join(root, "src/state/reading.svelte.ts"), "utf8")),
);
check(
  "and a tuck left over from three panes is dropped with the mode that owned it",
  /if \(mode !== 3 && this\.stackTuck !== null\) this\.stackTuck = null;/.test(layout),
);
// The fold is a two- and three-pane thing. One column has nothing behind it to
// fold into, so the stored preference is ignored here: no rail, no pair, and the
// walk is exactly what it was.
check(
  "one column has nothing to fold, so the flag draws no rail and no pair",
  [true, false].every((collapsed) => {
    const feeds = paneSlots({ mode: 1, level: "feeds", stacked: false, collapsed, tuck: null, swapped: false });
    const article = paneSlots({ mode: 1, level: "article", stacked: false, collapsed, tuck: null, swapped: false });
    return (
      feeds.sidebar &&
      !feeds.rail &&
      article.article &&
      !article.rail &&
      !article.posts &&
      !article.sidebar
    );
  }),
);
check(
  "and the same rows string drives both surfaces",
  (main.match(/style:grid-template-rows=/g) ?? []).length === 1 &&
    /style:grid-template-rows=\{layout\.rows\(stackDrawn\)\}/.test(main) &&
    /rows\(drawnStack: boolean\): string \{[\s\S]{0,140}return stackTemplate\(this\.stacked \? this\.stackShare : STACK_SHARE\.fallback\);/.test(
      layout,
    ),
  String((main.match(/style:grid-template-rows=/g) ?? []).length),
);

// The cards read their wheel against a port, and nested there is no port here.
// In one column the posts hang under the feed row with `overflow: visible`, so
// the sidebar's feed box is what scrolls. Measuring `itemsEl` there measured the
// whole column as a pane as tall as its content: every card "fit", the wheel
// claimed the delta for a step, and the step was written to an element that
// cannot scroll — the wheel did nothing at all while the drag, which moves the
// sidebar itself, still worked.
const listSrc = readFileSync(join(root, "src/components/ArticleList.svelte"), "utf8");
check(
  "the nested list looks for the box that really scrolls",
  /function scrollPort\(\): HTMLElement \| null \{[\s\S]{0,900}?if \(el === null \|\| !nested\) return el;/.test(listSrc) &&
    /for \(let p = el\.parentElement; p !== null; p = p\.parentElement\)/.test(listSrc) &&
    /overflowY !== "auto" && overflowY !== "scroll"/.test(listSrc),
);
check(
  "and every card measurement and the wheel use it",
  ["currentCard", "cardFits", "centreCard", "onListWheel"].every((fn) =>
    new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,160}?const el = scrollPort\\(\\)`).test(listSrc),
  ),
);
check(
  "and the drag stays the sidebar's, not a card step",
  /function onPanDown\(event: PointerEvent\): void \{\s*\/\/[\s\S]{0,220}?if \(nested\) return;/.test(listSrc) &&
    /if \(nested \|\| view !== "cards"/.test(listSrc),
);
check(
  "and the middle card is read from the box that moved",
  /if \(outer !== null\) outer\.addEventListener\("scroll", onPortScroll/.test(listSrc) &&
    /if \(outer !== null\) outer\.removeEventListener\("scroll", onPortScroll\);/.test(listSrc),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
