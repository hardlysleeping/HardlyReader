// The cache the pipeline talks to: what it keeps, what it refuses, and what it
// does when the device is full.
//
// `body-budget` proves the policy and `local-bodies` proves the table. This is
// the adapter between them — the one that decides, per call, whether a body is
// written at all, and that keeps the numbers a settings row draws. It is ordinary
// TypeScript over a real `LocalStore`, so it is provable without a browser, a
// webview or a page on the network.
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { createBodyCache } from "../../src/lib/body-cache.ts";
import { BODY_MAX_POST } from "../../src/lib/bodies.ts";

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

const OPEN = "<p>Kept on open.</p>";
const TWO = "<p>Two.</p>";
const THREE = "<p>Three.</p>";
const FOUR = "<p>Four.</p>";

const store = new LocalStore(new MemoryDatabase());
await store.subscribe(FEED, { title: "Comic pages" });
const guids = ["one", "two", "three", "four"];
await store.putEntries(
  guids.map((guid, index) => ({
    feedUrl: FEED,
    guid,
    title: `Post ${guid}`,
    published: 1_700_000_000 + index * 60,
  })),
);
const item = (guid) => localItemId(FEED, guid);

/** A reader's answers, changed the way the panel changes them. */
let keeping = false;
let limit = 1024 * 1024;
const shown = new Set();
let reported = null;
let cleared = null;

const cache = createBodyCache({
  library: () => store,
  keeping: () => keeping,
  limit: () => limit,
  onScreen: () => shown,
  measured: (usage) => {
    reported = usage;
  },
  cleared: (pruned) => {
    cleared = pruned;
  },
});

/** What the pipeline hands over: the page, as the extractor made it. */
const extraction = (html) => ({
  html,
  title: "A page",
  byline: "A cartoonist",
  textLength: html.length,
});

// 1. Off means nothing is written, and the page that arrived is not lost — the
//    caller only ever asked for it to be kept, never for it to be fetched.
await cache.write(item("one"), extraction(OPEN));
check("with keeping off, nothing is written", (await store.extraction(item("one"))) === null);

// 2. On open, a body is written whole.
keeping = true;
await cache.write(item("one"), extraction(OPEN));
const kept = await store.extraction(item("one"));
check("with keeping on, the body is written", kept !== null && kept.html === OPEN);
check(
  "with its headline, byline and length",
  kept.title === "A page" && kept.byline === "A cartoonist" && kept.text_length === OPEN.length,
  `${kept.text_length} vs ${OPEN.length}`,
);
check(
  "and the cache reports one body and its size",
  reported.count === 1 && reported.bytes === bytesOf(OPEN),
  JSON.stringify(reported),
);

// 3. A page bigger than the per-post ceiling is a download, not an article.
await cache.write(item("two"), extraction(`<p>${"x".repeat(BODY_MAX_POST)}</p>`));
check("a body past the per-post ceiling is not kept", (await store.extraction(item("two"))) === null);
check("and it did not reach the numbers either", reported.count === 1, JSON.stringify(reported));

// 4. Reading a kept body answers with the whole extraction, and moves the row to
//    the front of the eviction queue without a network in sight.
const readBack = await cache.read(item("one"));
check(
  "a kept body reads back as an extraction",
  readBack !== null &&
    readBack.html === OPEN &&
    readBack.title === "A page" &&
    readBack.byline === "A cartoonist" &&
    readBack.textLength === OPEN.length,
);
const stamp = (await store.extraction(item("one"))).used_at;
await cache.read(item("one"));
check("reading stamps the row as just used", (await store.extraction(item("one"))).used_at >= stamp);
check("a post with no body is a miss", (await cache.read(item("three"))) === null);

// 5. Reading is unconditional: switching keeping off does not hide what is
//    already here.
keeping = false;
check("a body already kept still reads with keeping off", (await cache.read(item("one"))) !== null);
keeping = true;

// 6. The budget, in one explicit pass: two bodies are older than the one with a
//    ceiling that fits only two, and the least recently read goes.
await store.saveExtraction({ itemId: item("two"), html: TWO });
await store.saveExtraction({ itemId: item("three"), html: THREE });
const base = (await store.extraction(item("one"))).used_at;
await store.touchExtraction(item("one"), base + 30);
await store.touchExtraction(item("two"), base + 10);
await store.touchExtraction(item("three"), base + 20);
limit = bytesOf(OPEN) + bytesOf(THREE) + 1;
await cache.settle();
const left = await store.bodies();
check("the pass cleared the least recently used body", (await store.extraction(item("two"))) === null, `${left.length} left`);
check(
  "and kept the two that fit",
  left.length === 2 && (await store.extraction(item("one"))) !== null && (await store.extraction(item("three"))) !== null,
);
check(
  "the cache reports what survived",
  reported.count === 2 && reported.bytes === left.reduce((sum, body) => sum + body.bytes, 0),
  JSON.stringify(reported),
);
check(
  "and says what it cleared",
  cleared !== null && cleared.dropped === 1 && cleared.freed === bytesOf(TWO),
  JSON.stringify(cleared),
);

// 7. A write that crosses the ceiling makes room at once, and never at the cost
//    of the posts being written or being read.
shown.add(item("three"));
cleared = null;
limit = bytesOf(OPEN) + bytesOf(THREE);
await cache.write(item("four"), extraction(FOUR));
check("the post just written is kept", (await store.extraction(item("four"))) !== null);
check("the post on screen is kept", (await store.extraction(item("three"))) !== null);
check("and the one nobody is looking at goes", (await store.extraction(item("one"))) === null);
check("the pass reported the clear", cleared !== null && cleared.dropped === 1, JSON.stringify(cleared));
shown.clear();

// 8. With no library at all — a reader whose articles live on a server — the
//    cache answers nothing and writes nothing, so the pipeline behaves exactly as
//    it did before this existed.
const detached = createBodyCache({
  library: () => null,
  keeping: () => true,
  limit: () => limit,
  onScreen: () => [],
  measured: () => {},
});
check("no library is a miss", (await detached.read(item("four"))) === null);
await detached.write(item("four"), extraction("<p>Changed.</p>"));
check("and a write through no library changes nothing", (await store.extraction(item("four"))).html === FOUR);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
