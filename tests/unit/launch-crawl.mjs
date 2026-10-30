/**
 * The launch crawl shows what it crawled.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/launch-crawl.mjs
 *
 * A library on this device has no crawler behind it, so opening the app *is* the
 * crawl: `start()` loads the sidebar and the open stream, then `fetchNewInto`
 * asks every due feed for new posts. The stream it reloads afterwards was
 * fetched seconds earlier and is still inside the stream cache's minute, so a
 * reload that trusts the cache paints the rows from before the crawl — the posts
 * just fetched stay invisible until something else expires the entry. That is
 * the "sync grabbed nothing for a minute after a load" fault, on the launch that
 * nobody presses.
 *
 * So this suite drives the real `ReaderState` through a real launch, over a real
 * `LocalBackend` and the in-memory engine, with a feed document that gains a
 * post between the launch load and the crawl. Nothing is stubbed but the feed's
 * own bytes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { GEN_DIR, buildReaderModule } from "./build-reader.mjs";
import { READING_LIST } from "../../src/api/freshrss.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { localProfile } from "../../src/api/profile.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const FEED = "https://fixture.test/feed.xml";
const T = 1_700_000_000;

/** A feed document with the posts it is given. */
function rssDocument(items) {
  const entries = items
    .map(
      (item) => `
    <item>
      <guid>${item.guid}</guid>
      <title>${item.title}</title>
      <link>https://fixture.test/${item.guid}</link>
      <pubDate>${new Date((item.published ?? T) * 1000).toUTCString()}</pubDate>
      <description><![CDATA[<p>Body of ${item.guid}.</p>]]></description>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Fixture feed</title>
    <link>https://fixture.test</link>
    ${entries}
  </channel>
</rss>`;
}

/** What the crawl's fetcher answers: the document as it stands when it is asked. */
function response(body) {
  const headers = new Map([["content-type", "application/rss+xml"]]);
  return {
    status: 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function fetcherFor(document) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response(document());
  };
  fetcher.calls = calls;
  return fetcher;
}

/** Waits for something the launch does in the background, without sleeping it out. */
async function until(predicate, ms = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

writeFileSync(join(GEN_DIR, "launch-crawl-reader.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "launch-crawl-reader.mjs")).href);

/* --------------------------------------------------------------------------
 * A library with one post, and a feed that has gained a second one since.
 * ----------------------------------------------------------------------- */
const store = new LocalStore(new MemoryDatabase());
let document = rssDocument([{ guid: "one", title: "Older post" }]);
const fetcher = fetcherFor(() => document);
const backend = new LocalBackend(store, { fetch: fetcher });

await backend.subscribe({ feedUrl: FEED, title: "Fixture feed" });
await store.putEntries([
  { feedUrl: FEED, guid: "one", title: "Older post", published: T, content: "<p>First.</p>" },
]);
// The crawl is the first one this feed has ever had, so it is due: nothing has
// been attempted, and a feed nobody has tried has no due time behind it.
document = rssDocument([
  { guid: "two", title: "Newer post", published: T + 60 },
  { guid: "one", title: "Older post" },
]);

const reader = new ReaderState();
await reader.start(localProfile(backend));

check("the launch draws what the library held", reader.items.length === 1, reader.items.map((item) => item.title).join(", "));
check("...and it is the stored post", reader.items[0]?.title === "Older post", String(reader.items[0]?.title));

// The launch crawl runs behind the first paint, so it is waited for rather than
// assumed: `start()` returns as soon as the load lands.
check("the launch crawls the feed without being asked", await until(() => fetcher.calls.length > 0), fetcher.calls.join(", "));
check(
  "...and the post it found is on the list",
  await until(() => reader.items.some((item) => item.title === "Newer post")),
  reader.items.map((item) => item.title).join(", "),
);
// The mechanism, not just the outcome: a reload answered from the cache would
// leave `lastStreamSource` at "cache" and the list as it was.
check("...because the list was reloaded from the library", reader.lastStreamSource === "network", String(reader.lastStreamSource));
check("...with both posts, newest first", reader.items.map((item) => item.title).join(",") === "Newer post,Older post", reader.items.map((item) => item.title).join(","));

/* --------------------------------------------------------------------------
 * Why the force is the fix.
 *
 * The stream the launch loaded is still inside the cache's minute, so an
 * unforced reload answers from memory — the rows from before the crawl — and
 * paints them over a list that has moved on. This is the trap `fetchNewInto`
 * steps around, and the reason `refresh()` has forced its reload since.
 * ----------------------------------------------------------------------- */
{
  await store.putEntries([
    { feedUrl: FEED, guid: "three", title: "Newest post", published: T + 120 },
  ]);
  await reader.reloadStream();
  check(
    "an unforced reload inside the minute paints the cache",
    !reader.items.some((item) => item.title === "Newest post"),
    reader.items.map((item) => item.title).join(", "),
  );
  check("...and says where it came from", reader.lastStreamSource === "cache", String(reader.lastStreamSource));

  await reader.reloadStream({ force: true });
  check(
    "a forced reload is the library's own answer",
    reader.items.some((item) => item.title === "Newest post"),
    reader.items.map((item) => item.title).join(", "),
  );
  check("...and says so", reader.lastStreamSource === "network", String(reader.lastStreamSource));
}

await store.close();

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
