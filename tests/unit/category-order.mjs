/**
 * Checks for the category arrangement: the list is local, per account, and a
 * reorder sends nothing.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/category-order.mjs
 *
 * Two halves. The maths lives in `feed-order.mjs` (`arrangeByPins` is already
 * covered there against real group data); what is checked here is the wiring:
 * that the reader keeps the list, that it survives a restart, that signing out
 * forgets it, and that dragging a category never reaches the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { arrangeByPins } from "../../src/state/pins.ts";
import { isNoopDrop, moveInOrder } from "../../src/lib/feed-order.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${detail})`}`);
  }
}

const root = new URL("../../", import.meta.url);
const state = readFileSync(new URL("src/state/reader.svelte.ts", root), "utf8");
const pins = readFileSync(new URL("src/state/pins.ts", root), "utf8");
const sidebar = readFileSync(new URL("src/components/Sidebar.svelte", root), "utf8");
const drag = readFileSync(new URL("src/lib/feed-drag.ts", root), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

check("the reader holds a category order", /categoryOrder = \$state<string\[\]>\(\[\]\)/.test(state));
check(
  "it is read back from the account's prefs",
  /const categoryOrder = raw\?\.categoryOrder;[\s\S]{0,200}this\.categoryOrder = /.test(state),
);
check("and written with them", /categoryOrder: this\.categoryOrder,/.test(state));
check(
  "a corrupt payload starts the list empty rather than throwing",
  /catch \{[\s\S]{0,300}this\.categoryOrder = \[\];/.test(state),
);
check("signing out forgets it", /this\.feedOrder = \[\];\s*this\.categoryOrder = \[\];/.test(state));
check(
  "the sidebar's order is the one arrangeByPins reads",
  /\(id\) => this\.isFeedPinned\(id\),\s*this\.feedOrder,\s*this\.categoryOrder,/.test(state),
);

// The arrange path: local only. Nothing to send, so no transport, no await, no
// rollback — and no seeding from the drawn order (the pinned band outranks it).
const arrange = state.slice(state.indexOf("arrangeCategory("), state.indexOf("arrangeCategory(") + 1400);
check("arranging a category touches no transport", !/transport|await |fetch\(/.test(arrange));
check("it writes the preference immediately", /this\.savePrefs\(\);/.test(arrange));
check("it records the move in the order list", /moveInOrder\(seeded/.test(arrange));
check(
  "the first drag seeds from what is drawn, so a drop at the end lands last",
  /this\.categoryOrder\.length > 0\s*\? this\.categoryOrder\s*: this\.categories\.map/.test(flat(arrange)),
);
check(
  "and the drawn order it seeds from is the pin-filtered one, not every category",
  !/allCategories/.test(arrange),
);

// The precedence contract, stated once with real data.
const groups = [
  { id: "user/-/label/Art", label: "Art", feeds: [] },
  { id: "user/-/label/Tech", label: "Tech", feeds: [] },
  { id: "user/-/label/Design", label: "Design", feeds: [] },
];
const order = moveInOrder([], "user/-/label/Design", "user/-/label/Art");
check(
  "a dragged category lands before the one it was dropped on",
  JSON.stringify(arrangeByPins(groups, "all", () => false, () => false, [], order).map((g) => g.label)) ===
    JSON.stringify(["Design", "Art", "Tech"]),
);
check(
  "the same drag twice is a no-op, not a second entry",
  isNoopDrop(order, "user/-/label/Design", "user/-/label/Art"),
);

// The sidebar: a second drag instance, its own attributes, and the click guard
// that keeps a reorder from also folding the group.
check("the sidebar runs a second drag for categories", /const categoryDrag = createFeedDrag\(/.test(sidebar));
check(
  "armed from the category row's own press",
  /onCategoryPointerDown[\s\S]{0,300}categoryDrag\.arm\(event, category\.id\)/.test(sidebar),
);
check(
  "the row carries its id and the next id",
  /data-drop-cat-row=\{category\.id\}/.test(sidebar) &&
    /data-drop-cat-next=\{reader\.categories\[index \+ 1\]\?\.id \?\? null\}/.test(sidebar),
);
check(
  "a click that ends a drag does not also fold the group",
  /if \(categoryDrag\.justDropped\(\)\) return;/.test(sidebar),
);
check("the dragged feed still files into the category it is dropped on", /data-drop-cat=\{category\.label\}/.test(sidebar));
check("the drop module takes the attribute names as options", /rowAttr: "data-drop-cat-row"/.test(sidebar));
check(
  "and it resolves a block of feeds to the folder it belongs to, never into it",
  /sectionAttr/.test(drag) && /data-cat-section=\{category\.id\}/.test(sidebar),
);
check(
  "the block's own halves are read, so the slot below a category is reachable",
  /lowerHalf && options\.sectionNextAttr !== undefined/.test(flat(drag)),
);
check(
  "the block carries the id of the block after it",
  /sectionNextAttr: "data-cat-next"/.test(sidebar) &&
    /data-cat-next=\{reader\.categories\[index \+ 1\]\?\.id \?\? null\}/.test(flat(sidebar)),
);
check(
  "the last slot draws its own line, since no row below it can",
  /drop-cat-end/.test(sidebar),
);


// Seeding then dropping at the end: the reason the list is seeded at all.
const drawn = ["user/-/label/Art", "user/-/label/Tech", "user/-/label/Design"];
const ended = moveInOrder(drawn, "user/-/label/Art", null);
check(
  "a category dropped at the end is drawn last, not first",
  JSON.stringify(
    arrangeByPins(groups, "all", () => false, () => false, [], ended).map((g) => g.label),
  ) === JSON.stringify(["Tech", "Design", "Art"]),
);

// A category is a feed. FreshRSS labels are streams, so the category's name opens
// every post in every feed under it — and it still folds and unfolds the group,
// which is what the name did before there was anything else to do with it.
check(
  "the category's name opens its own stream and still folds the group",
  /if \(!inlinePosts\) \{\s*toggle\(category\.id\);\s*openCategory\(category\);\s*return;\s*\}/.test(
    sidebar,
  ),
);
check(
  "and the click is the one the row calls",
  /onclick=\{\(\) => clickCategory\(category, folded\)\}/.test(sidebar) &&
    !/onclick=\{\(\) => \{[\s\S]{0,120}toggle\(category\.id\);/.test(sidebar),
);
// One panel is the exception: the list is the screen there, so a tap that both
// opened a stream and folded a group would do one of them by accident. The first
// tap picks the category, the next one on the same category opens it.
check(
  "one panel needs the second tap before the posts change",
  /if \(pickedCategory !== category\.id\) \{\s*pickedCategory = category\.id;\s*if \(folded\) toggle\(category\.id\);\s*return;\s*\}/.test(
    sidebar,
  ) &&
    /if \(openStreamId !== category\.id\) \{\s*if \(folded\) toggle\(category\.id\);\s*openCategory\(category\);\s*return;\s*\}/.test(
      sidebar,
    ),
);
check(
  "and a tap on the category that is already open folds it, as it always did",
  /\n    toggle\(category\.id\);\n  \}/.test(sidebar),
);
// A double tap is one gesture, not two taps that undo each other. On a window
// the pair used to toggle twice and land back where it started; in one panel the
// posts were fetched behind a sidebar that never moved.
check(
  "a double tap on a category opens its posts",
  /const doubled = lastCategoryTap\.id === category\.id && now - lastCategoryTap\.at < DOUBLE_TAP_MS/.test(
    sidebar,
  ) &&
    /if \(doubled\) \{[\s\S]{0,400}?if \(folded\) toggle\(category\.id\);\s*openCategory\(category\);/.test(
      sidebar,
    ),
);
check(
  "...and does not fold the group it just opened",
  /if \(doubled\) \{[\s\S]{0,400}?return;\s*\}/.test(sidebar) &&
    sidebar.indexOf("if (doubled)") < sidebar.indexOf("if (!inlinePosts) {\n      toggle"),
);
check(
  "...and one panel is shown the posts, since its sidebar does not move",
  /if \(inlinePosts\) mobileNav\.show\(2\)/.test(sidebar),
);
check(
  "the double-tap window is a phone's own",
  /const DOUBLE_TAP_MS = 320/.test(sidebar),
);

check(
  "the count button still opens the same stream",
  /onclick=\{\(\) => openCategory\(category\)\}/.test(sidebar),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
