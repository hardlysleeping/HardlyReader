/**
 * Headless checks for the context-menu primitives.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/context-menu.mjs
 *
 * No DOM, no timers, no GUI: the long-press delay is driven through the `Timer`
 * seam, and the rest is pure functions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseState } from "../../src/api/hardlyread.ts";
import {
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE_PX,
  LongPressTracker,
  anchorForRect,
  armsLongPress,
  categoryMenu,
  feedMenu,
  isMenuKey,
  placeMenu,
} from "../../src/lib/contextmenu.ts";

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** A clock whose timers only fire when the test says so. */
function clock() {
  let next = 1;
  const jobs = new Map();
  return {
    timers: {
      set(callback, ms) {
        const handle = next++;
        jobs.set(handle, { callback, ms });
        return handle;
      },
      clear(handle) {
        jobs.delete(handle);
      },
    },
    get pending() {
      return jobs.size;
    },
    get delays() {
      return [...jobs.values()].map((job) => job.ms);
    },
    fireAll() {
      const due = [...jobs.values()];
      jobs.clear();
      for (const job of due) job.callback();
    },
  };
}

function touch(x, y, pointerType = "touch") {
  return { pointerType, clientX: x, clientY: y };
}

/* ---------------------------------------------------------------------------
 * Long press
 * ------------------------------------------------------------------------- */

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);

  check("touch arms the tracker", tracker.start(touch(10, 20)) === true && tracker.armed);
  check("the delay is 500 ms", time.delays[0] === LONG_PRESS_MS, String(time.delays[0]));
  check("nothing fires before the delay", fired.length === 0);

  time.fireAll();
  check("the press fires once, at the pointer position", fired.length === 1);
  check("it fires where the finger went down", fired[0].x === 10 && fired[0].y === 20);
  check("a fired press is no longer armed", tracker.armed === false);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  const armed = tracker.start(touch(100, 100, "mouse"));
  check("a mouse never arms", armed === false && tracker.armed === false && time.pending === 0);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  tracker.start(touch(100, 100, "pen"));
  check("a pen arms too", tracker.armed === true);
  time.fireAll();
  check("pen press fires", fired.length === 1);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  tracker.start(touch(100, 100));
  tracker.move(touch(100 + LONG_PRESS_TOLERANCE_PX, 100));
  check("drift inside the tolerance stays armed", tracker.armed === true, `moved ${LONG_PRESS_TOLERANCE_PX}px`);
  time.fireAll();
  check("...and still fires", fired.length === 1);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  tracker.start(touch(100, 100));
  tracker.move(touch(100, 100 + LONG_PRESS_TOLERANCE_PX + 1));
  check("a drag cancels the press", tracker.armed === false && time.pending === 0);
  time.fireAll();
  check("a cancelled press never fires", fired.length === 0);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  tracker.start(touch(100, 100));
  tracker.cancel();
  check("lifting before the delay cancels", tracker.armed === false && time.pending === 0);
  time.fireAll();
  check("a cancelled press never fires", fired.length === 0);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers);
  tracker.start(touch(1, 1));
  tracker.start(touch(2, 2));
  check("a second pointerdown replaces the first", time.pending === 1, `${time.pending} timer(s)`);
  time.fireAll();
  check("only the newer position fires", fired.length === 1 && fired[0].x === 2);
}

{
  const fired = [];
  const time = clock();
  const tracker = new LongPressTracker((point) => fired.push(point), time.timers, 700, 20);
  tracker.start(touch(5, 5));
  check("the delay and tolerance are configurable", time.delays[0] === 700);
  tracker.move(touch(20, 5));
  check("the configured tolerance is honoured", tracker.armed === true);
  tracker.move(touch(30, 5));
  check("...and cancels past it", tracker.armed === false);
}

check("armsLongPress accepts touch", armsLongPress("touch") === true);
check("armsLongPress accepts pen", armsLongPress("pen") === true);
check("armsLongPress rejects mouse", armsLongPress("mouse") === false);
check("armsLongPress rejects an empty pointerType", armsLongPress("") === false);

/* ---------------------------------------------------------------------------
 * Keyboard trigger
 * ------------------------------------------------------------------------- */

{
  const key = (key, shiftKey = false) => ({ key, shiftKey });
  check("Shift+F10 opens the menu", isMenuKey(key("F10", true)) === true);
  check("F10 alone does not", isMenuKey(key("F10")) === false);
  check("the context-menu key opens it", isMenuKey(key("ContextMenu")) === true);
  check("the legacy Apps key opens it", isMenuKey(key("Apps")) === true);
  check("Shift+F11 does not", isMenuKey(key("F11", true)) === false);
  check("a bare Enter does not", isMenuKey(key("Enter")) === false);
}

{
  const anchor = anchorForRect({ left: 40, top: 100, bottom: 128 });
  check("a keyboard menu hangs under the row", anchor.y === 128, String(anchor.y));
  check("...inset from the row's left edge", anchor.x === 52, String(anchor.x));
}

/* ---------------------------------------------------------------------------
 * Placement
 * ------------------------------------------------------------------------- */

{
  const placed = placeMenu({ x: 100, y: 100 }, { width: 200, height: 300 }, { width: 1000, height: 800 });
  check("a menu with room stays at the anchor", placed.x === 100 && placed.y === 100, JSON.stringify(placed));
}

{
  const placed = placeMenu({ x: 950, y: 100 }, { width: 200, height: 300 }, { width: 1000, height: 800 });
  check("near the right edge it flips to the left of the anchor", placed.x === 750, JSON.stringify(placed));
  check("the flip leaves it fully on screen", placed.x + 200 <= 1000 - 8 + 0.001);
}

{
  const placed = placeMenu({ x: 100, y: 780 }, { width: 200, height: 300 }, { width: 1000, height: 800 });
  check("near the bottom it flips above the anchor", placed.y === 480, JSON.stringify(placed));
}

{
  const placed = placeMenu({ x: 5, y: 5 }, { width: 200, height: 300 }, { width: 1000, height: 800 });
  check("it never sits closer than the margin to the edge", placed.x === 8 && placed.y === 8, JSON.stringify(placed));
}

{
  const placed = placeMenu({ x: 950, y: 780 }, { width: 500, height: 900 }, { width: 1000, height: 800 });
  check("a menu taller than the window starts at the top margin", placed.y === 8, JSON.stringify(placed));
  check("an oversized menu still fits horizontally", placed.x >= 8 && placed.x + 500 <= 992, JSON.stringify(placed));
}

/* ---------------------------------------------------------------------------
 * Menu model
 * ------------------------------------------------------------------------- */

function state(overrides = {}) {
  return parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [12],
    locked: false,
    categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ],
    ...overrides,
  });
}

{
  const menu = categoryMenu(state(), "Technology", false);
  check("a shown row says Show", menu.toggle.label === "Show", menu.toggle.label);
  check("Show asks the server for hidden:false", menu.toggle.action.type === "hidden" && menu.toggle.action.hidden === false);
  check("Show is enabled when the category is known", menu.toggle.disabled === false);
  check("the menu is titled with the category", menu.label === "Technology");
  check("no note when everything is usable", menu.note === null, String(menu.note));
}

{
  const menu = categoryMenu(state(), "Art", false);
  check("a hidden-capable row says Hide", menu.toggle.label === "Hide", menu.toggle.label);
  check("Hide asks the server for hidden:true", menu.toggle.action.hidden === true);
}

{
  const menu = categoryMenu(state(), "Uncategorized", false);
  check("an unknown category cannot be toggled", menu.toggle.disabled === true);
  check("...and the note says why", /no id/.test(menu.note ?? ""), String(menu.note));
  check("...but it can still be marked", menu.pin.disabled === false);
}

{
  const menu = categoryMenu(parseState({ available: false }), "Technology", false);
  check("without Hidden Categories the hide item is still there", menu.toggle !== null);
  check("...but disabled, because there is nowhere to write", menu.toggle.disabled === true);
  check("...and the note says why", /not answering/.test(menu.note ?? ""), menu.note ?? "");
  check("...the mark is still offered, kept on this device", menu.pin !== null && menu.pin.disabled === false && menu.pin.action.type === "pin");
  // The note is the whole reason the row can stay: without it, a disabled Hide
  // would look like a bug rather than a fact about the server.
  check("...and the reason is in the note, not left to guesswork", /not answering/.test(menu.note ?? ""), String(menu.note));
}

{
  // Views do not belong in a row menu: revealing hidden rows from a row menu
  // defeats hiding them. They live on the sidebar band.
  const menu = categoryMenu(state(), "Technology", false);
  check("a category menu offers no view entries", !("views" in menu));
  check("an unmarked category offers Pin", menu.pin.label === "Pin" && menu.pin.action.pinned === true);
  check("a marked category offers Unpin", categoryMenu(state(), "Technology", true).pin.label === "Unpin");
  check("Unpin asks for pinned:false", categoryMenu(state(), "Technology", true).pin.action.pinned === false);
  // One mark, one word, one glyph: the menu says "pin" for a category and for a
  // feed, and the row does not invent a second vocabulary for the same fact.
  check("a category and a feed use the same glyph", menu.pin.glyph === feedMenu("Ars Technica").pin?.glyph);
  check("nothing in the model is called a favorite", !("favorite" in menu) && !("favorite" in feedMenu("Ars Technica")));
}

{
  const menu = categoryMenu(state({ view: "revealed", effectiveView: "hidden", locked: true }), "Technology", false);
  check("a locked extension is announced", /locked/.test(menu.note ?? ""), String(menu.note));
  check("locked items stay clickable so the server can answer", menu.toggle.disabled === false);
}

{
  const menu = feedMenu("Ars Technica", false, false);
  check("a feed can be pinned", menu.pin?.label === "Pin");
  check("a pinned feed can be unpinned", feedMenu("Ars Technica", false, true).pin?.label === "Unpin");
  check("confirming a removal hides the pin item", feedMenu("Ars Technica", true, false).pin === null);
  check("the menu model has no indent field at all", !("indent" in menu));
}

/* ---------------------------------------------------------------------------
 * What the menu may reach for
 *
 * The menu is a FreshRSS client first. Removal is the GReader API's own
 * `subscription/edit`; a feed pin never leaves this device; a category pin is
 * kept here when the extension is absent. Only hide and pin cross into an
 * extension, and they have to: `subscription/list` drops every feed at
 * priority <= -10 without returning that priority, so a hidden category is not
 * in the API at all and its id is the extension's to give.
 * ------------------------------------------------------------------------- */

{
  const missing = categoryMenu(state({ available: false }), "Technology", false);
  check("with no extension the hide item is still shown", missing.toggle !== null && missing.toggle.label === "Hide");
  check("with no extension the hide item cannot be used", missing.toggle.disabled === true);
  check("with no extension the reason is stated", /not answering/.test(missing.note ?? ""));
  check("with no extension the pin still works, kept on this device", missing.pin.disabled === false && missing.pin.action.type === "pin");
}

{
  const menu = feedMenu("Ars Technica", false, false);
  check("a feed row offers nothing that needs an extension", menu.toggle === null && menu.pin !== null && menu.remove !== null);
}

/* ---------------------------------------------------------------------------
 * Where a feed's text comes from
 *
 * One question per feed, three answers, and the model is where the words live:
 * the component draws whatever it is handed, so the labels and the ticked one
 * are checked here rather than by looking at markup.
 * ------------------------------------------------------------------------- */

{
  const menu = feedMenu("Ars Technica", false);
  check("a fresh feed answers Auto", menu.fullText.length === 3 && menu.fullText[0].label === "Auto");
  check("the three answers are in one order", menu.fullText.map((item) => item.label).join(",") === "Auto,Feed,Full webpage");
  check("each answer carries its own action", menu.fullText.map((item) => item.action.type).join(",") === "full-text,full-text,full-text");
  check("and its own answer in the action", menu.fullText.map((item) => item.action.mode).join(",") === "auto,feed,article");
  check("exactly one is ticked", menu.fullText.filter((item) => item.checked).length === 1);
  check("and it is the feed's answer", menu.fullText[0].checked === true);

  const told = feedMenu("Ars Technica", false, false, "article");
  check("a feed told Full webpage ticks that one", told.fullText[2].checked === true && told.fullText[0].checked === false);
  check("nothing here is disabled: it never needs a server", told.fullText.every((item) => !item.disabled));

  const truncating = feedMenu("Ars Technica", false, false, "auto", true);
  check("Auto says what it will do for a feed that truncates", /cuts its posts short/.test(truncating.fullText[0].hint ?? ""));
  check("and for one it has seen send whole posts", !/cuts its posts short/.test(menu.fullText[0].hint ?? ""));
  check("the two absolute answers say what they fetch", /nothing is fetched/.test(menu.fullText[1].hint ?? "") && /fetch/i.test(menu.fullText[2].hint ?? ""));

  const confirming = feedMenu("Ars Technica", true);
  check("a removal being confirmed asks nothing else", confirming.fullText.length === 0);
}

{
  const menu = categoryMenu(state(), "Technology", false);
  check("a category has no full-text answer of its own", menu.fullText.length === 0);
}

{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  const removeFeed = source.slice(source.indexOf("async removeFeed("));
  check(
    "removing a feed is a library call, not an extension one",
    /backend\.unsubscribe\(streamId\)/.test(removeFeed.slice(0, 900)),
    "removeFeed should hand the stream id to the library backend",
  );
  check(
    "removing a feed is not routed through the adapter",
    !/hardlyread/i.test(removeFeed.slice(0, 900)),
  );
}


{
  // The row menu draws one mark, with one glyph. Two glyphs for one state read
  // as two different facts, which is how a pin starts to look like a favourite.
  const component = readFileSync(new URL("../../src/components/CategoryMenu.svelte", import.meta.url), "utf8");
  check("the menu draws one mark glyph", (component.match(/class="pin-glyph"/g) ?? []).length === 1);
  check("and it has no second mark symbol", !/🔖/.test(component));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
