// A body kept beside its entry: what is stored, what it costs, and what goes.
//
// `local-backend` proves the library's queries and `local-sqlite-driver` proves
// the desktop engine and its migrations; this suite is the one table they only
// touch in passing. It runs on the memory engine, because what is being proved
// here is the *policy of the table* — the size a body reports, the stamp that
// makes least-recently-used true, and the fact that eviction deletes copies and
// never library rows — and that policy is ordinary TypeScript above the engine.
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FEED = "https://comics.test/feed.xml";
const bytesOf = (text) => new TextEncoder().encode(text).length;

const store = new LocalStore(new MemoryDatabase());
await store.subscribe(FEED, { title: "Comic pages" });
await store.putEntries([
  { feedUrl: FEED, guid: "one", title: "One", published: 1_700_000_000 },
  { feedUrl: FEED, guid: "two", title: "Two", published: 1_700_000_060 },
  { feedUrl: FEED, guid: "three", title: "Three", published: 1_700_000_120 },
]);
const one = localItemId(FEED, "one");
const two = localItemId(FEED, "two");
const three = localItemId(FEED, "three");

// 1. A body is stored whole: the text, and everything the pane needs to draw it
//    without the feed in hand.
const body = "<p>A page of comics, with words in it.</p>";
const saved = await store.saveExtraction({
  itemId: one,
  html: body,
  title: "The page",
  byline: "A cartoonist",
  textLength: 38,
});
const row = await store.extraction(one);
check("a body is kept, and the row says it is a body", row.status === "ok" && row.html === body);
check("with the headline and byline the pane draws", row.title === "The page" && row.byline === "A cartoonist");
check("and the length chooseBody weighs", row.text_length === 38);
check("it reports its own size in bytes", saved.bytes === bytesOf(body) && saved.delta === saved.bytes, `${saved.bytes} vs ${bytesOf(body)}`);
check("and that it was new", saved.added === true);
check("the size is recorded on the row too", row.bytes === bytesOf(body));
check("a body nobody has read yet is stamped as new", typeof row.used_at === "number" && row.used_at === row.extracted_at);

// 2. Re-fetching a post replaces its body and reports the difference, not the
//    whole size again: a caller tracking the total adds the delta.
const longer = `${body}${" And another panel. ".repeat(4)}`;
const replaced = await store.saveExtraction({ itemId: one, html: longer, title: "The page" });
check("a second body for the same post is not a new entry", replaced.added === false);
check("and the delta is the difference", replaced.delta === bytesOf(longer) - bytesOf(body));
check("the row now holds the newer body", (await store.extraction(one)).html === longer);

// 3. A failure is not a body: no text, no size, and it replaces a body's bytes
//    with nothing.
const failed = await store.saveExtraction({ itemId: two, html: null, error: "the page answered 403" });
check("a failure is remembered as a failure", (await store.extraction(two)).status === "failed");
check("a failure holds no text and costs nothing", failed.bytes === 0 && failed.added === false);
await store.saveExtraction({ itemId: three, html: body });
const dropped = await store.saveExtraction({ itemId: three, html: null, error: "the page answered 500" });
check("a body replaced by a failure gives its bytes back", dropped.delta === -bytesOf(body));

// 4. Reading is what least-recently-used means.
await store.saveExtraction({ itemId: three, html: body });
const before = (await store.extraction(three)).used_at;
await store.touchExtraction(three, before + 500);
check("reading a body moves it to the front of the queue", (await store.extraction(three)).used_at === before + 500);
check("touching a post with no body creates nothing", (await store.touchExtraction(localItemId(FEED, "four")), (await store.extraction(localItemId(FEED, "four"))) === null));
const failedBefore = (await store.extraction(two)).used_at;
await store.touchExtraction(two, failedBefore + 500);
check("and a failure is never a candidate", (await store.extraction(two)).used_at === failedBefore);

// 5. What the budget sees: bodies only, with the two stamps.
const kept = await store.bodies();
check("the budget counts bodies, not failures", kept.length === 2, `${kept.length}`);
check("and their sizes add up", (await store.bodyUsage()).bytes === kept.reduce((sum, item) => sum + item.bytes, 0));
check("every body carries when it was read and fetched", kept.every((item) => typeof item.usedAt === "number" && typeof item.storedAt === "number"));

// 6. Eviction: least recently used first, only what the ceiling needs, and only
//    copies.
await store.saveExtraction({ itemId: one, html: body });
await store.touchExtraction(one, (await store.extraction(one)).used_at + 900);
const rowsBefore = { entries: (await store.queryEntries({ count: 50 })).entries.length, feeds: (await store.feeds()).length };
const pruned = await store.pruneBodies(bytesOf(body), { keep: [one] });
check("the pass clears the bodies the ceiling cannot hold", pruned.dropped === 1 && pruned.count === 1, `${pruned.dropped} dropped`);
check("the one a reader has open survives", (await store.extraction(one)) !== null);
check("and the library itself is untouched", (await store.queryEntries({ count: 50 })).entries.length === rowsBefore.entries && (await store.feeds()).length === rowsBefore.feeds);
check("the pass reports what is left", pruned.bytes === bytesOf(body) && pruned.overLimit === false);
check("a cleared body leaves no row behind", (await store.extraction(three)) === null);

// 7. A ceiling everything on screen exceeds gives way rather than deleting the
//    article being read.
const walled = await store.pruneBodies(0, { keep: [one] });
check("nothing visible is deleted to meet a ceiling", walled.dropped === 0 && walled.overLimit === true);
check("and the body is still there", (await store.extraction(one)) !== null);

// 8. A feed that goes away takes its bodies with it, which is what keeps the
//    budget's index honest.
await store.unsubscribe(FEED);
const left = await store.bodies();
check("unsubscribing a feed clears the bodies it brought", left.length === 0, `${left.length}`);
check("and the posts", (await store.queryEntries({ count: 50 })).entries.length === 0);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
