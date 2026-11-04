// Fullscreen pictures: the arithmetic, and the one place a tap changes meaning.
//
// The viewer must walk exactly what the list drew — the same filter, the same
// order — and must never invent a slide for a post with no picture. Those two
// rules are the whole of the pure part; the rest of this file checks that the
// component that draws it keeps them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLOSE_DRAG_PX,
  PREFETCH_RADIUS,
  SWIPE_STEP_PX,
  closesOnDrag,
  dragProgress,
  frameAt,
  frameIndex,
  framesOf,
  prefetchWindow,
  stepFrame,
  stepsForTravel,
  wrapIndex,
} from "../../src/lib/carousel.ts";

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

const posts = [
  { id: "a", url: "https://x/a.jpg" },
  { id: "b", url: null },
  { id: "c", url: "https://x/c.jpg" },
  { id: "d", url: "" },
  { id: "e", url: "https://x/e.jpg" },
];
const frames = framesOf(posts, (post) => post.url);

// --- what is in the walk
equal(frames.map((frame) => frame.id), ["a", "c", "e"], "only posts with a picture are frames");
check("a frame carries the post it came from", frames[0].item.id === "a");
check("a frame carries the picture's own address", frames[0].url === "https://x/a.jpg");
equal(framesOf([], (post) => post.url), [], "an empty list has no frames");
equal(
  framesOf(posts, () => null).length,
  0,
  "a list with no pictures at all is an empty carousel",
);

// --- index maths
equal(wrapIndex(0, 3), 0, "the first picture is 0");
equal(wrapIndex(2, 3), 2, "the last picture is count - 1");
equal(wrapIndex(3, 3), 0, "one past the last wraps to the first");
equal(wrapIndex(-1, 3), 2, "one before the first wraps to the last");
equal(wrapIndex(-4, 3), 2, "a long backwards swipe lands inside the list");
equal(wrapIndex(7, 3), 1, "a long forwards swipe lands inside the list");
equal(wrapIndex(4, 0), 0, "an empty carousel has no position, not NaN");
equal(wrapIndex(NaN, 3), 0, "a broken index is the first picture");

// --- finding the pressed picture
equal(frameIndex(frames, "c"), 1, "the pressed post is found by id");
equal(frameIndex(frames, "b"), -1, "a post with no picture is not in the walk");
equal(frameAt(frames, 1)?.id, "c", "a position gives its frame");
equal(frameAt(frames, 9)?.id, "a", "a position past the end wraps");
equal(frameAt([], 0), null, "no frames, no frame");

// --- stepping
equal(stepFrame(frames, 0, 1)?.frame.id, "c", "the next picture is drawn next");
equal(stepFrame(frames, 0, 1)?.index, 1, "and it reports where it sits");
equal(stepFrame(frames, 2, 1)?.frame.id, "a", "the last picture steps round to the first");
equal(stepFrame(frames, 0, -1)?.frame.id, "e", "the first picture steps back to the last");
equal(stepFrame(frames, 1, 0)?.frame.id, "c", "a step of nothing is the same picture");
equal(stepFrame([], 0, 1), null, "nothing to step to");

// --- the prefetch window
equal(
  prefetchWindow(frames, 0).map((frame) => frame.id),
  ["a", "c", "e"],
  "both sides of the first picture, nearest first, deduplicated when they meet",
);
equal(
  prefetchWindow(frames, 1).map((frame) => frame.id),
  ["c", "e", "a"],
  "the pressed picture is asked for first, then the next one, then the one behind",
);
equal(prefetchWindow(frames, 0, 0).map((frame) => frame.id), ["a"], "a radius of 0 is the one picture");
equal(
  prefetchWindow(frames, 1, 1).map((frame) => frame.id),
  ["c", "e", "a"],
  "a radius of 1 reaches one picture either way",
);
const long = Array.from({ length: 9 }, (_, at) => ({ id: `p${at}`, url: `https://x/${at}.jpg` }));
const longFrames = framesOf(long, (post) => post.url);
equal(
  prefetchWindow(longFrames, 4).map((frame) => frame.id),
  ["p4", "p5", "p3", "p6", "p2"],
  `a radius of ${PREFETCH_RADIUS} reaches that far either way, forwards first`,
);
check(
  "the window never repeats a picture",
  new Set(prefetchWindow(longFrames, 0).map((frame) => frame.id)).size ===
    prefetchWindow(longFrames, 0).length,
);
equal(prefetchWindow([], 0), [], "nothing to prefetch in an empty carousel");

// --- dismissal by dragging down
equal(dragProgress(0), 0, "no travel is no dismissal");
equal(dragProgress(CLOSE_DRAG_PX / 2), 0.5, "half the distance is half the fade");
equal(dragProgress(CLOSE_DRAG_PX), 1, "the full distance is fully faded");
equal(dragProgress(CLOSE_DRAG_PX * 4), 1, "a longer drag does not over-fade");
equal(dragProgress(-120), 0, "dragging up is not a dismissal");
equal(dragProgress(NaN), 0, "a broken travel is no travel");
check("just short does not close", closesOnDrag(CLOSE_DRAG_PX - 1) === false);
check("the distance closes", closesOnDrag(CLOSE_DRAG_PX) === true);
check("a longer drag closes", closesOnDrag(CLOSE_DRAG_PX * 3) === true);

// --- swiping sideways
equal(SWIPE_STEP_PX > 0, true, "a step is a real distance");
equal(stepsForTravel(SWIPE_STEP_PX), 1, "one step is one step");
equal(stepsForTravel(SWIPE_STEP_PX * 2 + 5), 2, "two steps are two steps");
equal(stepsForTravel(-SWIPE_STEP_PX * 3), 3, "the direction is the caller's, not the count's");
equal(stepsForTravel(SWIPE_STEP_PX - 1), 0, "a drag short of a step moves nothing");
equal(stepsForTravel(NaN), 0, "a broken swipe moves nothing");

// --- the places that draw and listen for it
const viewer = read("src/components/ImageViewer.svelte");
const list = read("src/components/ArticleList.svelte");
const main = read("src/views/Main.svelte");
const store = read("src/state/carousel.svelte.ts");

check("the viewer is mounted once, above the panes", /<ImageViewer\s*\/>/.test(main));
check(
  "the picture is contained, not cropped",
  /object-fit:\s*contain/.test(viewer),
);
check(
  "the controls sit inside the phone's bottom inset",
  /env\(safe-area-inset-bottom/.test(viewer),
);
check("Escape closes it", /event\.key === "Escape"/.test(viewer));
check("the arrow keys walk it", /ArrowRight/.test(viewer) && /ArrowLeft/.test(viewer));
check("a downward drag closes it", /closesOnDrag|CLOSE_DRAG_PX/.test(viewer));
check(
  "it asks for the neighbours before they are seen",
  /carousel\.warm\(\)/.test(viewer) && /prefetchWindow/.test(store),
);
check("it stars through the reader the list used", /toggleStar\(/.test(viewer));
check("it marks read through the same reader", /setRead\(/.test(viewer));
check("reduced motion turns the sliding off", /prefers-reduced-motion/.test(viewer));
check(
  "a body-appended overlay removes itself on a timer, never on transitionend",
  !/transitionend/.test(viewer),
);
check(
  "the grid's tap opens the viewer instead of the post",
  /view === "grid" && openPictures\(item\)/.test(list) && /carousel\.show\(store, frames/.test(list),
);
check(
  "and the viewer walks this list's posts through this list's reader",
  /const items = store\.listItems/.test(list),
);
check(
  "and a long press still opens the post, so nothing is lost",
  /LongPressTracker/.test(list) && /openedByTap/.test(list),
);
check(
  "the carousel walks the list as drawn",
  /reader\.listItems|store\.listItems/.test(list),
);
check("the store keeps one session at a time", /session\s*=\s*\$state/.test(store));

if (failures > 0) {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`${checks} checks, 0 failure(s)`);
