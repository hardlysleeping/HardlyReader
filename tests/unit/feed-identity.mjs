/**
 * Local mode: one feed, one identity.
 *
 * `localItemId(feedUrl, guid)` and the sync document both key on the URL a feed
 * was *given*. A feed that moves `example.com/feed` → `www.example.com/feed`, or
 * that answers a permanent redirect, would therefore become a second
 * subscription with a second set of marks — and two devices would then disagree
 * about which one is real.
 *
 * What is pinned here: the resolved address is recorded beside the subscribed
 * one; a poll that arrives somewhere else rewrites the feed's key instead of
 * adding one; the articles and their marks follow; the old address is left as a
 * redirect so the other device follows too; a feed that changes its guid scheme
 * keeps the old row and marks it superseded; and a redirect between two syncs
 * ends with one feed, one set of marks and no duplicate in the document.
 *
 * Every check drives real stores over the in-memory driver, the real poller and
 * the real sync engine; the clock and the network are values, not waits.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/feed-identity.mjs
 */
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import { refreshDueFeeds } from "../../src/api/local/refresh.ts";
import { emptySnapshot, parseSyncSnapshot, syncOnce } from "../../src/api/local/sync.ts";
import { emptyPrefs } from "../../src/lib/prefs-sync.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function deepEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${what}: expected ${b}, got ${a}`);
}

const T = 1_700_000_000;
const OLD = "https://example.com/feed";
const NEW = "https://www.example.com/feed";

/* ---------------------------------------------------------------------------
 * A feed document, a fetcher that answers from a table, and a device.
 * ------------------------------------------------------------------------- */

function rssDocument({ title = "A feed", site = "https://example.com", items = [] } = {}) {
  const entries = items
    .map(
      (item) => `
    <item>
      <guid>${item.guid}</guid>
      <title>${item.title ?? "A post"}</title>
      <link>${item.link ?? `https://example.com/${item.guid}`}</link>
      <pubDate>Mon, 20 Nov 2023 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Body</p>]]></description>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${title}</title>
    <link>${site}</link>
    ${entries}
  </channel>
</rss>`;
}

/** A response, with the address it finally came from — which is the point. */
function answered(url, body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    url,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** A fetcher that answers from a table keyed by the address it was asked for. */
function fetcherFor(table) {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url, headers: { ...request.headers } });
    const answer = table[url];
    if (answer === undefined) throw new Error(`the suite has no answer for ${url}`);
    return answer;
  };
  fetcher.calls = calls;
  return fetcher;
}

/** A device: a library, the agreement it last reached, and its settings. */
function device(name) {
  const store = new LocalStore(new MemoryDatabase());
  return {
    name,
    store,
    base: null,
    prefs: emptyPrefs(),
    async sync(provider, at) {
      const run = await syncOnce({
        store,
        provider,
        device: name,
        base: this.base,
        now: at,
        prefs: {
          local: this.prefs,
          adopt: (doc) => {
            this.prefs = doc;
          },
        },
      });
      this.base = run.snapshot;
      return run;
    },
  };
}

async function feedKeys(store) {
  return (await store.feeds()).map((feed) => feed.key).sort();
}

/* ---------------------------------------------------------------------------
 * The poll: the address a feed finally answered at
 * ------------------------------------------------------------------------- */

console.log("a feed that answers somewhere else");

await check("a redirect rewrites the feed's key, and its articles move with it", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD, { title: "Comics" });
  await store.putEntries([{ feedUrl: OLD, guid: "p1", link: "https://example.com/p/1" }]);
  await store.setRead([localItemId(OLD, "p1")], true);

  const report = await refreshDueFeeds({
    store,
    now: T,
    fetch: fetcherFor({
      [OLD]: answered(NEW, rssDocument({ items: [{ guid: "p1", link: "https://example.com/p/1" }] })),
    }),
  });

  equal(report.failures.length, 0, "no failure");
  deepEqual(await feedKeys(store), [NEW], "one feed, at the address it answers at");
  equal((await store.feeds())[0].resolved_url, NEW, "the resolved address is recorded");

  const moved = await store.entry(localItemId(NEW, "p1"));
  equal(moved === null, false, "the article is under the new key");
  equal(moved.read, 1, "and kept its read mark");
  equal(await store.entry(localItemId(OLD, "p1")), null, "the old id is gone, not duplicated");

  const known = await store.redirects();
  deepEqual(Object.keys(known), [OLD], "the move is on the record");
  equal(known[OLD].to, NEW, "pointing where the feed went");
  equal(known[OLD].at > 0, true, "with the second it was learned");
});

await check("a feed whose address is the same one spelled differently is not moved", async () => {
  const store = new LocalStore(new MemoryDatabase());
  const slashless = "https://example.com/feed";
  await store.subscribe(`${slashless}/`);
  await refreshDueFeeds({
    store,
    now: T,
    fetch: fetcherFor({ [`${slashless}/`]: answered(slashless, rssDocument()) }),
  });

  deepEqual(await feedKeys(store), [`${slashless}/`], "the key the reader subscribed at");
  equal((await store.feeds())[0].resolved_url, slashless, "and the address it answered at");
  deepEqual(await store.redirects(), {}, "nothing moved");
});

await check("a redirect that lands on a web page does not move the subscription", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD);
  const report = await refreshDueFeeds({
    store,
    now: T,
    fetch: fetcherFor({ [OLD]: answered(NEW, "<!doctype html><html><body>Sign in</body></html>") }),
  });

  equal(report.failures.length, 1, "the poll failed, in words");
  deepEqual(await feedKeys(store), [OLD], "the feed is where the reader put it");
  deepEqual(await store.redirects(), {}, "and no move was recorded");
});

await check("a feed that answers back at the old address does not move twice", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD);
  const body = rssDocument({ items: [{ guid: "p1", link: "https://example.com/p/1" }] });

  await refreshDueFeeds({ store, now: T, fetch: fetcherFor({ [OLD]: answered(NEW, body) }) });
  // The next wake finds the feed answering at the address it came from. That is
  // not a move back: it is the loop the redirect record exists to stop.
  await refreshDueFeeds({ store, now: T + 7200, fetch: fetcherFor({ [NEW]: answered(OLD, body) }) });

  deepEqual(await feedKeys(store), [NEW], "still one feed");
  deepEqual(Object.keys(await store.redirects()), [OLD], "one move, in one direction");
  const page = await store.queryEntries({ feeds: [NEW] });
  equal(page.entries.length, 1, "and one copy of the article");
});

await check("two spellings already subscribed are folded into one", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD, { title: "Comics" });
  await store.subscribe(NEW);
  await store.putEntries([{ feedUrl: OLD, guid: "p1", link: "https://example.com/p/1" }]);
  await store.putEntries([{ feedUrl: NEW, guid: "p1", link: "https://example.com/p/1" }]);
  await store.setRead([localItemId(OLD, "p1")], true);
  await store.setStarred([localItemId(NEW, "p1")], true);

  await refreshDueFeeds({
    store,
    now: T,
    fetch: fetcherFor({
      [OLD]: answered(NEW, rssDocument({ items: [{ guid: "p1", link: "https://example.com/p/1" }] })),
    }),
  });

  const feeds = await store.feeds();
  equal(feeds.length, 1, "one feed");
  equal(feeds[0].key, NEW, "under the address it answers at");
  equal(feeds[0].title, "Comics", "with the name the reader chose");

  const post = await store.entry(localItemId(NEW, "p1"));
  equal(post.read, 1, "the read mark");
  equal(post.starred, 1, "the star");
  equal((await store.queryEntries({ feeds: [NEW] })).entries.length, 1, "one copy of the article");
});

/* ---------------------------------------------------------------------------
 * The guid scheme changes
 * ------------------------------------------------------------------------- */

console.log("\na feed that changes its guid scheme");

await check("the same article under a new guid keeps the old row, superseded", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD);
  const link = "https://example.com/p/1";
  const older = localItemId(OLD, "post/1");
  const newer = localItemId(OLD, "post-1");

  await store.putEntries([{ feedUrl: OLD, guid: "post/1", link }]);
  await store.setRead([older], true);
  await store.putEntries([{ feedUrl: OLD, guid: "post-1", link }]);

  const page = await store.queryEntries({ feeds: [OLD] });
  equal(page.entries.length, 1, "one article in the list");
  equal(page.entries[0].key, newer, "the row the feed re-issued");
  equal(page.entries[0].read, 1, "carrying the read mark");
  equal((await store.entry(older)).superseded_by, newer, "the old row is kept and points forward");
  const counted = await store.counts();
  equal(counted.length, 1, "one feed's worth of counts");
  equal(counted[0].count, 0, "and nothing counted twice");

  // A pane drawn before the change still holds the old id; its mark must land.
  await store.setStarred([older], true);
  equal((await store.entry(newer)).starred, 1, "a mark for the old id lands on the article");
});

await check("posts that share one link are not treated as a changed guid scheme", async () => {
  const store = new LocalStore(new MemoryDatabase());
  await store.subscribe(OLD);
  const link = "https://example.com/one-page";

  await store.putEntries([
    { feedUrl: OLD, guid: "a", link },
    { feedUrl: OLD, guid: "b", link },
  ]);
  await store.putEntries([{ feedUrl: OLD, guid: "c", link }]);

  equal((await store.queryEntries({ feeds: [OLD] })).entries.length, 3, "all three are articles");
  for (const guid of ["a", "b"]) {
    equal(
      (await store.entry(localItemId(OLD, guid))).superseded_by ?? null,
      null,
      `${guid} is not superseded`,
    );
  }
});

/* ---------------------------------------------------------------------------
 * Two devices, a redirect between two syncs
 * ------------------------------------------------------------------------- */

console.log("\ntwo devices, one redirect");

await check("a redirect between two syncs ends with one feed and one set of marks", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");
  const link = "https://example.com/p/1";
  const oldId = localItemId(OLD, "p1");
  const newId = localItemId(NEW, "p1");

  await a.store.subscribe(OLD, { title: "Comics" });
  await b.store.subscribe(OLD, { title: "Comics" });
  await a.store.putEntries([{ feedUrl: OLD, guid: "p1", link }]);
  await b.store.putEntries([{ feedUrl: OLD, guid: "p1", link }]);

  await a.sync(folder, T + 10);
  await b.sync(folder, T + 20);
  await a.store.setRead([oldId], true);
  await a.sync(folder, T + 30);
  equal(
    parseSyncSnapshot((await folder.read()) ?? "").marks[oldId].read,
    true,
    "the mark the first device made, before anything moved",
  );

  // The first device wakes, and the feed has moved.
  await refreshDueFeeds({
    store: a.store,
    now: T + 40,
    fetch: fetcherFor({ [OLD]: answered(NEW, rssDocument({ items: [{ guid: "p1", link }] })) }),
  });
  const afterMove = await a.sync(folder, T + 50);

  const document = parseSyncSnapshot((await folder.read()) ?? "");
  deepEqual(Object.keys(document.feeds), [NEW], "the document holds one feed, at its new address");
  equal(document.feeds[OLD], undefined, "and no tombstone for the address it left");
  deepEqual(Object.keys(document.marks), [newId], "one mark, under the article's new id");
  equal(document.marks[newId].read, true, "still read");
  equal(document.redirects[OLD].to, NEW, "the move travels");
  equal(afterMove.applied.feedsAdded.length, 0, "nothing was added on the device that moved it");

  // The second device never fetched the feed. It follows the record.
  const bRun = await b.sync(folder, T + 60);
  deepEqual(await feedKeys(b.store), [NEW], "one feed on the second device");
  equal((await b.store.feed(OLD)) ?? null, null, "and none left at the old address");
  equal((await b.store.entry(newId)).read, 1, "the mark moved with the article");
  equal((await b.store.entry(oldId)) ?? null, null, "the old article id is gone");
  deepEqual((await b.store.redirects())[OLD].to, NEW, "it knows the move");
  equal(bRun.applied.feedsRedirected.length, 1, "and says so in the report");
  equal((await b.store.queryEntries({ feeds: [NEW] })).entries.length, 1, "one copy of the article");
  deepEqual(Object.keys(afterMove.snapshot.feeds), [NEW], "one feed in the moving device's document");
  deepEqual(Object.keys(bRun.snapshot.feeds), [NEW], "one feed in the following device's");
  deepEqual(Object.keys(bRun.snapshot.marks), [newId], "one mark in it, under the article's new id");

  // Both devices agree afterwards, and neither document grew a second feed.
  const settled = parseSyncSnapshot((await folder.read()) ?? "");
  deepEqual(Object.keys(settled.feeds), [NEW], "still one feed in the file");
  deepEqual(Object.keys(settled.marks), [newId], "still one mark in the file");
});

await check("a document round-trips its moves, and drops one it cannot follow", async () => {
  const snapshot = emptySnapshot("laptop", T);
  snapshot.redirects[OLD] = { to: NEW, at: T, rev: 3, by: "device-laptop" };
  snapshot.feeds[NEW] = {
    at: T,
    rev: 3,
    by: "device-laptop",
    title: "Comics",
    titleSource: "given",
    folder: null,
    addedAt: T,
    removed: false,
  };

  const parsed = parseSyncSnapshot(JSON.stringify(snapshot));
  deepEqual(parsed.redirects, snapshot.redirects, "the moves");
  deepEqual(Object.keys(parsed.feeds), [NEW], "the feeds");

  const broken = parseSyncSnapshot(
    JSON.stringify({ version: 1, redirects: { [OLD]: { to: "" }, [NEW]: { at: T } } }),
  );
  deepEqual(broken.redirects, {}, "a move with no target or no date is dropped");
});

console.log(`\n${passed} checks passed`);
