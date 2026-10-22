/**
 * Headless checks for the context-menu primitives.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/context-menu.mjs
 *
 * No DOM, no timers, no GUI: the long-press delay is driven through the `Timer`
 * seam, and the rest is pure functions.
 */
import { parseState } from "../../src/api/hardlyread.ts";
import {
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE_PX,
  LongPressTracker,
  anchorForRect,
  armsLongPress,
  categoryMenu,
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
  const menu = categoryMenu(state(), "Technology");
  check("a shown row says Show", menu.toggle.label === "Show", menu.toggle.label);
  check("Show asks the server for hidden:false", menu.toggle.action.type === "hidden" && menu.toggle.action.hidden === false);
  check("Show is enabled when the category is known", menu.toggle.disabled === false);
  check("the menu is titled with the category", menu.label === "Technology");
  check("no note when everything is usable", menu.note === null, String(menu.note));
}

{
  const menu = categoryMenu(state(), "Art");
  check("a hidden-capable row says Hide", menu.toggle.label === "Hide", menu.toggle.label);
  check("Hide asks the server for hidden:true", menu.toggle.action.hidden === true);
}

{
  const menu = categoryMenu(state(), "Uncategorized");
  check("an unknown category cannot be toggled", menu.toggle.disabled === true);
  check("...and the note says why", /no id/.test(menu.note ?? ""), String(menu.note));
  check("the views are still offered", menu.views.length === 3 && menu.views.every((item) => item.disabled === false));
}

{
  const menu = categoryMenu(parseState({ available: false }), "Technology");
  check("without the extension nothing is usable", menu.toggle.disabled === true && menu.views.every((item) => item.disabled === true));
  check("...and the note says so", /not available/.test(menu.note ?? ""), String(menu.note));
  check("...and no view is ticked", menu.views.every((item) => item.checked === false));
}

{
  const menu = categoryMenu(state(), "Technology");
  check("the view selector uses the extension's three words", menu.views.map((item) => item.label).join(",") === "Hidden,Revealed,Only", menu.views.map((item) => item.label).join(","));
  check("the applied view is ticked", menu.views.filter((item) => item.checked).map((item) => item.label).join(",") === "Hidden");
  check("view items carry the view value", menu.views[1].action.type === "view" && menu.views[1].action.view === "revealed");
}

{
  const menu = categoryMenu(state({ view: "revealed", effectiveView: "hidden", locked: true }), "Technology");
  check("a locked extension is announced", /locked/.test(menu.note ?? ""), String(menu.note));
  check("the tick follows effectiveView while locked", menu.views.filter((item) => item.checked).map((item) => item.label).join(",") === "Hidden");
  check("locked items stay clickable so the server can answer", menu.views.every((item) => item.disabled === false));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
