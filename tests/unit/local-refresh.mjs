/**
 * Local mode: the poller.
 *
 * In server mode something else is the crawler; in a local library this file is,
 * so what it does when a feed is due is worth pinning: which feeds it picks, what
 * it writes, what it refuses to write, and what a wake costs when nothing has
 * changed.
 *
 * Every check drives a real `LocalStore` over the in-memory driver, the real RSS
 * reader, and a fetcher that records what it was asked for. Nothing here waits:
 * the clock is a number, the network is a function.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-refresh.mjs
 */
import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import {
  REFRESH_POLICY,
  createRefresher,
  dueFeeds,
  feedDueAt,
  feedIntervalSeconds,
  isFeedDue,
  refreshDueFeeds,
} from "../../src/api/local/refresh.ts";
import { ensureColumns } from "../../src/api/local/sqlite-db.ts";
import { TABLES } from "../../src/api/local/schema.ts";

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

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/** A feed row with the poll state a test wants it to have. */
function row(key, state = {}) {
  return {
    key,
    title: key,
    html_url: null,
    icon_url: null,
    folder: null,
    added_at: 0,
    title_source: "url",
    fetched_at: null,
    attempted_at: null,
    etag: null,
    last_modified: null,
    failures: 0,
    last_error: null,
    ...state,
  };
}

/* ---------------------------------------------------------------------------
 * A feed document, and a fetcher that answers with one.
 * ------------------------------------------------------------------------- */

function rssDocument({ title = "A feed", site = "https://a.test", items = [] } = {}) {
  const entries = items
    .map(
      (item) => `
    <item>
      <guid>${item.guid}</guid>
      <title>${item.title ?? "A post"}</title>
      <link>${item.link ?? "https://a.test/post"}</link>
      <pubDate>${item.date ?? "Mon, 20 Nov 2023 10:00:00 GMT"}</pubDate>
      <description><![CDATA[${item.content ?? "<p>Body</p>"}]]></description>
      ${item.author === undefined ? "" : `<dc:creator>${item.author}</dc:creator>`}
      ${item.image === undefined ? "" : `<enclosure url="${item.image}" type="image/jpeg" />`}
    </item>`,
    )
    .join("");
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${title}</title>
    <link>${site}</link>
    ${entries}
  </channel>
</rss>`;
}

function response(status, body = "", headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** A fetcher that answers from a table and records every request it was given. */
function recordingFetcher(table) {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url, headers: { ...request.headers } });
    const answer = table[url];
    if (answer === undefined) throw new Error(`the suite has no answer for ${url}`);
    return typeof answer === "function" ? answer(url, request) : answer;
  };
  fetcher.calls = calls;
  return fetcher;
}

/** A store with the given feeds already subscribed. */
async function storeWith(urls, titles = {}) {
  const store = new LocalStore(new MemoryDatabase());
  for (const url of urls) await store.subscribe(url, { title: titles[url] });
  return store;
}

/* ---------------------------------------------------------------------------
 * When a feed is due.
 * ------------------------------------------------------------------------- */

console.log("due times");
await check("a feed that has never been read is due straight away", () => {
  equal(isFeedDue(row(FEED_A), T), true, "never fetched");
  equal(feedDueAt(row(FEED_A)), 0, "due at");
});

await check("a feed read just now is not due", () => {
  equal(isFeedDue(row(FEED_A, { fetched_at: T }), T), false, "just fetched");
});

await check("a feed is due exactly when its interval has passed", () => {
  const feed = row(FEED_A, { fetched_at: T });
  equal(isFeedDue(feed, T + HOUR - 1), false, "one second short");
  equal(isFeedDue(feed, T + HOUR), true, "exactly at the interval");
});

await check("the interval is an hour by default", () => {
  equal(REFRESH_POLICY.intervalMinutes, 60, "interval");
  equal(feedIntervalSeconds(row(FEED_A)), HOUR, "seconds");
});

await check("a failure doubles the wait", () => {
  equal(feedIntervalSeconds(row(FEED_A, { failures: 1 })), 2 * HOUR, "one failure");
  equal(feedIntervalSeconds(row(FEED_A, { failures: 2 })), 4 * HOUR, "two failures");
});

await check("a feed that keeps failing waits no longer than the backoff cap", () => {
  const capped = REFRESH_POLICY.maxBackoffMinutes * MINUTE;
  equal(feedIntervalSeconds(row(FEED_A, { failures: 12 })), capped, "twelve failures");
  equal(capped <= REFRESH_POLICY.maxBackoffMinutes * MINUTE, true, "cap is the cap");
});

await check("the wait runs from the last attempt, not from the last success", () => {
  // Read successfully an hour and a half ago, then failed ten minutes ago: the
  // wait is two hours from the attempt, so an hour after the failure is too soon.
  const feed = row(FEED_A, {
    fetched_at: T - HOUR - 30 * MINUTE,
    attempted_at: T - 10 * MINUTE,
    failures: 1,
  });
  equal(isFeedDue(feed, T + HOUR), false, "not yet");
  equal(isFeedDue(feed, T + 110 * MINUTE), true, "two hours after the attempt");
});

console.log("\nchoosing feeds");
await check("the stalest feeds come first, and only so many per wake", () => {
  const feeds = [
    row("https://one.test/", { fetched_at: T - HOUR }),
    row("https://two.test/", { fetched_at: T - 5 * HOUR }),
    row("https://three.test/", { fetched_at: T - 2 * HOUR }),
    row("https://four.test/"),
    row("https://five.test/", { fetched_at: T - HOUR }),
    row("https://six.test/"),
    row("https://seven.test/", { fetched_at: T + 5 * HOUR }),
  ];
  const picked = dueFeeds(feeds, T, { ...REFRESH_POLICY, maxFeedsPerWake: 3 });
  deepEqual(
    picked.map((feed) => feed.key),
    ["https://four.test/", "https://six.test/", "https://two.test/"],
    "three stalest",
  );
  equal(picked.length, 3, "cap");
});

await check("a feed that is not due is not picked", () => {
  const picked = dueFeeds([row(FEED_A, { fetched_at: T })], T);
  equal(picked.length, 0, "picked");
});

/* ---------------------------------------------------------------------------
 * A poll that worked.
 * ------------------------------------------------------------------------- */

console.log("\nfetching");
await check("a poll stores the feed's articles", async () => {
  const store = await storeWith([FEED_A]);
  const fetcher = recordingFetcher({
    [FEED_A]: response(
      200,
      rssDocument({
        items: [
          { guid: "a1", title: "First", link: "https://a.test/1", date: "Mon, 20 Nov 2023 10:00:00 GMT" },
          { guid: "a2", title: "Second", link: "https://a.test/2", date: "Tue, 21 Nov 2023 10:00:00 GMT", author: "Someone" },
        ],
      }),
      { etag: '"v1"', "last-modified": "Tue, 21 Nov 2023 10:00:00 GMT" },
    ),
  });

  const report = await refreshDueFeeds({ store, fetch: fetcher, now: T });
  equal(report.wake, "manual", "default reason");
  equal(report.due, 1, "due");
  equal(report.attempted, 1, "attempted");
  equal(report.changed, 1, "changed");
  equal(report.added, 2, "added");
  equal(report.stored, 2, "stored");
  equal(report.failures.length, 0, "failures");

  const page = await store.queryEntries({ feeds: [FEED_A] });
  equal(page.entries.length, 2, "stored entries");
  const first = page.entries.find((entry) => entry.title === "First");
  equal(first.link, "https://a.test/1", "link");
  equal(first.published, 1_700_474_400, "published in seconds");
  equal(first.content, "<p>Body</p>", "content");
  const second = page.entries.find((entry) => entry.title === "Second");
  equal(second.author, "Someone", "author");
});

await check("a poll stamps the feed and keeps its validators", async () => {
  const store = await storeWith([FEED_A]);
  const fetcher = recordingFetcher({
    [FEED_A]: response(200, rssDocument(), {
      etag: '"v1"',
      "last-modified": "Tue, 21 Nov 2023 10:00:00 GMT",
    }),
  });
  await refreshDueFeeds({ store, fetch: fetcher, now: T });
  const feed = await store.feed(FEED_A);
  equal(feed.fetched_at, T, "fetched_at");
  equal(feed.etag, '"v1"', "etag");
  equal(feed.last_modified, "Tue, 21 Nov 2023 10:00:00 GMT", "last modified");
  equal(feed.failures, 0, "failures");
  equal(feed.last_error, null, "last error");
});

await check("the next poll sends the validators back", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetch(FEED_A, { at: T, etag: '"v1"', lastModified: "Tue, 21 Nov 2023 10:00:00 GMT" });
  const fetcher = recordingFetcher({
    [FEED_A]: response(304),
  });
  await refreshDueFeeds({ store, fetch: fetcher, now: T + HOUR });
  deepEqual(fetcher.calls[0].headers["if-none-match"], '"v1"', "if-none-match");
  deepEqual(
    fetcher.calls[0].headers["if-modified-since"],
    "Tue, 21 Nov 2023 10:00:00 GMT",
    "if-modified-since",
  );
});

await check("a 304 moves the feed's clock and stores nothing", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetch(FEED_A, { at: T, etag: '"v1"', failures: 0 });
  const fetcher = recordingFetcher({ [FEED_A]: response(304) });
  const report = await refreshDueFeeds({ store, fetch: fetcher, now: T + HOUR });
  equal(report.notModified, 1, "not modified");
  equal(report.changed, 0, "changed");
  equal(report.added, 0, "added");
  const feed = await store.feed(FEED_A);
  equal(feed.fetched_at, T + HOUR, "stamped");
  equal((await store.queryEntries({ feeds: [FEED_A] })).entries.length, 0, "no articles invented");
});

await check("a 304 clears a failure count", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetchFailure(FEED_A, { at: T, error: "it was down" });
  const fetcher = recordingFetcher({ [FEED_A]: response(304) });
  // Two hours: a feed that failed once waits its doubled interval.
  await refreshDueFeeds({ store, fetch: fetcher, now: T + 2 * HOUR });
  equal((await store.feed(FEED_A)).failures, 0, "failures");
});

await check("a re-poll does not duplicate articles or undo a read mark", async () => {
  const store = await storeWith([FEED_A]);
  const document = rssDocument({ items: [{ guid: "a1", title: "First" }] });
  await refreshDueFeeds({ store, fetch: recordingFetcher({ [FEED_A]: response(200, document) }), now: T });

  const [entry] = (await store.queryEntries({ feeds: [FEED_A] })).entries;
  await store.setRead([entry.key], true);

  const second = await refreshDueFeeds({
    store,
    fetch: recordingFetcher({ [FEED_A]: response(200, document) }),
    now: T + HOUR,
  });
  equal(second.added, 0, "nothing added");
  equal(second.stored, 1, "one re-stored");
  const after = await store.queryEntries({ feeds: [FEED_A] });
  equal(after.entries.length, 1, "still one article");
  equal(after.entries[0].read, 1, "still read");
});

await check("the feed names itself on the first poll, and keeps the name after", async () => {
  const store = await storeWith([FEED_A]);
  const fetcher = recordingFetcher({
    [FEED_A]: response(200, rssDocument({ title: "Named By Itself", site: "https://a.test/" })),
  });
  await refreshDueFeeds({ store, fetch: fetcher, now: T });
  let feed = await store.feed(FEED_A);
  equal(feed.title, "Named By Itself", "title from the feed");
  equal(feed.title_source, "feed", "title source");
  equal(feed.html_url, "https://a.test/", "site address");

  await refreshDueFeeds({
    store,
    fetch: recordingFetcher({ [FEED_A]: response(200, rssDocument({ title: "Renamed" })) }),
    now: T + 2 * HOUR,
  });
  feed = await store.feed(FEED_A);
  equal(feed.title, "Named By Itself", "a later poll does not rename a known feed");
});

await check("a title the reader typed is never overwritten", async () => {
  const store = await storeWith([FEED_A], { [FEED_A]: "My comics" });
  await refreshDueFeeds({
    store,
    fetch: recordingFetcher({ [FEED_A]: response(200, rssDocument({ title: "The Site's Name" })) }),
    now: T,
  });
  const feed = await store.feed(FEED_A);
  equal(feed.title, "My comics", "kept");
  equal(feed.title_source, "given", "source");
});

/* ---------------------------------------------------------------------------
 * A poll that did not.
 * ------------------------------------------------------------------------- */

console.log("\nfailures");
await check("a 500 is recorded on that feed and does not stop the next one", async () => {
  const store = await storeWith([FEED_A, FEED_B]);
  const fetcher = recordingFetcher({
    [FEED_A]: response(500),
    [FEED_B]: response(200, rssDocument({ items: [{ guid: "b1" }] })),
  });
  const report = await refreshDueFeeds({ store, fetch: fetcher, now: T });
  equal(report.failures.length, 1, "one failure");
  equal(report.failures[0].feedUrl, FEED_A, "the feed that failed");
  equal(report.changed, 1, "the other feed still landed");
  const feedA = await store.feed(FEED_A);
  equal(feedA.failures, 1, "failure counted");
  equal(feedA.fetched_at, null, "no success recorded");
  if (!/answered 500/.test(feedA.last_error)) fail(`last_error: ${feedA.last_error}`);
});

await check("a web page where a feed should be is a failure, not an empty feed", async () => {
  const store = await storeWith([FEED_A]);
  const report = await refreshDueFeeds({
    store,
    fetch: recordingFetcher({ [FEED_A]: response(200, "<!doctype html><html><body>hi</body></html>") }),
    now: T,
  });
  equal(report.failures.length, 1, "failure");
  if (!/not a feed/.test(report.failures[0].reason)) fail(`reason: ${report.failures[0].reason}`);
  equal((await store.queryEntries({ feeds: [FEED_A] })).entries.length, 0, "nothing stored");
});

await check("a network error is a failure on that feed and nothing thrown", async () => {
  const store = await storeWith([FEED_A]);
  const report = await refreshDueFeeds({
    store,
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND a.test");
    },
    now: T,
  });
  equal(report.failures.length, 1, "failure");
  if (!/could not be reached/.test(report.failures[0].reason)) fail(`reason: ${report.failures[0].reason}`);
  if (!/ENOTFOUND/.test(report.failures[0].reason)) fail("the cause is kept in the reason");
});

await check("a feed that never answers times out as a failure", async () => {
  const store = await storeWith([FEED_A]);
  const report = await refreshDueFeeds({
    store,
    policy: { ...REFRESH_POLICY, timeoutMs: 5 },
    fetch: (_url, request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    now: T,
  });
  equal(report.failures.length, 1, "failure");
  if (!/did not answer/.test(report.failures[0].reason)) fail(`reason: ${report.failures[0].reason}`);
});

await check("a feed that sends headers then stalls also times out", async () => {
  const store = await storeWith([FEED_A]);
  const report = await refreshDueFeeds({
    store,
    policy: { ...REFRESH_POLICY, timeoutMs: 5 },
    fetch: (_url, request) => ({
      status: 200,
      headers: { get: () => null },
      text: () =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
    now: T,
  });
  equal(report.failures.length, 1, "failure");
  if (!/did not answer/.test(report.failures[0].reason)) fail(`reason: ${report.failures[0].reason}`);
});

await check("a feed that keeps failing is left alone for longer", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetchFailure(FEED_A, { at: T, error: "down" });
  const fetcher = recordingFetcher({ [FEED_A]: response(200, rssDocument()) });

  const soon = await refreshDueFeeds({ store, fetch: fetcher, now: T + HOUR });
  equal(soon.due, 0, "not due an hour after a failure");
  equal(fetcher.calls.length, 0, "no request");

  const later = await refreshDueFeeds({ store, fetch: fetcher, now: T + 2 * HOUR });
  equal(later.due, 1, "due at the doubled interval");
  equal(later.changed, 1, "and it recovers");
  equal((await store.feed(FEED_A)).failures, 0, "the failure count is cleared");
});

await check("being offline attempts nothing and blames no feed", async () => {
  const store = await storeWith([FEED_A]);
  const fetcher = recordingFetcher({ [FEED_A]: response(200, rssDocument()) });
  const report = await refreshDueFeeds({ store, fetch: fetcher, now: T, online: () => false });
  equal(report.skipped, "offline", "skipped");
  equal(report.attempted, 0, "attempted");
  equal(fetcher.calls.length, 0, "no request");
  equal((await store.feed(FEED_A)).failures, 0, "the feed is not blamed");
});

await check("an abandoned wake stops before the next feed", async () => {
  const store = await storeWith([FEED_A, FEED_B]);
  const controller = new AbortController();
  const fetcher = recordingFetcher({
    [FEED_A]: () => {
      controller.abort();
      return response(200, rssDocument({ items: [{ guid: "a1" }] }));
    },
    [FEED_B]: response(200, rssDocument({ items: [{ guid: "b1" }] })),
  });
  const report = await refreshDueFeeds({ store, fetch: fetcher, now: T, signal: controller.signal });
  equal(report.aborted, true, "aborted");
  equal(report.attempted, 1, "attempted once");
  equal(fetcher.calls.length, 1, "one request");
});

/* ---------------------------------------------------------------------------
 * The waking contract.
 * ------------------------------------------------------------------------- */

console.log("\nwaking");
await check("two wakes at once share one poll", async () => {
  const store = await storeWith([FEED_A]);
  const fetcher = recordingFetcher({ [FEED_A]: response(200, rssDocument({ items: [{ guid: "a1" }] })) });
  const refresher = createRefresher({ store, fetch: fetcher, now: () => T });

  const first = refresher.wake("launch");
  const second = refresher.wake("resume");
  equal(refresher.running(), true, "running while in flight");
  const [a, b] = await Promise.all([first, second]);
  equal(fetcher.calls.length, 1, "one request, not two");
  equal(a, b, "the same report");
  equal(a.wake, "launch", "named by the wake that started it");
  equal(refresher.running(), false, "idle afterwards");
});

await check("a wake with nothing due costs nothing", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetch(FEED_A, { at: T });
  const fetcher = recordingFetcher({ [FEED_A]: response(200, rssDocument()) });
  const refresher = createRefresher({ store, fetch: fetcher, now: () => T + 10 * MINUTE });
  const report = await refresher.wake("background");
  equal(report.attempted, 0, "attempted");
  equal(fetcher.calls.length, 0, "no request");
});

await check("a wake after the interval fetches, and says what woke it", async () => {
  const store = await storeWith([FEED_A]);
  await store.recordFetch(FEED_A, { at: T });
  const fetcher = recordingFetcher({ [FEED_A]: response(200, rssDocument({ items: [{ guid: "a1" }] })) });
  const refresher = createRefresher({ store, fetch: fetcher, now: () => T + 2 * HOUR });
  const report = await refresher.wake("background");
  equal(report.attempted, 1, "attempted");
  equal(report.wake, "background", "reason");
  equal(report.added, 1, "added");
});

await check("a store with no feeds is a wake that does nothing", async () => {
  const store = new LocalStore(new MemoryDatabase());
  const report = await refreshDueFeeds({ store, fetch: async () => response(200, ""), now: T });
  equal(report.due, 0, "due");
  equal(report.attempted, 0, "attempted");
});

/* ---------------------------------------------------------------------------
 * The columns a poll needs, on a database that predates them.
 * ------------------------------------------------------------------------- */

console.log("\nmigration");

/** `ensureColumns` against Node's own SQLite, which speaks the same dialect. */
class NodeSql {
  constructor(db) {
    this.db = db;
  }
  async execute(query, values = []) {
    this.db.prepare(query).run(...values);
  }
  async select(query, values = []) {
    return this.db.prepare(query).all(...values);
  }
}

let sqlite = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new NodeSql(new DatabaseSync(":memory:"));
} catch {
  console.log("sqlite (skipped: this Node has no node:sqlite)");
}

if (sqlite !== null) {
  await check("a feeds table from before the poll columns gains them", async () => {
    await sqlite.execute(
      'CREATE TABLE "feeds" ("key" TEXT PRIMARY KEY NOT NULL, "title" TEXT, "added_at" INTEGER)',
    );
    const added = await ensureColumns(sqlite, "feeds");
    deepEqual(
      added,
      [
        "html_url",
        "icon_url",
        "folder",
        "title_source",
        "fetched_at",
        "attempted_at",
        "etag",
        "last_modified",
        "failures",
        "last_error",
        "resolved_url",
      ],
      "added columns",
    );
    const declared = TABLES.feeds.columns.map((column) => column.name);
    const present = (await sqlite.select("SELECT name FROM pragma_table_info('feeds')")).map(
      (row) => row.name,
    );
    equal(
      present.length,
      declared.length + 1,
      "every declared column plus the key",
    );
  });

  await check("running it again adds nothing", async () => {
    deepEqual(await ensureColumns(sqlite, "feeds"), [], "idempotent");
  });

  await check("a row with the poll columns can be written after the migration", async () => {
    const columns = ["key", ...TABLES.feeds.columns.map((column) => column.name)];
    const values = columns.map((column) => (column === "key" ? "https://a.test/rss" : null));
    // Positional `?` here: this insert is the suite's own, run through Node's
    // SQLite, which binds positionally to anonymous parameters.
    const placeholders = columns.map(() => "?").join(", ");
    await sqlite.execute(
      `INSERT INTO "feeds" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${placeholders})`,
      values,
    );
    const [stored] = await sqlite.select('SELECT * FROM "feeds"');
    equal(stored.key, "https://a.test/rss", "the row");
    equal("fetched_at" in stored, true, "the new column is there");
  });
}

console.log(`\n${passed} checks passed`);
