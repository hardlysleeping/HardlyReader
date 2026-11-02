// Gesture settings: what a saved record may say, and that Off is not a synonym
// for "ignore it".
//
// The interesting failures are the quiet ones: a corrupt record that silently
// turns everything back on, a pull that still has its listeners on the node, a
// long press that writes a number nobody honours. Each is checked here against
// the source that has to keep the promise.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  GESTURE_DEFAULTS,
  LONG_PRESS_CHOICES,
  PULL_ACTIONS,
  PULL_LABELS,
  isLongPressMs,
  isPullAction,
  parseGestures,
  pullLabels,
} from "../../src/lib/gestures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function equal(actual, expected, name) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${actual} ≠ ${expected}`);
}

// --- the defaults are today's behaviour
equal(GESTURE_DEFAULTS.paneSwipe, true, "the pane swipe is on, because it always was");
equal(GESTURE_DEFAULTS.pull, "check", "a pull still checks for new posts");
equal(GESTURE_DEFAULTS.dragScroll, true, "drag-to-scroll is on");
equal(GESTURE_DEFAULTS.longPressMs, 500, "a long press is still half a second");
equal(LONG_PRESS_CHOICES, [300, 400, 500], "three press lengths are offered");
equal(PULL_ACTIONS, ["check", "off"], "the pull has two answers");

// --- a record that says something valid is read back
equal(
  parseGestures({ paneSwipe: false, pull: "off", dragScroll: false, longPressMs: 300 }),
  { paneSwipe: false, pull: "off", dragScroll: false, longPressMs: 300 },
  "a whole record survives",
);

// --- a record that says something else takes the default for that row only
equal(parseGestures(null), GESTURE_DEFAULTS, "nothing saved is the defaults");
equal(parseGestures(undefined), GESTURE_DEFAULTS, "an absent record is the defaults");
equal(parseGestures("nonsense"), GESTURE_DEFAULTS, "a string is not a record");
equal(parseGestures([]), GESTURE_DEFAULTS, "an array is not a record");
equal(
  parseGestures({ paneSwipe: "no" }).paneSwipe,
  true,
  "a non-boolean switch falls back to its default",
);
equal(parseGestures({ pull: "refresh" }).pull, "check", "an unknown pull answer is the default");
equal(parseGestures({ longPressMs: 250 }).longPressMs, 500, "a press length nobody offers is the default");
equal(parseGestures({ longPressMs: "500" }).longPressMs, 500, "a stringified number is not a number");
const mixed = parseGestures({ paneSwipe: false, longPressMs: 1200 });
equal(
  mixed,
  { paneSwipe: false, pull: "check", dragScroll: true, longPressMs: 500 },
  "one bad row does not undo the good ones, and a corrupt record does not turn things back on",
);

// --- the predicates
check("check is a pull answer", isPullAction("check") === true);
check("off is a pull answer", isPullAction("off") === true);
check("back is not", isPullAction("back") === false);
check("a number is not", isPullAction(3) === false);
check("300 is a press length", isLongPressMs(300) === true);
check("340 is not", isLongPressMs(340) === false);
check("NaN is not", isLongPressMs(Number.NaN) === false);

// --- the words the capsule shows
equal(pullLabels("check").label, "Pull down to check for new posts", "the pull says what it will do");
equal(pullLabels("check").ready, "Release to check for new posts", "and what letting go does");
equal(pullLabels("off"), { label: "", ready: "" }, "off has nothing to say, because it does not happen");
check("every answer has a label", PULL_ACTIONS.every((action) => PULL_LABELS[action].length > 0));

// --- the storage seam
const prefs = read("src/lib/chrome-prefs.ts");
check("the record lives in the chrome key", /gestures: GesturePrefs/.test(prefs));
check("and is read defensively", /gestures: parseGestures\(saved\.gestures\)/.test(prefs));
check("and written whole", /writeGestures[\s\S]{0,200}?gestures: parseGestures\(value\)/.test(prefs));
const store = read("src/state/chrome.svelte.ts");
check("the store loads it with the rest", /this\.gestures = readGestures\(/.test(store));
check("and writes one row at a time", /setGesture<K extends keyof GesturePrefs>/.test(store));

// --- one row per gesture, and each handler reads it
const panel = read("src/components/GesturesPanel.svelte");
check("the panel writes through the store", /chrome\.setGesture\(/.test(panel));
check("the panel hides the phone rows off a phone", /layout\.device === "phone"/.test(panel));
check("drag-to-scroll is a row", /"dragScroll"/.test(panel));
check("the pane swipe is a row", /"paneSwipe"/.test(panel));

const stack = read("src/components/MobilePaneStack.svelte");
check(
  "the pane swipe does not arm while it is off",
  /if \(!chrome\.gestures\.paneSwipe\) \{[\s\S]{0,120}?swipe = null;[\s\S]{0,40}?return;/.test(stack),
);

const pull = read("src/lib/pull.ts");
check("a pull can be told to exist or not", /active\?: \(\) => boolean/.test(pull));
check("and Off removes the listeners", /if \(next\.active\?\.\(\) === false\) detach\(\);/.test(pull));
check("nothing is attached when it starts off", /if \(opts\.active\?\.\(\) !== false\) attach\(\);/.test(pull));

const list = read("src/components/ArticleList.svelte");
check(
  "the list passes the answer to the action",
  /active: \(\) => chrome\.gestures\.pull !== "off"/.test(list),
);
check("and the press delay", /chrome\.gestures\.longPressMs/.test(list));

const app = read("src/App.svelte");
check(
  "drag-to-scroll is installed by an effect, so Off returns its teardown",
  /\$effect\(\(\) => \{[\s\S]{0,160}?if \(!chrome\.gestures\.dragScroll\) return;[\s\S]{0,80}?return installDragScroll\(\);/.test(
    app,
  ),
);
check("and no longer installed once for the whole app", !/^installDragScroll\(\);$/m.test(read("src/main.ts")));

const sidebar = read("src/components/Sidebar.svelte");
check(
  "the sidebar's menu reads the press length",
  /holdMs: \(\) => chrome\.gestures\.longPressMs/.test(sidebar),
);
check(
  "and the menu's own timer uses the same number",
  /realTimers,\s*\/\/[^]*?chrome\.gestures\.longPressMs,/.test(sidebar),
);

const drag = read("src/lib/feed-drag.ts");
check("the drag's hold is the reader's delay", /handlers\.holdMs\?\.\(\) \?\? TOUCH_HOLD/.test(drag));

const settings = read("src/components/SettingsPanel.svelte");
check("the section is in the list", /id: "gestures"/.test(settings));
check("and it is mounted", /<GesturesPanel \/>/.test(settings));

if (failures > 0) {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`${checks} checks, 0 failure(s)`);
