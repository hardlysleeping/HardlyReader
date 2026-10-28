/**
 * Local mode: two devices, one folder.
 *
 * A local library has no server behind it, so the only way two devices can agree
 * about what has been read is the document `src/api/local/sync.ts` puts in a
 * folder the reader already syncs. What is worth pinning here is everything that
 * document can get *wrong*: a mark that arrives as an unmark, a delete undone by
 * a rename, a feed that loses its name, a newer build's file overwritten, an
 * article body dragged along for the ride.
 *
 * Every check drives two real `LocalStore`s over the in-memory driver and one
 * shared `MemorySyncProvider` — the same merge code the app runs, against the
 * same queries, with the clock passed in rather than waited for. The provider is
 * the seam `syncOnce` takes; a memory one stands in for the shared folder.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-sync.mjs
 */
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import {
  MARK_RETENTION_SECONDS,
  SYNC_FILE_NAME,
  SYNC_VERSION,
  TOMBSTONE_SECONDS,
  applySnapshot,
  buildSnapshot,
  compareStamps,
  emptySnapshot,
  mergeSnapshots,
  parseSyncSnapshot,
  pruneSnapshot,
  serializeSnapshot,
  syncOnce,
} from "../../src/api/local/sync.ts";
import { emptyPrefs, withEntry } from "../../src/lib/prefs-sync.ts";
import { emptyPlace, emptySidebar } from "../../src/lib/sidebar-doc.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

function truthy(value, what) {
  if (!value) fail(`${what}: expected something, got ${JSON.stringify(value)}`);
}

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/**
 * One device: a library, the last agreement it reached, and its settings.
 *
 * `base` is what the app persists after a sync, and leaving it out of a test
 * would make every sync look like a first sync — which is exactly the bug the
 * base exists to prevent, so it is modelled rather than skipped.
 */
function device(name, { identity } = {}) {
  const database = new MemoryDatabase();
  const store = new LocalStore(database);
  return {
    name,
    store,
    database,
    base: null,
    prefs: emptyPrefs(),
    adopted: [],
    /**
     * The identity this device writes under, or undefined to let the library
     * answer — which is what the app does, and what the restart check relies on.
     */
    identity,
    async sync(provider, at) {
      const run = await syncOnce({
        store,
        provider,
        device: name,
        base: this.base,
        now: at,
        identity: this.identity,
        prefs: {
          local: this.prefs,
          adopt: (doc, namespaces) => {
            this.prefs = doc;
            this.adopted.push(...namespaces);
          },
        },
      });
      this.base = run.snapshot;
      return run;
    },
  };
}

/**
 * The same library, opened again.
 *
 * A restart is a new process over the same rows: a new `LocalStore` over the
 * same database, with the agreement and the settings it had before — and, if the
 * device id and the revision counter live where they should, the same identity
 * and a counter that keeps counting.
 */
function reopen(dev) {
  return { ...dev, store: new LocalStore(dev.database) };
}

/** A feed with a chosen title source, as `subscribe` would have left it. */
async function addFeed(dev, url, { title, folder = null } = {}) {
  await dev.store.subscribe(url, { title, folder });
  return url;
}

/**
 * An article on a device, with the time this device stored it.
 *
 * `stored_at` is what tells a mark apart from an arrival — a post fetched after
 * the last agreement has never been compared, so its unread state must not read
 * as an unmark. `putEntries` stamps it with the real clock, so it is written
 * back here to the second the check is about.
 */
async function addEntry(dev, feedUrl, guid, { storedAt = T - 10 } = {}) {
  await dev.store.putEntries([{ feedUrl, guid, title: `Post ${guid}`, published: T - 60 }]);
  const id = localItemId(feedUrl, guid);
  const row = await dev.database.get("entries", id);
  await dev.database.write([{ type: "put", table: "entries", row: { ...row, stored_at: storedAt } }]);
  return id;
}

async function entryOf(dev, id) {
  return dev.store.entry(id);
}

async function feedUrls(dev) {
  return (await dev.store.feeds()).map((feed) => feed.key).sort();
}

/* --------------------------------------------------------------------------
 * The document itself
 * ----------------------------------------------------------------------- */

await check("a first sync writes the document, and the second device adopts it", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  await addFeed(a, FEED_B);
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);

  const first = await a.sync(folder, T + 100);
  equal(folder.writes.length, 1, "one write for the first sync");
  equal(first.unchanged, false, "a folder with nothing in it is not unchanged");
  equal(first.snapshot.feeds[FEED_A].folder, "Funny books", "the feed's folder travelled");
  equal(first.snapshot.marks[post].read, true, "the read mark travelled");

  const second = await b.sync(folder, T + 101);
  deepEqual(await feedUrls(b), [FEED_A, FEED_B], "the tablet's subscriptions");
  deepEqual(
    (await b.store.folders()).map((row) => row.key),
    ["Funny books"],
    "the tablet's folders",
  );
  equal(second.applied.marksSkipped, 1, "a mark for an article the tablet does not hold");
  truthy(
    second.snapshot.marks[post] !== undefined,
    "the mark stays in the document for the device that has the article",
  );
});

await check("a sync that changes nothing does not touch the folder", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(folder, T + 100);

  const writes = folder.writes.length;
  const quiet = await a.sync(folder, T + 200);
  equal(quiet.unchanged, true, "a second sync with nothing changed");
  equal(folder.writes.length, writes, "writes to the folder");

  // A cloud folder uploads every write; ten launches a day must not be ten
  // uploads of a document nothing changed in.
  equal(JSON.parse(folder.peek()).writtenAt, T + 100, "the document still carries the first write's time");
});

await check("the document carries reading state and not the fetching engine", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.store.putEntries([
    {
      feedUrl: FEED_A,
      guid: "p1",
      title: "A post",
      content: "<p>the body of the article</p>",
      summary: "the summary",
    },
  ]);
  await a.sync(folder, T + 100);

  const written = folder.peek();
  truthy(!written.includes("the body of the article"), "the article body must not travel");
  truthy(!written.includes("the summary"), "the summary must not travel");
  const document = JSON.parse(written);
  equal("etag" in document.feeds[FEED_A], false, "a feed's validators");
  equal("fetched_at" in document.feeds[FEED_A], false, "a feed's poll time");
});

await check("a feed adopted from the folder has not been fetched here", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.store.recordFetch(FEED_A, { at: T + 90, etag: '"v1"', title: "Comics from the feed" });
  await a.sync(folder, T + 100);

  await b.sync(folder, T + 101);
  const adopted = await b.store.feed(FEED_A);
  equal(adopted.fetched_at, null, "the adopted feed's poll time");
  equal(adopted.etag, null, "the adopted feed's validators");
  equal(adopted.title, "Comics", "the adopted feed's title");
});

/* --------------------------------------------------------------------------
 * Marks
 * ----------------------------------------------------------------------- */

await check("read on one device and starred on the other both survive", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  await a.sync(folder, T + 100);

  await b.sync(folder, T + 101);
  // The tablet fetches the post afterwards, as a second device does.
  await addEntry(b, FEED_A, "p1", { storedAt: T + 150 });
  await b.store.setStarred([post], true);
  await b.sync(folder, T + 200);

  await a.sync(folder, T + 201);
  const onA = await entryOf(a, post);
  equal(onA.read, 1, "the laptop still has it read");
  equal(onA.starred, 1, "the laptop picked up the star");

  const onB = await entryOf(b, post);
  equal(onB.read, 1, "the tablet picked up the read mark");
  equal(onB.starred, 1, "the tablet still has its star");
});

await check("an unstar travels, and a newer mark wins over an older one", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setStarred([post], true);
  await a.sync(folder, T + 100);

  await b.sync(folder, T + 101);
  await addEntry(b, FEED_A, "p1", { storedAt: T + 150 });
  await b.sync(folder, T + 200);
  equal((await entryOf(b, post)).starred, 1, "the tablet took the star");

  // The laptop takes it off; that is a change, not an absence of one.
  await a.store.setStarred([post], false);
  await a.sync(folder, T + 300);
  await b.sync(folder, T + 301);
  equal((await entryOf(b, post)).starred, 0, "the unstar reached the tablet");

  // And the newer direction wins: starred again on the tablet.
  await b.store.setStarred([post], true);
  await b.sync(folder, T + 400);
  await a.sync(folder, T + 401);
  equal((await entryOf(a, post)).starred, 1, "the newer star reached the laptop");
});

await check("an article that arrived after the agreement inherits the mark instead of clearing it", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);
  equal(b.base.writtenAt, T + 101, "the tablet's agreement was written at 101");

  // The tablet fetches the post afterwards. `putEntries` writes it unread, and
  // that is a fetch, not a reader deciding the article is unread again.
  await addEntry(b, FEED_A, "p1", { storedAt: T + 150 });
  const run = await b.sync(folder, T + 200);
  equal((await entryOf(b, post)).read, 1, "the tablet's fresh copy picked up the read mark");
  equal(run.snapshot.marks[post].read, true, "the document was not unmarked by an arrival");

  await a.sync(folder, T + 201);
  equal((await entryOf(a, post)).read, 1, "the laptop's mark is intact");
});

await check("a mark for an article this device holds lands when it is fetched later", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setStarred([post], true);
  await a.sync(folder, T + 100);

  await b.sync(folder, T + 101);
  const skipped = await b.sync(folder, T + 102);
  equal(skipped.applied.marksSkipped, 1, "nothing to mark on the tablet yet");

  await addEntry(b, FEED_A, "p1", { storedAt: T + 150 });
  await b.sync(folder, T + 200);
  equal((await entryOf(b, post)).starred, 1, "the star landed once the article was there");
});

/* --------------------------------------------------------------------------
 * Subscriptions and removals
 * ----------------------------------------------------------------------- */

await check("a removed feed stays removed when the other device renames it", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);

  await a.store.unsubscribe(FEED_A);
  await b.store.subscribe(FEED_B, { title: "Other" });
  await b.store.moveFeed(FEED_A, "Filed", null);

  await b.sync(folder, T + 102);
  const removal = await a.sync(folder, T + 103);
  // The laptop already removed it locally, so there is nothing left to remove
  // there; what matters is that the tablet's edit did not resurrect it.
  deepEqual(removal.applied.feedsAdded, [FEED_B], "the laptop took the tablet's new feed");
  deepEqual(await feedUrls(a), [FEED_B], "the laptop's subscriptions after the merge");
  equal(removal.snapshot.feeds[FEED_A].removed, true, "the tombstone is in the document");

  // The tablet sees the tombstone and takes the feed out too: a rename on the
  // other device is an edit, not a re-subscription.
  const follow = await b.sync(folder, T + 104);
  deepEqual(follow.applied.feedsRemoved, [FEED_A], "the tablet removed it");
  deepEqual(await feedUrls(b), [FEED_B], "the tablet's subscriptions");
});

await check("a device that has seen the tombstone can subscribe again", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);

  await a.store.unsubscribe(FEED_A);
  await a.sync(folder, T + 102);
  await b.sync(folder, T + 103);
  equal((await b.store.feed(FEED_A)), null, "the tablet dropped it");

  // Subscribing again after seeing the tombstone is a decision of its own.
  await b.store.subscribe(FEED_A, { title: "Comics again" });
  await b.sync(folder, T + 200);
  const back = await a.sync(folder, T + 201);
  deepEqual(back.applied.feedsAdded, [FEED_A], "the laptop took it back");
  equal((await a.store.feed(FEED_A)).title, "Comics again", "with the new title");
});

await check("a URL-derived title is not adopted as a choice the reader made", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  // Added but never fetched: the title is the host standing in, and the sync
  // must not freeze it as if the reader had typed it.
  await addFeed(a, FEED_A);
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);

  const adopted = await b.store.feed(FEED_A);
  equal(adopted.title_source, "url", "the adopted row's title source");

  await b.store.recordFetch(FEED_A, { at: T + 150, title: "The real name" });
  equal((await b.store.feed(FEED_A)).title, "The real name", "the first fetch can still name it");
});

await check("a refile on one device reaches the other", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);

  await a.store.moveFeed(FEED_A, "Funny books", null);
  await a.sync(folder, T + 102);
  const moved = await b.sync(folder, T + 103);
  deepEqual(moved.applied.feedsMoved, [FEED_A], "the tablet moved it");
  equal((await b.store.feed(FEED_A)).folder, "Funny books", "the tablet's folder");
});

await check("an empty folder travels, and a folder emptied remotely goes", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await a.store.ensureFolder("Empty shelf");
  await a.sync(folder, T + 100);
  const arrived = await b.sync(folder, T + 101);
  deepEqual(arrived.applied.foldersAdded, ["Empty shelf"], "the tablet created it");

  await a.store.forgetFolder("Empty shelf");
  await a.sync(folder, T + 102);
  const gone = await b.sync(folder, T + 103);
  deepEqual(gone.applied.foldersRemoved, ["Empty shelf"], "the tablet removed it");
  equal((await b.store.folders()).length, 0, "the tablet's folders");
});

await check("a folder holding a feed is never forgotten", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  equal(await a.store.forgetFolder("Funny books"), false, "forgetting an occupied folder");
  equal((await a.store.folders()).length, 1, "the folder is still there");
  await a.sync(folder, T + 100);
});

/* --------------------------------------------------------------------------
 * Settings
 * ----------------------------------------------------------------------- */

await check("a newer settings document wins, and the loser is told", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  a.prefs = withEntry(emptyPrefs(), "theme", { updatedAt: 900, value: { accent: "crimson" } });
  b.prefs = withEntry(emptyPrefs(), "theme", { updatedAt: 500, value: { accent: "teal" } });

  await a.sync(folder, T + 100);
  const run = await b.sync(folder, T + 101);

  deepEqual(run.snapshot.prefs.entries.theme.value, { accent: "crimson" }, "the folder's colours");
  deepEqual(b.prefs.entries.theme.value, { accent: "crimson" }, "the tablet adopted them");
  equal(b.adopted.includes("theme"), true, "the tablet was told it adopted a namespace");
  truthy(
    run.conflicts.some((conflict) => conflict.group === "prefs" && conflict.kept === "folder"),
    "the dropped copy is reported",
  );
});

await check("a settings namespace the other device never set travels without a fight", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  a.prefs = withEntry(emptyPrefs(), "reading", { updatedAt: 700, value: { textScale: 1.2 } });
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);
  deepEqual(b.prefs.entries.reading.value, { textScale: 1.2 }, "the tablet's text size");
  equal(b.adopted.includes("reading"), true, "reported as adopted");
});

/* --------------------------------------------------------------------------
 * Refusals
 * ----------------------------------------------------------------------- */

await check("a document from a newer build is refused and left alone", async () => {
  const folder = new MemorySyncProvider(JSON.stringify({ version: SYNC_VERSION + 1, feeds: {} }));
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });

  let refused = "";
  try {
    await a.sync(folder, T + 100);
  } catch (error) {
    refused = error.message;
  }
  truthy(refused.includes("newer version"), `the refusal: ${refused}`);
  equal(folder.writes.length, 0, "nothing was written over it");
});

await check("a file that is not a document is refused and left alone", async () => {
  const folder = new MemorySyncProvider("half a file, truncated by a cloud client");
  const a = device("laptop");
  let refused = "";
  try {
    await a.sync(folder, T + 100);
  } catch (error) {
    refused = error.message;
  }
  truthy(refused.includes("not readable"), `the refusal: ${refused}`);
  equal(folder.writes.length, 0, "nothing was written over it");
});

await check("a record this build cannot read is dropped and the rest still arrives", async () => {
  const document = {
    version: SYNC_VERSION,
    device: "tablet",
    writtenAt: T,
    feeds: {
      [FEED_A]: { at: T, title: "Comics", titleSource: "given", folder: null, addedAt: T, removed: false },
      "https://broken.test/rss": { at: "yesterday", title: 42 },
    },
    folders: {},
    marks: {},
    prefs: { entries: {} },
  };
  const parsed = parseSyncSnapshot(JSON.stringify(document));
  equal(Object.keys(parsed.feeds).length, 1, "the readable feed survived");
  equal(parsed.feeds[FEED_A].title, "Comics", "its title");
});

/* --------------------------------------------------------------------------
 * Converging
 * ----------------------------------------------------------------------- */

await check("two devices editing the same field in the same second settle on one answer", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Original" });
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);

  // Same second, different answers: the tie has to be broken by the records
  // themselves, or the two devices flap the name between them forever.
  const aRow = await a.store.feed(FEED_A);
  const bRow = await b.store.feed(FEED_A);
  await a.database.write([
    { type: "put", table: "feeds", row: { ...aRow, title: "Zeta", title_source: "given" } },
  ]);
  await b.database.write([
    { type: "put", table: "feeds", row: { ...bRow, title: "Alpha", title_source: "given" } },
  ]);

  await a.sync(folder, T + 200);
  await b.sync(folder, T + 200);
  await a.sync(folder, T + 201);
  await b.sync(folder, T + 202);

  equal((await a.store.feed(FEED_A)).title, (await b.store.feed(FEED_A)).title, "both devices agree");
});

await check("the merge is decided by the record, not by which side it came from", async () => {
  const base = emptySnapshot("laptop", T);
  base.feeds[FEED_A] = { at: T, title: "Original", titleSource: "given", folder: null, addedAt: T, removed: false };

  const local = emptySnapshot("laptop", T + 10);
  local.feeds[FEED_A] = { ...base.feeds[FEED_A], at: T + 10, title: "Newer here" };
  const remote = emptySnapshot("tablet", T + 5);
  remote.feeds[FEED_A] = { ...base.feeds[FEED_A], at: T + 5, title: "Older there" };

  const merged = mergeSnapshots(local, remote, base);
  equal(merged.snapshot.feeds[FEED_A].title, "Newer here", "the newer record");
  equal(merged.conflicts.length, 1, "one conflict reported");

  const reversed = mergeSnapshots(remote, local, base);
  equal(reversed.snapshot.feeds[FEED_A].title, "Newer here", "the same answer from the other side");
});

await check("a sync leaves the articles themselves alone", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics" });
  await a.store.putEntries([
    { feedUrl: FEED_A, guid: "p1", title: "A post", content: "<p>kept</p>", summary: "kept too" },
  ]);
  await a.sync(folder, T + 100);
  await b.sync(folder, T + 101);
  await a.store.setRead([localItemId(FEED_A, "p1")], true);
  await a.sync(folder, T + 102);

  const row = await entryOf(a, localItemId(FEED_A, "p1"));
  equal(row.content, "<p>kept</p>", "the body this device fetched");
  equal(row.summary, "kept too", "the summary this device fetched");
});

/* --------------------------------------------------------------------------
 * Pruning, and the file's name
 * ----------------------------------------------------------------------- */

await check("an old tombstone and an old unmark are dropped, a live mark is not", async () => {
  const snapshot = emptySnapshot("laptop", T);
  snapshot.feeds[FEED_A] = { at: T, title: "Old", titleSource: "given", folder: null, addedAt: T, removed: true };
  snapshot.feeds[FEED_B] = { at: T, title: "Gone", titleSource: "given", folder: null, addedAt: T, removed: true };
  snapshot.marks["local/x/y"] = { read: false, readAt: T, starred: false, starredAt: T };
  snapshot.marks["local/x/z"] = { read: true, readAt: T, starred: false, starredAt: 0 };

  const later = T + TOMBSTONE_SECONDS + MARK_RETENTION_SECONDS + 10;
  const pruned = pruneSnapshot(snapshot, later);
  equal(pruned.feeds[FEED_A], undefined, "the expired tombstone");
  equal(pruned.feeds[FEED_B], undefined, "the other expired tombstone");
  equal(pruned.marks["local/x/y"], undefined, "the expired unmark");
  truthy(pruned.marks["local/x/z"] !== undefined, "a read mark is never expired");
});

await check("the document's name is the one Rust writes", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const rust = readFileSync(join(here, "..", "..", "src-tauri", "src", "sync.rs"), "utf8");
  const declared = /pub const SYNC_FILE_NAME: &str = "([^"]+)"/.exec(rust);
  truthy(declared !== null, "the Rust constant");
  equal(declared[1], SYNC_FILE_NAME, "the two spellings");
});

await check("a document round-trips through its own serialization", async () => {
  const snapshot = emptySnapshot("laptop", T);
  snapshot.feeds[FEED_A] = {
    at: T,
    rev: 12,
    by: "device-laptop",
    title: "Comics",
    titleSource: "given",
    folder: "Funny books",
    addedAt: T,
    removed: false,
  };
  snapshot.marks["local/x/y"] = {
    read: true,
    readAt: T,
    starred: true,
    starredAt: T + 1,
    rev: 12,
    by: "device-laptop",
  };
  const parsed = parseSyncSnapshot(serializeSnapshot(snapshot));
  deepEqual(parsed.feeds, snapshot.feeds, "the feeds");
  deepEqual(parsed.marks, snapshot.marks, "the marks");
});

await check("applySnapshot writes marks but refuses nothing it does not hold", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");

  const snapshot = emptySnapshot("tablet", T);
  snapshot.marks[post] = { read: true, readAt: T, starred: false, starredAt: 0 };
  snapshot.marks["local/missing/article"] = { read: true, readAt: T, starred: false, starredAt: 0 };

  const report = await applySnapshot(a.store, snapshot);
  equal(report.marksApplied, 1, "the mark that landed");
  equal(report.marksSkipped, 1, "the mark that had nowhere to land");
  equal((await entryOf(a, post)).read, 1, "the article is read");
});

await check("buildSnapshot leaves an unchanged record's stamp alone", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const base = buildSnapshot({
    rows: { feeds: await a.store.feeds(), folders: await a.store.folders(), entries: await a.store.entryFlags() },
    base: null,
    prefs: emptyPrefs(),
    device: "laptop",
    now: T,
  });
  const again = buildSnapshot({
    rows: { feeds: await a.store.feeds(), folders: await a.store.folders(), entries: await a.store.entryFlags() },
    base,
    prefs: emptyPrefs(),
    device: "laptop",
    now: T + 500,
  });
  equal(again.feeds[FEED_A].at, T, "an unchanged feed keeps the time it was agreed by");
});

/* --------------------------------------------------------------------------
 * The lock, which is per device and never in the document
 * ----------------------------------------------------------------------- */

/**
 * The document's own fields, written down.
 *
 * A sync document is a JSON file in a folder the reader's cloud client mirrors,
 * so every field added here is a field copied into the provider, its version
 * history and its backups. The lock is what settled the rule: `docs/authority.md`
 * says the passcode is a curtain the reader keeps on the device, and these two
 * lists make adding one a failing test rather than a diff nobody read. A field
 * that is neither of these is a decision too — read the doc before extending
 * either list.
 */
const DOCUMENT_FIELDS = [
  "device",
  "feeds",
  "folders",
  "marks",
  "place",
  "prefs",
  "redirects",
  "sidebar",
  "version",
  "writtenAt",
];
const SIDEBAR_FIELDS = [
  "at",
  "by",
  "categoryOrder",
  "feedOrder",
  "hidden",
  "hiddenView",
  "indentPx",
  "pinFeeds",
  "pinView",
  "pins",
  "rev",
];

/**
 * A name a lock or a passcode would be carried under.
 *
 * Deliberately generous: `locked`, `passcode`, `passphrase`, `secret`, `salt`,
 * `keypad` and the pad's own spelling all fail. `pins` and `pinFeeds` do not —
 * a pin is a sidebar mark, not a code.
 */
const LOCK_SHAPED = /passcode|passphrase|password|lock|secret|salt|keypad|pinpad/i;

/** Every object key in a document, at every depth, as `sidebar.hidden`. */
function documentKeys(value, path = "", into = []) {
  if (Array.isArray(value)) {
    for (const entry of value) documentKeys(entry, `${path}[]`, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, entry] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    into.push(here);
    documentKeys(entry, here, into);
  }
  return into;
}

/** The lock-shaped keys in a document, by their own name, at any depth. */
function lockShapedKeys(document) {
  return documentKeys(document).filter((key) => LOCK_SHAPED.test(key.split(".").pop() ?? ""));
}

await check("the document carries no lock and no passcode, at any depth", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);

  // Every half of the document filled in, because the scan is only worth
  // anything on a document that has somewhere to hide one. The sidebar and the
  // place are built by spreading `emptySidebar()` / `emptyPlace()` rather than
  // written out: a field added to the model must turn up here, and a literal
  // would quietly keep passing while the app started carrying it.
  const document = buildSnapshot({
    rows: {
      feeds: await a.store.feeds(),
      folders: await a.store.folders(),
      entries: await a.store.entryFlags(),
    },
    base: null,
    prefs: emptyPrefs(),
    device: "laptop",
    now: T,
    sidebar: { ...emptySidebar(), hidden: ["Filters"], pins: ["Comics"], indentPx: 12 },
    place: {
      ...emptyPlace(),
      streamId: FEED_A,
      streamTitle: "Comics",
      articleId: post,
      articleScroll: 40,
    },
  });

  const written = JSON.parse(serializeSnapshot(document));
  deepEqual(Object.keys(written).sort(), DOCUMENT_FIELDS, "the document's fields");
  deepEqual(Object.keys(written.sidebar).sort(), SIDEBAR_FIELDS, "the arrangement's fields");
  deepEqual(lockShapedKeys(written), [], "a lock-shaped field in the document");
  // The categories are the feature and they do travel; only the code that lifts
  // the curtain stays behind.
  deepEqual(written.sidebar.hidden, ["Filters"], "the hidden categories in the document");
});

await check("a lock-shaped field found in the file is dropped, and gone when rewritten", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(folder, T + 100);

  // A newer build, or a person with a text editor, puts a lock in the file.
  const raw = JSON.parse(folder.peek());
  raw.passcode = "1234";
  raw.locked = true;
  raw.sidebar = { at: T + 100, locked: true, passcode: "1234", ...(raw.sidebar ?? {}) };
  await folder.write(JSON.stringify(raw));

  const parsed = parseSyncSnapshot(await folder.read());
  deepEqual(lockShapedKeys(parsed), [], "a lock-shaped field after reading the file");
  equal("passcode" in parsed, false, "a passcode on the parsed document");

  // A change here, so the document is written again rather than left as it was.
  await addFeed(a, FEED_B, { title: "Other" });
  await a.sync(folder, T + 200);

  // The lock never gets a foothold in the folder: what this build writes is
  // what it read back into its own model, and that model has no such field.
  const rewritten = folder.peek();
  truthy(!rewritten.includes("1234"), "the passcode in the folder's copy");
  truthy(!rewritten.includes('"locked"'), "the locked flag in the folder's copy");
  deepEqual(lockShapedKeys(JSON.parse(rewritten)), [], "a lock-shaped field after a rewrite");
});

/* --------------------------------------------------------------------------
 * Revisions, not just clocks
 *
 * Two traps, and they pull in opposite directions. A phone whose clock is ten
 * minutes fast must not win every argument it enters (#19); a device that has
 * been away for a week must not lose the edits it made while it was away. A
 * second alone cannot answer both, so a record carries `(at, rev, by)` and no
 * change is ever dated earlier than one second past what its device has seen.
 * ----------------------------------------------------------------------- */

/** One feed record with nothing but the fields this group of checks cares about. */
function feedRecord(stamp, title) {
  return { ...stamp, title, titleSource: "given", folder: null, addedAt: T, removed: false };
}

/** A device's copy of the document, holding one record. */
function documentWith(device, record) {
  return { ...emptySnapshot(device, T), feeds: { [FEED_A]: record } };
}

await check("a record is ordered by its second, then its revision, then its device", async () => {
  // The comparison itself has to be antisymmetric, or two devices hand the same
  // record back and forth forever: whichever side asks, the answer is the same.
  const pairs = [
    [{ at: T, rev: 1, by: "a" }, { at: T, rev: 2, by: "a" }],
    [{ at: T, rev: 2, by: "a" }, { at: T, rev: 2, by: "b" }],
    [{ at: T + 1, rev: 0, by: "" }, { at: T, rev: 9, by: "z" }],
    [{ at: T, rev: 0, by: "" }, { at: T, rev: 0, by: "" }],
  ];
  for (const [a, b] of pairs) {
    equal(
      compareStamps(a, b),
      -compareStamps(b, a),
      `antisymmetric for ${JSON.stringify(a)} against ${JSON.stringify(b)}`,
    );
  }

  // The later second decides, whatever the revision says.
  const later = feedRecord({ at: T + 5, rev: 1, by: "device-a" }, "Later, low revision");
  const earlier = feedRecord({ at: T + 4, rev: 99, by: "device-z" }, "Earlier, high revision");
  equal(
    mergeSnapshots(documentWith("laptop", later), documentWith("tablet", earlier), null).snapshot.feeds[
      FEED_A
    ].title,
    "Later, low revision",
    "the later second, from this side",
  );
  equal(
    mergeSnapshots(documentWith("laptop", earlier), documentWith("tablet", later), null).snapshot.feeds[
      FEED_A
    ].title,
    "Later, low revision",
    "the later second, from the other side",
  );

  // The same second: the revision decides — a second is the resolution of `at`,
  // and a device's counter is not.
  const higher = feedRecord({ at: T + 5, rev: 7, by: "device-a" }, "Higher revision");
  const lower = feedRecord({ at: T + 5, rev: 6, by: "device-z" }, "Lower revision");
  equal(
    mergeSnapshots(documentWith("laptop", higher), documentWith("tablet", lower), null).snapshot.feeds[
      FEED_A
    ].title,
    "Higher revision",
    "the higher revision, from this side",
  );
  equal(
    mergeSnapshots(documentWith("laptop", lower), documentWith("tablet", higher), null).snapshot.feeds[
      FEED_A
    ].title,
    "Higher revision",
    "the higher revision, from the other side",
  );

  // The same second and the same revision: the device id settles it, and it
  // settles it the same way for both devices because it compares the records
  // rather than the sides.
  const zed = feedRecord({ at: T + 5, rev: 7, by: "device-zed" }, "From zed");
  const amy = feedRecord({ at: T + 5, rev: 7, by: "device-amy" }, "From amy");
  equal(
    mergeSnapshots(documentWith("laptop", zed), documentWith("tablet", amy), null).snapshot.feeds[FEED_A]
      .title,
    "From zed",
    "the larger device id",
  );
  equal(
    mergeSnapshots(documentWith("laptop", amy), documentWith("tablet", zed), null).snapshot.feeds[FEED_A]
      .title,
    "From zed",
    "and the same answer from the other side",
  );
});

await check("a device with a fast clock loses the edit made after it", async () => {
  const folder = new MemorySyncProvider();
  const desk = device("desktop", { identity: { id: "device-desk", rev: 0 } });
  const phone = device("phone", { identity: { id: "device-phone", rev: 0 } });

  await addFeed(desk, FEED_A, { title: "Comics" });
  await desk.sync(folder, T + 100);
  await phone.sync(folder, T + 101);

  // The phone's clock is ten minutes fast, and it renames the feed at what its
  // clock calls ten minutes later — the record that used to win everything.
  await phone.store.renameFeed(FEED_A, "Comics (phone)", "given");
  await phone.sync(folder, T + 700);
  equal(
    JSON.parse(folder.peek()).feeds[FEED_A].at,
    T + 700,
    "the phone dated its own edit by its own clock",
  );

  // The desktop sees it, and edits a minute later by its own, correct clock.
  await desk.sync(folder, T + 160);
  equal((await desk.store.feed(FEED_A)).title, "Comics (phone)", "the desktop adopted the phone's copy");
  await desk.store.renameFeed(FEED_A, "Comics (desktop)", "given");
  const later = await desk.sync(folder, T + 170);
  const chosen = JSON.parse(folder.peek()).feeds[FEED_A];
  equal(chosen.title, "Comics (desktop)", "the later edit won");
  truthy(chosen.at > T + 700, `the later edit is dated after what answered it: ${chosen.at}`);
  equal(chosen.by, "device-desk", "and it says which device wrote it");
  // One device moving is not a disagreement, so nothing is reported: the
  // desktop is simply the later of the two, and it says so in the record.
  deepEqual(later.conflicts, [], "one device editing is not a conflict");

  // And the phone cannot take it back: its library adopted the desktop's copy,
  // so its next run — eight minutes later by its clock — has nothing to say.
  const back = await phone.sync(folder, T + 800);
  equal((await phone.store.feed(FEED_A)).title, "Comics (desktop)", "the phone kept the later edit");
  equal(back.unchanged, true, "and wrote nothing");
});

await check("a sync back to the first device writes nothing", async () => {
  const folder = new MemorySyncProvider();
  const a = device("laptop", { identity: { id: "device-a", rev: 0 } });
  const b = device("tablet", { identity: { id: "device-b", rev: 0 } });

  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  a.prefs = withEntry(emptyPrefs(), "theme", { updatedAt: 900, value: { accent: "crimson" } });

  await a.sync(folder, T + 100);
  const adopted = await b.sync(folder, T + 101);
  deepEqual(adopted.applied.feedsAdded, [FEED_A], "the tablet adopted the subscription");
  equal(b.adopted.includes("theme"), true, "and the settings");
  const written = folder.peek();

  // A's second pass: nothing in its library has changed, so the folder already
  // says what the merge produced. Applying a remote change must not become an
  // outgoing one — that loop is how two devices bounce a document forever.
  const again = await a.sync(folder, T + 149);
  equal(again.unchanged, true, "the folder already said this");
  equal(folder.peek(), written, "the document in the folder is byte-identical");
  deepEqual(
    again.applied,
    {
      feedsAdded: [],
      feedsRemoved: [],
      feedsMoved: [],
      feedsRenamed: [],
      feedsRedirected: [],
      foldersAdded: [],
      foldersRemoved: [],
      marksApplied: 0,
      marksSkipped: 0,
    },
    "nothing was applied a second time",
  );

  // The one thing that may differ is the stamp on the copy itself: `device` and
  // `writtenAt` describe who wrote this file and when, and neither is merged.
  const before = JSON.parse(written);
  const moved = Object.keys(again.snapshot).filter(
    (key) => JSON.stringify(again.snapshot[key]) !== JSON.stringify(before[key]),
  );
  deepEqual(
    moved.filter((key) => key !== "device" && key !== "writtenAt"),
    [],
    "every record is byte-identical",
  );
  truthy(moved.includes("writtenAt"), `writtenAt is the only stamp that moved: ${moved.join(", ")}`);
});

await check("the revision survives a restart, and never goes backwards", async () => {
  const folder = new MemorySyncProvider();
  const first = device("laptop");
  await addFeed(first, FEED_A, { title: "Comics" });
  await first.sync(folder, T + 100);

  const opened = JSON.parse(folder.peek()).feeds[FEED_A];
  truthy(opened.by !== "", "the record says which device wrote it");
  truthy(opened.rev > 0, "and which revision of it");

  // A restart: the same library, opened again in a new process. The id and the
  // counter are the library's, so neither of them starts over.
  const second = reopen(first);
  await second.store.renameFeed(FEED_A, "Comics, renamed", "given");
  await second.sync(folder, T + 200);
  const afterSecond = JSON.parse(folder.peek()).feeds[FEED_A];
  truthy(afterSecond.rev > opened.rev, `a later build is a higher revision: ${afterSecond.rev}`);
  equal(afterSecond.by, opened.by, "the same device id after a restart");

  const third = reopen(second);
  await third.store.renameFeed(FEED_A, "Comics, renamed again", "given");
  await third.sync(folder, T + 300);
  const afterThird = JSON.parse(folder.peek()).feeds[FEED_A];
  truthy(afterThird.rev > afterSecond.rev, `still counting: ${afterThird.rev}`);
  equal(afterThird.by, opened.by, "and still the same device");

  // A library rebuilt from nothing (a reinstall) is a new library, so it gets a
  // new id and a counter of its own. That is not a new authority: the ordering
  // is `(at, rev, by)`, so a fresh counter cannot outrank an old record, and the
  // id is only ever a tie-break.
  const rebuilt = device("laptop");
  await addFeed(rebuilt, FEED_B, { title: "Other" });
  await rebuilt.sync(folder, T + 400);
  const fresh = JSON.parse(folder.peek()).feeds[FEED_B];
  truthy(fresh.by !== opened.by, "a rebuilt library is a different device");
  equal(fresh.rev, 1, "with its counter at the beginning");
});

await check("a document written before revisions still merges, on its own clock", async () => {
  // A file from the build before `rev`: nothing in it but the second.
  const legacy = {
    version: SYNC_VERSION,
    device: "tablet",
    writtenAt: T,
    feeds: {
      [FEED_A]: {
        at: T + 50,
        title: "From the old build",
        titleSource: "given",
        folder: null,
        addedAt: T,
        removed: false,
      },
    },
    folders: {},
    redirects: {},
    marks: {},
    prefs: { entries: {} },
    sidebar: null,
    place: null,
  };

  const parsed = parseSyncSnapshot(JSON.stringify(legacy)).feeds[FEED_A];
  equal(parsed.rev, 0, "no revision is invented for it");
  equal(parsed.by, "", "and no device id");
  equal(parsed.at, T + 50, "the second it does carry is kept");

  // It still arrives: a document without revisions is an older document, not a
  // broken one.
  const folder = new MemorySyncProvider(JSON.stringify(legacy));
  const a = device("laptop", { identity: { id: "device-laptop", rev: 0 } });
  await a.sync(folder, T + 10);
  equal((await a.store.feed(FEED_A)).title, "From the old build", "the older document arrived");

  // And it orders by `at` alone, as it used to: a real stamp only takes the
  // ties a record with no revision cannot defend.
  const theirs = legacy.feeds[FEED_A];
  const mine = feedRecord({ at: T + 60, rev: 4, by: "device-laptop" }, "Newer here");
  equal(
    mergeSnapshots(documentWith("laptop", mine), documentWith("tablet", theirs), null).snapshot.feeds[FEED_A]
      .title,
    "Newer here",
    "the later second wins over the higher revision",
  );
  const tie = { ...mine, at: T + 50 };
  equal(
    mergeSnapshots(documentWith("laptop", tie), documentWith("tablet", theirs), null).snapshot.feeds[FEED_A]
      .title,
    "Newer here",
    "and the same second goes to the record that has a revision",
  );
});

console.log(`\n${passed} checks passed`);
