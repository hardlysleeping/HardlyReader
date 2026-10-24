/**
 * Checks for the app's own feed arrangement.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feed-order.mjs
 *
 * The rules that survived a real drag were measured in a browser harness with
 * real mouse events and a stubbed server (move Design→Tech sent
 * `ac=edit&s=feed/1&a=…Tech&r=…Design`, the list repainted before the call
 * returned, a 500 put the feed back and restored the order, and a reorder sent
 * nothing at all). What is checked here is the maths under it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  beforeAfter,
  isNoopDrop,
  moveInOrder,
  orderIndex,
  sortByOrder,
} from "../../src/lib/feed-order.ts";

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const feeds = [{ id: "feed/1" }, { id: "feed/2" }, { id: "feed/3" }];

check("an ordered feed has its index", orderIndex(["feed/2", "feed/1"], "feed/1") === 1);
check("an unordered feed sorts last", orderIndex(["feed/2"], "feed/1") === Number.POSITIVE_INFINITY);

check("no arrangement leaves the list as it was", same(sortByOrder(feeds, []), feeds));
check(
  "the arrangement wins over the base order",
  same(sortByOrder(feeds, ["feed/3", "feed/1", "feed/2"]).map((f) => f.id), ["feed/3", "feed/1", "feed/2"]),
);
check(
  "feeds never dragged keep their base order at the end",
  same(sortByOrder(feeds, ["feed/3"]).map((f) => f.id), ["feed/3", "feed/1", "feed/2"]),
);
check("sorting does not mutate the input", same(feeds.map((f) => f.id), ["feed/1", "feed/2", "feed/3"]));

check("moving before an id inserts there", same(moveInOrder(["feed/1", "feed/2", "feed/3"], "feed/3", "feed/1"), ["feed/3", "feed/1", "feed/2"]));
check("moving before nothing appends", same(moveInOrder(["feed/1", "feed/2", "feed/3"], "feed/1", null), ["feed/2", "feed/3", "feed/1"]));
check("moving an id out of its old place leaves no duplicate", same(moveInOrder(["feed/1", "feed/2"], "feed/1", "feed/2"), ["feed/1", "feed/2"]));
check("an unknown anchor appends rather than losing the feed", same(moveInOrder(["feed/1"], "feed/2", "feed/9"), ["feed/1", "feed/2"]));

check("after a row is the next row", beforeAfter(["feed/1", "feed/2", "feed/3"], "feed/2") === "feed/3");
check("after the last row is the end", beforeAfter(["feed/1", "feed/2"], "feed/2") === null);

check("nothing changes when the drop is where it already sits", isNoopDrop(["feed/1", "feed/2"], "feed/1", "feed/2"));
check("dropping a feed on itself changes nothing", isNoopDrop(["feed/1", "feed/2"], "feed/1", "feed/1"));
check("a real move is not a no-op", !isNoopDrop(["feed/1", "feed/2"], "feed/2", "feed/1"));
check("dropping to the end of the list is a move when it is not last", !isNoopDrop(["feed/1", "feed/2"], "feed/1", null));

// The sidebar draws the arrangement, so it has to reach both places the list is
// built: the groups and the pin bands that re-sort them.
{
  const pins = readFileSync(new URL("../../src/state/pins.ts", import.meta.url), "utf8");
  const state = readFileSync(new URL("../../src/state/reader.svelte.ts", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../../src/components/Sidebar.svelte", import.meta.url), "utf8");
  const drag = readFileSync(new URL("../../src/lib/feed-drag.ts", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../src/api/freshrss.ts", import.meta.url), "utf8");

  check("the pin arrangement takes the dragged order", /order: readonly string\[\] = \[\]/.test(pins));
  check("and keeps pinned feeds above it", /isFeedPinned\(b\.id\)\) - Number\(isFeedPinned\(a\.id\)\)/.test(pins.replace(/\s+/g, " ")));
  check("the sidebar passes the order through", /this\.feedOrder,\s*\)/.test(state));
  check("a row is a drop target and carries the next id", /data-drop-feed=\{feed\.id\}/.test(sidebar) && /data-drop-next=\{category\.feeds\[index \+ 1\]\?\.id \?\? null\}/.test(sidebar));
  check("a category header is a drop target too", /data-drop-cat=\{category\.label\}/.test(sidebar));
  check("rows do not pan while being dragged", /data-no-drag-scroll/.test(sidebar));
  check("a drag does not open the feed it ends on", /if \(feedDrag\.justDropped\(\)\) return;/.test(sidebar));
  check("the drop is resolved from what is under the pointer", /elementFromPoint/.test(drag));
  check("the upper and lower half mean different slots", /lowerHalf \? \(row\.dataset\.dropNext/.test(drag));
  check("a row dropped on itself is not a move", /landedOnSelf/.test(drag));
  check("escape cancels a drag", /event\.key === "Escape"/.test(drag));
  check("a finger scrolls instead of filing", /event\.pointerType === "touch"/.test(drag));
  check("a category move is a real server edit", /ac: "edit"/.test(api) && /subscription\/edit/.test(api));
  check(
    "Uncategorized is the absence of a label, sent by removing the old one only",
    /if \(to !== null && to !== ""\)/.test(api) && /if \(from !== null && from !== "" && from !== to\)/.test(api),
  );
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
