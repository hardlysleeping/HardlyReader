/**
 * The sync folder is a versioned file set, not one document.
 *
 * The folder is the product's interchange format (`docs/sync-format.md`): seven
 * canonical files, the same on iCloud, Drive, Dropbox and OneDrive, so a reader
 * can copy the folder and open the library on another machine. What is worth
 * pinning here is everything that makes the split safe rather than merely
 * different:
 *
 * - the manifest is written last and read first, and a newer one is refused
 *   without a byte of the folder being applied or rewritten,
 * - a folder written by v1 (one `hardlyreader-sync.json`) is migrated into the
 *   set, and the old file is left exactly where the reader put it,
 * - writing a position costs `positions.json`, the stamp and the manifest — never
 *   `library.json`,
 * - a big library splits into `feeds/<bucket>.json` inside the same format, not a
 *   version bump,
 * - a provider that only speaks whole documents still syncs, unchanged.
 *
 * Every check drives the real `syncOnce` over real `LocalStore`s, with a counting
 * provider that records what was read and written, so "it did not rewrite the
 * library" is measured rather than assumed.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/sync-files.mjs
 */
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import {
  DEVICES_FILE,
  LIBRARY_FILE,
  LIBRARY_SPLIT_BYTES,
  MANIFEST_FILE,
  POSITIONS_FILE,
  PREFERENCES_FILE,
  STATE_FILE,
  SYNC_ENCRYPTION,
  SYNC_FILE_NAME,
  SYNC_FORMAT,
  SYNC_VERSION,
  TOMBSTONES_FILE,
  emptySnapshot,
  localSnapshot,
  manifestBytes,
  parseSyncSnapshot,
  readFileSet,
  serializeSnapshot,
  snapshotFiles,
  syncOnce,
  writeFileSet,
} from "../../src/api/local/sync.ts";
import { emptyPrefs, withEntry } from "../../src/lib/prefs-sync.ts";
import { emptyPlace, emptySidebar } from "../../src/lib/sidebar-doc.ts";

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

/** The same values in the same order, so a key-order difference is not a failure. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const ordered = {};
    for (const key of Object.keys(value).sort()) ordered[key] = canonical(value[key]);
    return ordered;
  }
  return value;
}

function same(actual, expected, what) {
  deepEqual(canonical(actual), canonical(expected), what);
}

function truthy(value, what) {
  if (!value) fail(`${what}: expected something, got ${JSON.stringify(value)}`);
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return fail("expected a refusal, and the call answered");
}

function mentions(message, ...parts) {
  for (const part of parts) {
    if (!message.includes(part)) fail(`refusal did not mention ${JSON.stringify(part)}: ${message}`);
  }
}

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CANONICAL = [
  DEVICES_FILE,
  LIBRARY_FILE,
  MANIFEST_FILE,
  POSITIONS_FILE,
  PREFERENCES_FILE,
  STATE_FILE,
  TOMBSTONES_FILE,
].sort();

/**
 * A provider that can address one file at a time, and counts every call.
 *
 * `read`/`write` throw on purpose: a provider with the path members must never be
 * handed the whole document, and a silent fallback would hide exactly the
 * regression this suite exists to catch.
 */
class FileProvider {
  id = "folder";
  label = "A folder";
  files = new Map();
  reads = [];
  writes = [];

  describe() {
    return "a folder that lives only in memory, for tests";
  }

  async read() {
    throw new Error("the file set must not be read as one document");
  }

  async write() {
    throw new Error("the file set must not be written as one document");
  }

  async readFile(path) {
    this.reads.push(path);
    return this.files.get(path) ?? null;
  }

  async writeFile(path, data) {
    this.writes.push(path);
    this.files.set(path, data);
  }

  async deleteFile(path) {
    this.files.delete(path);
  }

  reset() {
    this.reads = [];
    this.writes = [];
  }

  text(path) {
    const data = this.files.get(path);
    return data === undefined ? null : decoder.decode(data);
  }

  json(path) {
    const text = this.text(path);
    return text === null ? null : JSON.parse(text);
  }

  copy() {
    const provider = new FileProvider();
    for (const [path, data] of this.files) provider.files.set(path, data);
    return provider;
  }
}

/** A provider carrying files this build did not write in this test. */
function providerOf(files) {
  const provider = new FileProvider();
  for (const [path, data] of files) provider.files.set(path, data);
  return provider;
}

/** A committed folder: the payload files plus the manifest that names them. */
function folderOf(files) {
  const provider = new FileProvider();
  provider.files.set(MANIFEST_FILE, manifestBytes());
  for (const [path, data] of files) provider.files.set(path, data);
  return provider;
}

/** Two folders, byte for byte. */
function sameFolder(actual, expected, what) {
  equal(actual.size, expected.size, `${what}: the number of files`);
  for (const [path, data] of expected) {
    const held = actual.get(path);
    truthy(held !== undefined, `${what}: ${path}`);
    equal(decoder.decode(held), decoder.decode(data), `${what}: ${path}`);
  }
}

/**
 * The same snapshot as the single document encoding reads it.
 *
 * The file set and the document are two encodings of one snapshot, so this is the
 * reference a set is compared against: it goes through the same parser, which
 * means a field the parser defaults (or a new one it learns) is not a difference
 * between the two encodings.
 */
function asDocument(snapshot) {
  return parseSyncSnapshot(serializeSnapshot(snapshot));
}

/**
 * One device: a library, the last agreement it reached, and its settings.
 */
function device(name) {
  const database = new MemoryDatabase();
  const store = new LocalStore(database);
  return {
    name,
    store,
    database,
    base: null,
    prefs: emptyPrefs(),
    sidebar: emptySidebar(),
    /** Nowhere yet. A device that has never read anything has no position to claim. */
    place: null,
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
          sidebar: {
            local: this.sidebar,
            adopt: (doc) => {
              this.sidebar = doc;
            },
          },
          place: {
            local: this.place,
            adopt: (doc) => {
              this.place = doc;
            },
          },
        },
      });
      this.base = run.snapshot;
      return run;
    },
  };
}

async function addFeed(dev, url, { title, folder = null } = {}) {
  await dev.store.subscribe(url, { title, folder });
  return url;
}

/** An article with a chosen `stored_at`, the same shape `local-sync.mjs` uses. */
async function addEntry(dev, feedUrl, guid, { storedAt = T - 10 } = {}) {
  await dev.store.putEntries([{ feedUrl, guid, title: `Post ${guid}`, published: T - 60 }]);
  const id = localItemId(feedUrl, guid);
  const row = await dev.database.get("entries", id);
  await dev.database.write([{ type: "put", table: "entries", row: { ...row, stored_at: storedAt } }]);
  return id;
}

/** A library big enough that `library.json` has to split. */
function bigSnapshot(count) {
  const snapshot = emptySnapshot("big", T);
  for (let index = 0; index < count; index += 1) {
    const url = `https://feeds.example/${String(index).padStart(5, "0")}/rss.xml`;
    snapshot.feeds[url] = {
      at: T,
      title: `Feed number ${index}, with a name long enough to be worth a real file`,
      titleSource: "feed",
      folder: index % 7 === 0 ? "Folder" : null,
      addedAt: T,
      removed: false,
    };
  }
  snapshot.folders.Folder = { at: T, createdAt: T, removed: false };
  return snapshot;
}

/* --------------------------------------------------------------------------
 * The file set as it is written
 * ----------------------------------------------------------------------- */

await check("the folder is the seven canonical files, and the manifest is written last", async () => {
  const a = device("a");
  await addFeed(a, FEED_A, { title: "A" });
  const provider = new FileProvider();

  const run = await a.sync(provider, T);
  equal(run.unchanged, false, "a first sync that had nothing to agree with");

  deepEqual([...provider.files.keys()].sort(), CANONICAL, "the files in the folder");
  deepEqual(
    provider.json(MANIFEST_FILE),
    { format: SYNC_FORMAT, version: SYNC_VERSION, encryption: SYNC_ENCRYPTION },
    "the manifest",
  );
  equal(provider.writes[provider.writes.length - 1], MANIFEST_FILE, "the last file written");

  const library = provider.json(LIBRARY_FILE);
  deepEqual(Object.keys(library.feeds), [FEED_A], "the feeds in library.json");
  deepEqual(library.redirects, {}, "the moves in library.json");
  deepEqual(provider.json(TOMBSTONES_FILE), { feeds: {}, folders: {} }, "tombstones.json");
  deepEqual(provider.json(DEVICES_FILE).device, "a", "the device in devices.json");
  deepEqual(provider.json(STATE_FILE), { marks: {} }, "state.json");
  truthy(provider.json(POSITIONS_FILE) !== null, "positions.json");
  truthy(provider.json(PREFERENCES_FILE) !== null, "preferences.json");
});

await check("the set reads back as the same library", async () => {
  const a = device("a");
  await addFeed(a, FEED_A, { title: "A", folder: "Reading" });
  await addFeed(a, FEED_B, { title: "B" });
  const id = await addEntry(a, FEED_A, "one");
  await a.store.setRead([id], true);
  await a.store.setStarred([id], true);
  a.prefs = withEntry(emptyPrefs(), "theme", { updatedAt: T * 1000, value: { accent: "crimson" } });
  a.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "A", articleId: id, articleScroll: 120 };

  const provider = new FileProvider();
  await a.sync(provider, T);

  const read = await readFileSet(provider, { device: "a", now: T });
  truthy(read.snapshot !== null, "a snapshot read back from the set");
  same(read.snapshot, asDocument(a.base), "the snapshot read back out of the set");
  equal(read.snapshot.device, "a", "the device read back");
  equal(read.snapshot.writtenAt, T, "the stamp read back");
  equal(read.snapshot.marks[id].read, true, "the read mark read back");
  equal(read.snapshot.marks[id].starred, true, "the star read back");
  deepEqual(read.snapshot.feeds[FEED_A].folder, "Reading", "the feed's folder read back");
});

await check("a second device opens the same library and writes nothing it already agrees with", async () => {
  const a = device("a");
  await addFeed(a, FEED_A, { title: "A", folder: "Reading" });
  await addFeed(a, FEED_B, { title: "B" });
  const id = await addEntry(a, FEED_A, "one");
  await a.store.setRead([id], true);
  a.prefs = withEntry(emptyPrefs(), "reading", { updatedAt: T * 1000, value: { textScale: 1.25 } });
  a.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "A" };

  const provider = new FileProvider();
  await a.sync(provider, T);

  const b = device("b");
  provider.reset();
  const first = await b.sync(provider, T + 60);

  deepEqual((await b.store.feeds()).map((feed) => feed.key).sort(), [FEED_A, FEED_B], "b's feeds");
  truthy((await b.store.feed(FEED_A))?.folder === "Reading", "b's folder for the adopted feed");
  deepEqual(b.prefs.entries.reading.value, { textScale: 1.25 }, "b's adopted settings");
  equal(b.place.streamId, FEED_A, "b's adopted position");
  equal(first.unchanged, true, "a sync that agreed with the folder already");
  deepEqual(provider.writes, [], "what a device that agreed wrote");
  // The mark is for an article b has not fetched yet, so it waits in the folder.
  equal(first.applied.marksSkipped, 1, "the mark b could not apply");

  // It lands as soon as b fetches the feed and stores the post.
  await addEntry(b, FEED_A, "one", { storedAt: T + 90 });
  await b.sync(provider, T + 120);
  equal((await b.store.entry(id)).read, 1, "b's read mark, after fetching the post");
});

await check("a v1 single document is migrated into the set, and left where the reader put it", async () => {
  const legacyDevice = device("legacy");
  await addFeed(legacyDevice, FEED_A, { title: "A", folder: "Reading" });
  const id = await addEntry(legacyDevice, FEED_A, "one");
  await legacyDevice.store.setRead([id], true);
  legacyDevice.prefs = withEntry(emptyPrefs(), "theme", { updatedAt: T * 1000, value: { mode: "dark" } });
  legacyDevice.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "A", articleScroll: 64 };

  const document = await localSnapshot({
    store: legacyDevice.store,
    device: "legacy",
    base: null,
    now: T,
    prefs: {
      local: legacyDevice.prefs,
      adopt: () => {},
      sidebar: { local: emptySidebar(), adopt: () => {} },
      place: { local: legacyDevice.place, adopt: () => {} },
    },
  });
  // A deletion the document also carries, so the migration has a tombstone to
  // sort into its own file rather than into library.json.
  document.feeds["https://gone.test/rss"] = {
    at: T - 100,
    title: "Gone",
    titleSource: "feed",
    folder: null,
    addedAt: T - 900,
    removed: true,
  };
  const legacyBytes = encoder.encode(serializeSnapshot(document));

  const provider = new FileProvider();
  provider.files.set(SYNC_FILE_NAME, legacyBytes);

  const fresh = device("fresh");
  const run = await fresh.sync(provider, T + 10);

  deepEqual([...provider.files.keys()].sort(), [...CANONICAL, SYNC_FILE_NAME].sort(), "the folder after migrating");
  equal(decoder.decode(provider.files.get(SYNC_FILE_NAME)), decoder.decode(legacyBytes), "the v1 document, byte for byte");
  equal(provider.writes[provider.writes.length - 1], MANIFEST_FILE, "the last file the migration wrote");

  const library = provider.json(LIBRARY_FILE);
  // The document as the parser reads it: the migration writes what it read, so
  // fields the parser defaults are on both sides of these comparisons.
  const normalized = asDocument(document);
  deepEqual(Object.keys(library.feeds).sort(), [FEED_A], "the live feeds in library.json");
  deepEqual(Object.keys(library.folders).sort(), ["Reading"], "the folders in library.json");
  same(provider.json(TOMBSTONES_FILE).feeds["https://gone.test/rss"], normalized.feeds["https://gone.test/rss"], "the migrated tombstone");
  deepEqual(provider.json(TOMBSTONES_FILE).folders, {}, "the folder tombstones");
  same(provider.json(STATE_FILE).marks, normalized.marks, "the migrated marks");
  same(provider.json(PREFERENCES_FILE).prefs, normalized.prefs, "the migrated preferences");
  same(provider.json(POSITIONS_FILE).place, normalized.place, "the migrated position");

  deepEqual((await fresh.store.feeds()).map((feed) => feed.key), [FEED_A], "the migrated library");
  equal(run.applied.marksSkipped, 1, "the migrated mark this device cannot hold yet");
  // The mark is in the folder, so it lands the moment the post is fetched here.
  await addEntry(fresh, FEED_A, "one", { storedAt: T + 20 });
  await fresh.sync(provider, T + 30);
  equal((await fresh.store.entry(id)).read, 1, "the migrated read mark, once the post is here");
});

await check("a feed deleted on one device travels in tombstones.json and is not resurrected", async () => {
  const a = device("a");
  await addFeed(a, FEED_A, { title: "A" });
  await addFeed(a, FEED_B, { title: "B" });
  const provider = new FileProvider();
  await a.sync(provider, T);

  await a.store.unsubscribe(FEED_B);
  provider.reset();
  await a.sync(provider, T + 60);

  deepEqual(
    provider.writes,
    [LIBRARY_FILE, TOMBSTONES_FILE, DEVICES_FILE, MANIFEST_FILE],
    "the files a delete costs",
  );
  deepEqual(Object.keys(provider.json(LIBRARY_FILE).feeds), [FEED_A], "library.json after the delete");
  const tombstone = provider.json(TOMBSTONES_FILE).feeds[FEED_B];
  truthy(tombstone !== undefined, "the tombstone in tombstones.json");
  equal(tombstone.removed, true, "the tombstone's flag");
  equal(tombstone.title, "B", "the tombstone's remembered title");

  const b = device("b");
  await b.sync(provider, T + 120);
  deepEqual((await b.store.feeds()).map((feed) => feed.key), [FEED_A], "the second device's feeds");
});

/* --------------------------------------------------------------------------
 * What the folder refuses
 * ----------------------------------------------------------------------- */

await check("a newer manifest is refused, and not one byte is read or written", async () => {
  const provider = new FileProvider();
  provider.files.set(MANIFEST_FILE, encoder.encode(JSON.stringify({ format: SYNC_FORMAT, version: SYNC_VERSION + 1, encryption: SYNC_ENCRYPTION })));
  provider.files.set(
    LIBRARY_FILE,
    encoder.encode(
      JSON.stringify({
        feeds: { [FEED_A]: { at: T, title: "A", titleSource: "feed", folder: null, addedAt: T, removed: false } },
        folders: {},
        redirects: {},
      }),
    ),
  );
  const before = provider.copy();
  provider.reset();

  const a = device("a");
  const message = await refusal(a.sync(provider, T));
  mentions(message, "newer version", "folder 2", "Update this device");

  sameFolder(provider.files, before.files, "the folder after refusing a newer manifest");
  deepEqual(provider.writes, [], "what a refused folder wrote");
  deepEqual(provider.reads, [MANIFEST_FILE], "what a refused folder was read for");
  deepEqual((await a.store.feeds()).map((feed) => feed.key), [], "a refused folder's feeds");
  equal(a.base, null, "the agreement after a refusal");
});

await check("an encrypted folder is refused rather than guessed at", async () => {
  const a = device("a");

  const encrypted = providerOf(
    new Map([
      [MANIFEST_FILE, encoder.encode(JSON.stringify({ format: SYNC_FORMAT, version: SYNC_VERSION, encryption: "xchacha20-poly1305" }))],
    ]),
  );
  encrypted.reset();
  const message = await refusal(a.sync(encrypted, T));
  mentions(message, "xchacha20-poly1305", "cannot read");
  deepEqual(encrypted.writes, [], "what an encrypted folder wrote");

  const silent = providerOf(
    new Map([[MANIFEST_FILE, encoder.encode(JSON.stringify({ format: SYNC_FORMAT, version: SYNC_VERSION }))]]),
  );
  silent.reset();
  const missing = await refusal(a.sync(silent, T));
  mentions(missing, "encryption");
  deepEqual(silent.writes, [], "what a manifest with no encryption wrote");

  const stranger = providerOf(
    new Map([[MANIFEST_FILE, encoder.encode(JSON.stringify({ format: "someone-elses-app", version: 1 }))]]),
  );
  stranger.reset();
  mentions(await refusal(a.sync(stranger, T)), "not a HardlyReader sync folder");
  deepEqual(stranger.writes, [], "what a stranger's folder wrote");
});

await check("a shard file the library names but the folder lacks is refused", async () => {
  const files = snapshotFiles(bigSnapshot(6000));
  const provider = folderOf(files);
  const library = JSON.parse(decoder.decode(files.get(LIBRARY_FILE)));
  const missing = library.shards[0];
  provider.files.delete(missing);

  const message = await refusal(readFileSet(provider, { device: "a", now: T }));
  mentions(message, "incomplete", missing);
});

/* --------------------------------------------------------------------------
 * What a write costs
 * ----------------------------------------------------------------------- */

await check("a position write costs positions.json, the stamp and the manifest — never library.json", async () => {
  const a = device("a");
  await addFeed(a, FEED_A, { title: "A" });
  const id = await addEntry(a, FEED_A, "one");
  await a.store.setRead([id], true);
  a.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "A", articleScroll: 100 };

  const provider = new FileProvider();
  await a.sync(provider, T);

  a.place = { ...a.place, articleScroll: 900 };
  provider.reset();
  const run = await a.sync(provider, T + 60);

  deepEqual(provider.writes, [POSITIONS_FILE, DEVICES_FILE, MANIFEST_FILE], "the files a scroll costs");
  truthy(!provider.writes.includes(LIBRARY_FILE), "library.json in a position write");
  truthy(!provider.writes.includes(STATE_FILE), "state.json in a position write");
  equal(run.unchanged, false, "a sync that wrote a position");
  equal(provider.json(POSITIONS_FILE).place.articleScroll, 900, "the stored position");

  provider.reset();
  const quiet = await a.sync(provider, T + 120);
  equal(quiet.unchanged, true, "a sync with nothing to say");
  deepEqual(provider.writes, [], "what a sync with nothing to say wrote");
});

/* --------------------------------------------------------------------------
 * Splitting when it grows
 * ----------------------------------------------------------------------- */

await check("a library past the split threshold becomes feeds/<bucket>.json inside the same format", async () => {
  const snapshot = bigSnapshot(6000);
  const files = snapshotFiles(snapshot);
  const library = JSON.parse(decoder.decode(files.get(LIBRARY_FILE)));

  truthy(Array.isArray(library.shards) && library.shards.length > 1, "library.json's shard list");
  equal(library.feeds, undefined, "feeds inline in a split library");
  for (const shard of library.shards) {
    truthy(files.has(shard), `the shard file ${shard}`);
    truthy(decoder.decode(files.get(shard)).length < LIBRARY_SPLIT_BYTES, `the size of ${shard}`);
  }
  truthy(decoder.decode(files.get(LIBRARY_FILE)).length < LIBRARY_SPLIT_BYTES, "library.json stays small");

  // The list comes before the file that names it, so a reader that sees the list
  // finds every file on it.
  const order = [...files.keys()];
  truthy(order.indexOf(library.shards[0]) < order.indexOf(LIBRARY_FILE), "a shard written before library.json");

  const read = await readFileSet(folderOf(files), { device: "big", now: T });
  const normalized = asDocument(snapshot);
  equal(Object.keys(read.snapshot.feeds).length, 6000, "the feeds read back out of the shards");
  same(
    read.snapshot.feeds["https://feeds.example/00042/rss.xml"],
    normalized.feeds["https://feeds.example/00042/rss.xml"],
    "one sharded feed",
  );
  same(read.snapshot.folders, normalized.folders, "the folders beside the shards");

  // And a write of that library writes the shards before the list, manifest last.
  const provider = new FileProvider();
  const write = await writeFileSet(provider, { snapshot: null, files: new Map(), manifest: null }, snapshot, T);
  truthy(write.written.length > 7, "the files a split library writes");
  equal(write.written[write.written.length - 1], MANIFEST_FILE, "the last file a split library writes");
  truthy(
    write.written.indexOf(library.shards[0]) < write.written.indexOf(LIBRARY_FILE),
    "the order a split library is written in",
  );
  equal(write.files.size, files.size + 1, "the payload files plus the manifest");
});

/* --------------------------------------------------------------------------
 * The provider that cannot address a file
 * ----------------------------------------------------------------------- */

await check("a provider with only read and write still syncs the whole document", async () => {
  const provider = new MemorySyncProvider();

  const a = device("a");
  await addFeed(a, FEED_A, { title: "A" });
  const id = await addEntry(a, FEED_A, "one");
  await a.store.setStarred([id], true);
  await a.sync(provider, T);

  const document = JSON.parse(provider.peek());
  equal(document.version, SYNC_VERSION, "the document's version");
  truthy(document.feeds[FEED_A] !== undefined, "the feed in the single document");
  equal(document.feeds[FEED_A].title, "A", "the feed's title");
  equal(document.marks[id].starred, true, "the star in the single document");

  const b = device("b");
  // b fetched the feed and the post itself; the star is the only thing it has to learn.
  await addFeed(b, FEED_A, { title: "A" });
  await addEntry(b, FEED_A, "one", { storedAt: T + 30 });
  await b.sync(provider, T + 60);
  deepEqual((await b.store.feeds()).map((feed) => feed.key), [FEED_A], "the second device's feeds");
  equal((await b.store.entry(id)).starred, 1, "the second device's star");
});

console.log(`\n${passed} checks passed`);
