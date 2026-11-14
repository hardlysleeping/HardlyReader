// Which feeds get kept for offline, and what that costs.
//
// The arithmetic is pure on purpose: it decides how much of someone else's server
// this app spends on a copy nobody has asked to see yet, so the numbers have to be
// testable with a Map and a clock rather than a browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OFFLINE_COPY,
  feedsToWarm,
  keptPage,
  parseKept,
  serializeKept,
} from "../../src/lib/offline-copy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const FEEDS = ["feed/1", "feed/2", "feed/3", "feed/4"];

/* ---- what one pass costs -------------------------------------------------- */

equal("eight posts a feed", OFFLINE_COPY.perFeed, 8);
equal("twenty feeds a pass at most", OFFLINE_COPY.maxFeeds, 20);
equal("a feed kept in the last twelve hours is not asked again", OFFLINE_COPY.staleMs, 12 * HOUR);
check("a page of posts, not the stream's first page", OFFLINE_COPY.perFeed < 50);

/* ---- nothing kept yet ----------------------------------------------------- */

equal("every feed is wanted when nothing is kept", feedsToWarm(FEEDS, new Map(), NOW), FEEDS);

/* ---- a feed kept recently is left alone ----------------------------------- */

{
  const kept = new Map([["feed/1", NOW - HOUR]]);
  equal("a feed kept an hour ago is not fetched again", feedsToWarm(FEEDS, kept, NOW), ["feed/2", "feed/3", "feed/4"]);
}
{
  const kept = new Map(FEEDS.map((id) => [id, NOW - HOUR]));
  equal("a fully warm set asks for nothing", feedsToWarm(FEEDS, kept, NOW), []);
}
{
  const kept = new Map([["feed/1", NOW - 13 * HOUR]]);
  // Due again — and last among the due, because a feed with a page from yesterday
  // is better off than one with nothing at all.
  equal("a feed kept yesterday is stale again", feedsToWarm(FEEDS, kept, NOW), ["feed/2", "feed/3", "feed/4", "feed/1"]);
}
{
  // Exactly at the boundary: the rule is "younger than stale is skipped", so a feed
  // kept exactly staleMs ago is due.
  const kept = new Map([["feed/1", NOW - OFFLINE_COPY.staleMs]]);
  check("the boundary is due, not skipped", feedsToWarm(FEEDS, kept, NOW).includes("feed/1"));
}

/* ---- the ceiling --------------------------------------------------------- */

{
  const many = Array.from({ length: 60 }, (_, at) => `feed/${at}`);
  const plan = feedsToWarm(many, new Map(), NOW);
  equal("never more than the ceiling", plan.length, OFFLINE_COPY.maxFeeds);
  equal("and the cut is the tail, not the head", plan[0], "feed/0");
}
{
  // When the ceiling bites, the feeds with nothing at all go first: a feed kept two
  // days ago still opens, and one that was never kept opens to an error.
  const kept = new Map([["feed/1", NOW - 48 * HOUR]]);
  const plan = feedsToWarm(FEEDS, kept, NOW);
  equal("a never-kept feed is ahead of a stale one", plan[0], "feed/2");
  equal("and the stale one is not dropped", plan[plan.length - 1], "feed/1");
}
{
  const kept = new Map([["feed/1", NOW - 3 * HOUR], ["feed/2", NOW - 30 * HOUR]]);
  equal("ages sort oldest first", feedsToWarm(["feed/1", "feed/2"], kept, NOW), ["feed/2"]);
}

/* ---- junk in, sane plan out ---------------------------------------------- */

equal("an empty id is not a feed", feedsToWarm(["", "feed/1"], new Map(), NOW), ["feed/1"]);
equal("a ceiling of zero asks for nothing", feedsToWarm(FEEDS, new Map(), NOW, { ...OFFLINE_COPY, maxFeeds: 0 }), []);
equal("a negative ceiling asks for nothing", feedsToWarm(FEEDS, new Map(), NOW, { ...OFFLINE_COPY, maxFeeds: -3 }), []);

/* ---- what a previous launch left behind ---------------------------------- */

{
  const kept = parseKept(JSON.stringify({ "feed/1": NOW - HOUR }), NOW);
  equal("a good stamp is read", [...kept.entries()], [["feed/1", NOW - HOUR]]);
}
equal("no stamp at all is nothing kept", parseKept(null, NOW).size, 0);
equal("an empty value is nothing kept", parseKept("", NOW).size, 0);
equal("broken JSON is nothing kept, not a throw", parseKept("{oops", NOW).size, 0);
equal("an array is not a stamp map", parseKept("[1,2,3]", NOW).size, 0);
equal("a number is not a stamp map", parseKept("7", NOW).size, 0);
equal("a string is not a stamp map", parseKept('"seven"', NOW).size, 0);
{
  const kept = parseKept(JSON.stringify({ "feed/1": "yesterday", "feed/2": null, "feed/3": NOW }), NOW);
  equal("entries that are not numbers are dropped", [...kept.keys()], ["feed/3"]);
}
{
  const kept = parseKept(JSON.stringify({ "feed/1": NOW + 10 * HOUR }), NOW);
  equal("a stamp in the future is clamped to now", kept.get("feed/1"), NOW);
}
equal("an empty id is dropped", parseKept(JSON.stringify({ "": NOW }), NOW).size, 0);

/* ---- writing it back ----------------------------------------------------- */

{
  const kept = new Map([["feed/1", NOW - 3 * HOUR], ["feed/2", NOW - HOUR]]);
  equal(
    "newest first, and readable again",
    [...parseKept(serializeKept(kept), NOW).entries()],
    [["feed/2", NOW - HOUR], ["feed/1", NOW - 3 * HOUR]],
  );
}
{
  const many = new Map(Array.from({ length: 400 }, (_, at) => [`feed/${at}`, NOW - at]));
  const written = Object.keys(JSON.parse(serializeKept(many))).length;
  check("a key that is read on every launch does not grow forever", written <= 80, String(written));
}

/* ---- the page that is kept ----------------------------------------------- */

{
  const items = [{ id: "a" }, { id: "b" }];
  const page = keptPage(items, "cont");
  equal("the items are kept with the continuation", page, { items, continuation: "cont" });
  check("and it is a copy, not the array it was handed", page.items !== items && page.items[0] === items[0]);
}

/* ---- and the reader actually keeps it ------------------------------------ */

{
  const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  check("a sync warms the copy, after the list", /if \(this\.error === null\) void this\.warmOfflineCopy\(\);/.test(reader));
  check(
    "and a launch without a sync warms it too, once the feeds are known",
    /this\.persistSidebar\(counts\.value, complete\);\s*\n[^]{0,800}void this\.warmOfflineCopy\(\);/.test(reader),
  );
  check("one feed at a time", /for \(const feedId of plan\) \{/.test(reader) && !/Promise\.all\(plan/.test(reader));
  check("and it is off unless the setting says so", /if \(!this\.keepOfflineCopy \|\| !this\.canRead\) return 0;/.test(reader));

  const main = readFileSync(join(root, "src/views/Main.svelte"), "utf8");
  check("the setting drives it", /reader\.keepOfflineCopy = on && !DEMO;/.test(main));

  const prefs = readFileSync(join(root, "src/lib/chrome-prefs.ts"), "utf8");
  check("the preference is on unless turned off", /offlineCopy: saved\.offlineCopy !== false/.test(prefs));

  const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
  check("and the row says what it costs", /At most 20 feeds per sync, and a feed kept in the last 12/.test(panel));
}


/* ---- a kept page is a disk seed, never the page the list shows ------------- */

{
  // The defect this holds shut: a warm pass that wrote through `rememberStream`
  // installed eight posts as this session's answer, stamped fresh, and so the whole
  // sidebar opened short with no revalidation. A kept page has to be a disk seed.
  const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  check(
    "the copy is written to disk, not into the list's cache",
    /await this\.keepStreamOnDisk\(feedId, keptPageFor\.items, keptPageFor\.continuation\);/.test(reader),
  );
  check(
    "and the warm pass never calls rememberStream",
    !/this\.rememberStream\(feedId/.test(reader),
  );
  check(
    "a stream the reader is holding in memory is not written over",
    /if \(this\.streamCache\.peek\(stream\) !== undefined\) return;/.test(reader),
  );
  check(
    "and a shorter page never replaces a longer one on disk",
    /const held = await readCached<DiskStream>\(key\);\s*\n\s*if \(held !== undefined && held\.value\.items\.length >= items\.length\) return;/.test(reader),
  );
}

/* ---- one pass at a time, however many callers ask ------------------------- */

{
  const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  check("the pass is guarded against a second one", /if \(this\.warming !== null\) return this\.warming;/.test(reader));
  check("and the guard is cleared when it ends", /this\.warming = null;/.test(reader));
  const main = readFileSync(join(root, "src/views/Main.svelte"), "utf8");
  check(
    "the effect does not track the sidebar it reads",
    /untrack\(\(\) => void reader\.warmOfflineCopy\(\)\);/.test(main),
  );
}

/* ---- and it stops for the right reasons ---------------------------------- */

{
  const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  check("two failures in a row end the pass", /if \(failed >= 2\) break;/.test(reader));
  check("turning the switch off ends it too", /if \(!this\.keepOfflineCopy\) break;/.test(reader));
  check("a stale error banner does not stop it", !/if \(this\.error !== null\) break;/.test(reader));
}

/* ---- and a mark reaches the page on disk --------------------------------- */

{
  const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");
  const read = reader.slice(reader.indexOf("async setRead(item: StreamItem"));
  check(
    "a read mark is written to the cached page",
    // `sendRead` routes it (the aggregate for a row from another account) and then
    // the local edit goes to the disk copy, as it always did.
    /await this\.sendRead\(\[item\.id\], read\);\s*\n[^]{0,500}this\.cacheActiveStream\(\);/.test(reader),
  );
  check(
    "a star mark too",
    /await this\.sendStarred\(\[item\.id\], !starred\);\s*\n[^]{0,600}this\.cacheActiveStream\(\);/.test(reader),
  );
  check(
    "and a mark from another account's row goes to that account",
    /private async sendRead\(ids: string\[\], read: boolean\)[\s\S]{0,400}?this\.aggregate\.markRead\(ids, read\)/.test(reader) &&
      /private async sendStarred\(ids: string\[\], starred: boolean\)[\s\S]{0,400}?this\.aggregate\.markStarred\(ids, starred\)/.test(reader),
  );
  check(
    "a plain id still goes to the account on screen",
    /await this\.source\(\)\.setRead\(ids, read\);/.test(reader) && /await this\.source\(\)\.setStarred\(ids, starred\);/.test(reader),
  );
  check("and both go through the shared state helper", /withState\(previous, STATE_READ, read\)/.test(reader) && /withState\(previous, STATE_STARRED, !starred\)/.test(reader));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
