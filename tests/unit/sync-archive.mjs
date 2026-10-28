/**
 * Export and import: the reader's own copy of the sync data.
 *
 * The card promises portability as a feature rather than a hope, and the only
 * way to prove a promise about data is to move real data through the real engine
 * and read it back. So every check here drives `LocalStore`s over the in-memory
 * driver and the same functions the app calls:
 *
 *   1. **The archive is the canonical files.** `library.json`, `state.json`,
 *      `preferences.json`, `positions.json`, `tombstones.json`, and a
 *      `manifest.json` written last — a zip a person can unpack and read.
 *   2. **An import is a sync, not a replace.** A zip merged into an empty
 *      library brings the feeds, the folders, the arrangement, the settings and
 *      the reading position; the same zip merged into a library that already has
 *      its own loses nothing on either side.
 *   3. **A refusal names what it found.** No manifest, a newer format, an
 *      encryption this build cannot undo, a file the manifest promises and the
 *      zip does not hold — each is a sentence, and the library is untouched.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/sync-archive.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import { syncOnce } from "../../src/api/local/sync.ts";
import {
  ARCHIVE_FILES,
  ARCHIVE_FORMAT,
  MANIFEST_FILE,
  countsOf,
  describeCounts,
  describeImport,
  exportArchive,
  importArchive,
  readArchive,
} from "../../src/api/local/sync-archive.ts";
import { crc32, readZip, writeZip } from "../../src/lib/zip.ts";
import { toBase64 } from "../../src/lib/archive-file.ts";
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

function truthy(value, what) {
  if (!value) fail(`${what}: expected something, got ${JSON.stringify(value)}`);
}

/** The sentence a refusal threw, so a check can name what it says. */
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
const FEED_C = "https://c.test/atom";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** One file in an archive, as text. */
function textOf(files, name) {
  const raw = files.get(name);
  if (raw === undefined) fail(`the archive has no ${name}`);
  return decoder.decode(raw);
}

/**
 * One device: a library, the agreement it reached, its settings, its arrangement
 * and where it was reading.
 *
 * `source()` is what `state/device-sync` hands the archive functions, and `base`
 * is what the app persists — `importArchive` sets it the way `withImport` does,
 * because a second copy of that decision in the test would be a second rule.
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
    adopted: [],
    sidebar: null,
    place: null,
    adoptedSidebar: false,
    adoptedPlace: false,
    source() {
      return {
        store,
        device: name,
        base: this.base,
        prefs: {
          local: this.prefs,
          adopt: (doc, namespaces) => {
            this.prefs = doc;
            this.adopted.push(...namespaces);
          },
          sidebar: {
            local: this.sidebar,
            adopt: (doc) => {
              this.sidebar = doc;
              this.adoptedSidebar = true;
            },
          },
          place: {
            local: this.place,
            adopt: (doc) => {
              this.place = doc;
              this.adoptedPlace = true;
            },
          },
        },
      };
    },
    async export(at) {
      return exportArchive({ ...this.source(), now: at });
    },
    async import(bytes, at) {
      const result = await importArchive({ ...this.source(), bytes, now: at });
      this.base = result.snapshot;
      return result;
    },
    async sync(provider, at) {
      const run = await syncOnce({ ...this.source(), provider, now: at });
      this.base = run.snapshot;
      return run;
    },
  };
}

async function addFeed(dev, url, { title, folder = null } = {}) {
  await dev.store.subscribe(url, { title, folder });
  return url;
}

async function addEntry(dev, feedUrl, guid, { storedAt = T - 10 } = {}) {
  await dev.store.putEntries([{ feedUrl, guid, title: `Post ${guid}`, published: T - 60 }]);
  const id = localItemId(feedUrl, guid);
  const row = await dev.database.get("entries", id);
  await dev.database.write([{ type: "put", table: "entries", row: { ...row, stored_at: storedAt } }]);
  return id;
}

async function feedUrls(dev) {
  return (await dev.store.feeds()).map((feed) => feed.key).sort();
}

async function folderNames(dev) {
  return (await dev.store.folders()).map((row) => row.key).sort();
}

/* --------------------------------------------------------------------------
 * The archive itself
 * ----------------------------------------------------------------------- */

await check("the archive is the canonical files, with the manifest written last", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  await addFeed(a, FEED_B, { title: "Other" });
  const read = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([read], true);
  const star = await addEntry(a, FEED_B, "p2");
  await a.store.setStarred([star], true);
  a.sidebar = {
    ...emptySidebar(),
    hidden: ["Filters"],
    pins: ["Comics"],
    indentPx: 12,
    feedOrder: [FEED_B, FEED_A],
    categoryOrder: ["Funny books"],
  };
  a.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "Comics", articleId: read, articleScroll: 40 };
  a.prefs = withEntry(a.prefs, "theme", { updatedAt: T * 1000, value: { accent: "amber" } });

  const archive = await a.export(T + 100);
  const files = await readZip(archive.bytes);

  deepEqual(
    [...files.keys()].sort(),
    [...ARCHIVE_FILES, MANIFEST_FILE].sort(),
    "the files in the zip",
  );
  equal([...files.keys()].at(-1), MANIFEST_FILE, "the last file written");

  const manifest = JSON.parse(textOf(files, MANIFEST_FILE));
  equal(manifest.format, ARCHIVE_FORMAT, "the manifest's format");
  equal(manifest.version, 1, "the manifest's version");
  equal(manifest.encryption, "none", "the manifest's encryption");
  equal(manifest.device, "laptop", "the manifest's device");
  equal(manifest.writtenAt, T + 100, "the manifest's time");
  deepEqual(manifest.files, [...ARCHIVE_FILES], "the files the manifest lists");

  const library = JSON.parse(textOf(files, "library.json"));
  deepEqual(Object.keys(library.feeds).sort(), [FEED_A, FEED_B], "the subscriptions in library.json");
  equal(library.feeds[FEED_A].folder, "Funny books", "the feed's folder in library.json");
  deepEqual(Object.keys(library.folders), ["Funny books"], "the folders in library.json");
  deepEqual(library.sidebar.hidden, ["Filters"], "the hidden categories in library.json");
  deepEqual(library.sidebar.feedOrder, [FEED_B, FEED_A], "the feed order in library.json");
  truthy(typeof library.sidebar.at === "number", "the arrangement's stamp");

  const state = JSON.parse(textOf(files, "state.json"));
  equal(state.marks[read].read, true, "the read mark in state.json");
  equal(state.marks[star].starred, true, "the star in state.json");

  const preferences = JSON.parse(textOf(files, "preferences.json"));
  equal(preferences.entries.theme.value.accent, "amber", "the theme in preferences.json");

  const positions = JSON.parse(textOf(files, "positions.json"));
  equal(positions.articleId, read, "the article in positions.json");
  equal(positions.articleScroll, 40, "the scroll in positions.json");

  const tombstones = JSON.parse(textOf(files, "tombstones.json"));
  deepEqual(Object.keys(tombstones.feeds), [], "a tombstone for a feed nobody deleted");
  deepEqual(Object.keys(tombstones.folders), [], "a tombstone for a folder nobody deleted");

  deepEqual(
    archive.counts,
    { feeds: 2, folders: 1, marks: 2, arranged: true, placed: true },
    "what the export says it holds",
  );
});

await check("the zip a person's own tool can open is a real zip", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const archive = await a.export(T + 100);

  equal(
    [...archive.bytes.subarray(0, 4)].map((byte) => byte.toString(16)).join(" "),
    "50 4b 3 4",
    "the zip's first four bytes",
  );

  // `unzip` is the reader's own tool, and the whole card is about a file they can
  // keep and hand around: if the system unzip will not take it, the archive is
  // only readable by this app, which is not portability.
  const root = mkdtempSync(join(tmpdir(), "hardlyreader-archive-"));
  const path = join(root, "HardlyReader-Sync.zip");
  writeFileSync(path, archive.bytes);
  const listing = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
  truthy(listing.includes("No errors detected"), `unzip -t said: ${listing}`);
  const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
  deepEqual(names, [...ARCHIVE_FILES, MANIFEST_FILE], "the names unzip lists, in order");
});

await check("an archive another tool compressed is read, not refused", async () => {
  // A zip from a real archiver is deflated; this writer only ever stores. The
  // reader has to be the generous side of that difference, so the fixture is a
  // hand-built deflated zip.
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  const stored = await a.export(T + 100);
  const plain = await readZip(stored.bytes);

  const deflated = deflateZip(
    [...plain.entries()].map(([name, data]) => ({ name, data: decoder.decode(data) })),
  );
  const reread = await readArchive(deflated);
  equal(reread.snapshot.feeds[FEED_A].title, "Comics", "the feed read out of a deflated archive");
  equal(reread.snapshot.feeds[FEED_A].folder, "Funny books", "the folder read out of it");
});

/** A stored-then-deflated zip, the way a normal archiver writes one. */
function deflateZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.data);
    const packed = deflateRawSync(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 8, true); // deflated
    view.setUint32(14, crc32(data), true);
    view.setUint32(18, packed.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, packed);

    const head = new Uint8Array(46 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 20, true);
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, 8, true);
    h.setUint32(16, crc32(data), true);
    h.setUint32(20, packed.length, true);
    h.setUint32(24, data.length, true);
    h.setUint16(28, name.length, true);
    h.setUint32(42, offset, true);
    head.set(name, 46);
    central.push(head);

    offset += local.length + packed.length;
  }
  const directory = concatBytes(central);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, directory.length, true);
  tail.setUint32(16, offset, true);
  return concatBytes([...chunks, directory, end]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

await check("the archive carries no article body, only what travels", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.store.putEntries([
    { feedUrl: FEED_A, guid: "p1", title: "A post", content: "<p>the body of the article</p>" },
  ]);
  const archive = await a.export(T + 100);
  const everything = decoder.decode(archive.bytes);
  truthy(!everything.includes("the body of the article"), "an article body in the archive");
});

/* --------------------------------------------------------------------------
 * The card's acceptance
 * ----------------------------------------------------------------------- */

/** The library every acceptance check exports from. */
async function sourceLibrary() {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  await addFeed(a, FEED_B, { title: "Other" });
  const read = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([read], true);
  const star = await addEntry(a, FEED_B, "p2");
  await a.store.setStarred([star], true);
  a.sidebar = {
    ...emptySidebar(),
    hidden: ["Filters"],
    pins: ["Comics"],
    pinFeeds: [FEED_B],
    indentPx: 12,
    feedOrder: [FEED_B, FEED_A],
    categoryOrder: ["Funny books"],
  };
  a.place = { ...emptyPlace(), streamId: FEED_A, streamTitle: "Comics", articleId: star, articleScroll: 40 };
  a.prefs = withEntry(a.prefs, "theme", { updatedAt: T * 1000, value: { accent: "amber" } });
  return { a, read, star };
}

await check("export from one library, import into an empty one: the same feeds, folders, ordering and settings", async () => {
  const { a, read, star } = await sourceLibrary();
  const archive = await a.export(T + 100);

  const b = device("tablet");
  const result = await b.import(archive.bytes, T + 200);

  deepEqual(await feedUrls(b), [FEED_A, FEED_B], "the tablet's subscriptions");
  deepEqual(await folderNames(b), ["Funny books"], "the tablet's folders");
  const feeds = await b.store.feeds();
  equal(
    feeds.find((feed) => feed.key === FEED_A)?.folder,
    "Funny books",
    "the feed arrived in its folder",
  );
  equal(
    feeds.find((feed) => feed.key === FEED_B)?.title,
    "Other",
    "the feed arrived with its name",
  );

  // The arrangement travels as one record: the order, the hidden categories, the
  // pins and the indent are one decision, not four.
  deepEqual(b.sidebar.hidden, ["Filters"], "the tablet's hidden categories");
  deepEqual(b.sidebar.feedOrder, [FEED_B, FEED_A], "the tablet's feed order");
  deepEqual(b.sidebar.categoryOrder, ["Funny books"], "the tablet's category order");
  deepEqual(b.sidebar.pins, ["Comics"], "the tablet's pinned categories");
  deepEqual(b.sidebar.pinFeeds, [FEED_B], "the tablet's pinned feeds");
  equal(b.sidebar.indentPx, 12, "the tablet's indent");
  truthy(b.adoptedSidebar, "the arrangement was adopted from the archive");

  equal(b.prefs.entries.theme?.value.accent, "amber", "the tablet's theme");
  equal(b.place?.articleId, star, "the tablet's reading position");
  equal(b.place?.articleScroll, 40, "the tablet's scroll");
  truthy(b.adoptedPlace, "the position was adopted from the archive");

  // Marks for posts this device has not fetched are not failures and not marks:
  // they are kept in the document, which is now this device's base, and they land
  // the moment the posts do.
  equal(result.applied.marksSkipped, 2, "marks waiting for posts the tablet has not fetched");
  truthy(b.base !== null, "the import became the device's agreement");
  truthy(b.base.marks[read] !== undefined, "the waiting mark in the agreement");

  // The posts arrive the way a fetch stores them — *after* the agreement — which
  // is what tells the engine they are arrivals rather than an unread the reader
  // chose. Nothing is written over them: the mark the archive carried wins.
  await b.store.putEntries([
    { feedUrl: FEED_A, guid: "p1", title: "Post p1", published: T - 60 },
    { feedUrl: FEED_B, guid: "p2", title: "Post p2", published: T - 60 },
  ]);
  await b.sync(new MemorySyncProvider(), T + 300);
  const flagged = await b.store.entryFlags();
  equal(flagged.find((row) => row.key === read)?.read, 1, "the read mark once the post arrived");
  equal(flagged.find((row) => row.key === star)?.starred, 1, "the star once the post arrived");

  // And the note says what it did rather than claiming a clean import.
  const note = describeImport(result);
  truthy(note.startsWith("Imported "), `the import's line: ${note}`);
  truthy(note.includes("2 marks kept for posts this device has not fetched"), `the waiting marks: ${note}`);
});

await check("import into a library that already has data: nothing is lost on either side", async () => {
  const { a, read, star } = await sourceLibrary();
  const archive = await a.export(T + 100);

  const c = device("desktop");
  await addFeed(c, FEED_C, { title: "Mine", folder: "Kept" });
  const mine = await addEntry(c, FEED_C, "q1", { storedAt: T - 5 });
  await c.store.setStarred([mine], true);
  // A newer setting on the importing device wins: preferences are last-modified.
  c.prefs = withEntry(c.prefs, "theme", { updatedAt: (T + 50) * 1000, value: { accent: "slate" } });
  c.sidebar = { ...emptySidebar(), feedOrder: [FEED_C] };

  const result = await c.import(archive.bytes, T + 200);

  deepEqual(
    await feedUrls(c),
    [FEED_A, FEED_B, FEED_C],
    "the desktop's subscriptions after the import",
  );
  deepEqual(
    await folderNames(c),
    ["Funny books", "Kept"],
    "both libraries' folders, neither one's removed",
  );
  const feeds = await c.store.feeds();
  equal(feeds.find((feed) => feed.key === FEED_C)?.folder, "Kept", "the desktop's own feed kept its folder");
  equal(feeds.find((feed) => feed.key === FEED_A)?.folder, "Funny books", "the archive's feed kept its folder");

  const flagged = await c.store.entryFlags();
  equal(flagged.find((row) => row.key === mine)?.starred, 1, "the star this device already had");
  equal(flagged.find((row) => row.key === star)?.starred, undefined, "the archive's star for a post this device lacks");
  equal(result.applied.marksSkipped, 2, "the archive's marks waiting for posts the desktop lacks");

  equal(c.prefs.entries.theme?.value.accent, "slate", "the newer local setting survived");
  truthy(!c.adopted.includes("theme"), "the archive's older theme was not adopted");
  deepEqual((await c.store.folders()).length, 2, "two folders, not one overwritten by the other");

  // The archive itself is untouched by having been imported: it is a file, and a
  // second device importing it reads exactly what the first one did.
  const reread = await readArchive(archive.bytes);
  deepEqual(Object.keys(reread.snapshot.feeds).sort(), [FEED_A, FEED_B], "the archive's own copy of its feeds");
  equal(reread.snapshot.feeds[FEED_C], undefined, "the archive gained this device's feed");

  // Nothing was written to a provider: an import is a file read, not a sync.
  const folder = new MemorySyncProvider();
  await importArchive({ ...device("spare").source(), bytes: archive.bytes, now: T + 400, provider: folder });
  equal(folder.writes.length, 0, "writes to a provider during an import");
});

await check("a mark the archive does not have is not deleted, and a mark it has is applied", async () => {
  const { a, read } = await sourceLibrary();
  const archive = await a.export(T + 100);

  const worse = device("tablet");
  await addFeed(worse, FEED_A, { title: "Comics", folder: "Funny books" });
  await addEntry(worse, FEED_A, "p1");
  // Read here, and read in the archive: the same fact, so it stays read.
  await worse.store.setRead([read], true);
  await importArchive({ ...worse.source(), bytes: archive.bytes, now: T + 200 });

  equal((await worse.store.entryFlags()).find((row) => row.key === read)?.read, 1, "the read mark");
});

await check("the bytes a Tauri command would carry survive base64, chunked", async () => {
  // The native save path hands the zip to Rust as base64, because a command's
  // arguments are JSON. `toBase64` walks the archive in 32k chunks, so a large
  // library is the case that has to be proved rather than a two-byte fixture.
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const posts = Array.from({ length: 600 }, (unused, index) => ({
    feedUrl: FEED_A,
    guid: `p${index}`,
    title: `A post with a long enough title to fill the archive ${index}`,
    published: T - 60,
  }));
  await a.store.putEntries(posts);
  // Every post read, so the archive carries 600 mark records and is comfortably
  // larger than the 32k the encoder walks at a time.
  await a.store.setRead(
    posts.map((post) => localItemId(post.feedUrl, post.guid)),
    true,
  );
  const archive = await a.export(T + 100);
  truthy(archive.bytes.length > 0x8000, `an archive bigger than one chunk (${archive.bytes.length} bytes)`);

  const carried = toBase64(archive.bytes);
  deepEqual(
    Array.from(Buffer.from(carried, "base64")),
    Array.from(archive.bytes),
    "the bytes Rust would decode",
  );
});

/* --------------------------------------------------------------------------
 * Refusals
 * ----------------------------------------------------------------------- */

await check("a file that is not a zip is refused, and the library is untouched", async () => {
  const b = device("tablet");
  await addFeed(b, FEED_C, { title: "Mine" });
  const message = await refusal(b.import(encoder.encode("this is not a zip at all"), T + 200));
  mentions(message, "not a HardlyReader archive");
  deepEqual(await feedUrls(b), [FEED_C], "the library after a refusal");
  equal(b.base, null, "the agreement after a refusal");
});

await check("an archive with no manifest is refused, and says so", async () => {
  const b = device("tablet");
  const bytes = writeZip([{ name: "library.json", data: encoder.encode("{}") }]);
  const message = await refusal(b.import(bytes, T + 200));
  mentions(message, "no manifest.json", "Nothing was changed");
});

await check("an archive from a newer version is refused, and says which version", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const stored = await readZip((await a.export(T + 100)).bytes);

  const manifest = JSON.parse(textOf(stored, MANIFEST_FILE));
  const files = [...stored.entries()].map(([name, data]) => ({ name, data }));
  const index = files.findIndex((file) => file.name === MANIFEST_FILE);
  files[index] = {
    name: MANIFEST_FILE,
    data: encoder.encode(JSON.stringify({ ...manifest, version: 7 })),
  };

  const b = device("tablet");
  const message = await refusal(b.import(writeZip(files), T + 200));
  mentions(message, "newer version", "format 7", "build reads 1");
  deepEqual(await feedUrls(b), [], "the library after a newer archive");
});

await check("an archive whose format is not this one is refused, naming the format", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const stored = await readZip((await a.export(T + 100)).bytes);
  const manifest = JSON.parse(textOf(stored, MANIFEST_FILE));
  const files = [...stored.entries()].map(([name, data]) => ({ name, data }));
  const index = files.findIndex((file) => file.name === MANIFEST_FILE);
  files[index] = {
    name: MANIFEST_FILE,
    data: encoder.encode(JSON.stringify({ ...manifest, format: "someone-elses-sync" })),
  };

  const message = await refusal(device("tablet").import(writeZip(files), T + 200));
  mentions(message, "someone-elses-sync", "not");
});

await check("an encrypted archive is refused rather than guessed at", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const stored = await readZip((await a.export(T + 100)).bytes);
  const manifest = JSON.parse(textOf(stored, MANIFEST_FILE));
  const files = [...stored.entries()].map(([name, data]) => ({ name, data }));
  const index = files.findIndex((file) => file.name === MANIFEST_FILE);
  files[index] = {
    name: MANIFEST_FILE,
    data: encoder.encode(JSON.stringify({ ...manifest, encryption: "xchacha20-poly1305" })),
  };

  const message = await refusal(device("tablet").import(writeZip(files), T + 200));
  mentions(message, "xchacha20-poly1305", "cannot read");
});

await check("a manifest that promises a file the zip does not hold is refused, naming it", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const stored = await readZip((await a.export(T + 100)).bytes);
  const files = [...stored.entries()]
    .filter(([name]) => name !== "state.json")
    .map(([name, data]) => ({ name, data }));

  const b = device("tablet");
  const message = await refusal(b.import(writeZip(files), T + 200));
  mentions(message, "state.json", "not in the zip");
  deepEqual(await feedUrls(b), [], "the library after a truncated archive");
});

await check("a truncated zip is refused by its checksum, not half-imported", async () => {
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  const bytes = (await a.export(T + 100)).bytes;
  // Flip a byte inside library.json's payload: the CRC no longer matches.
  const damaged = Uint8Array.from(bytes);
  const at = decoder.decode(damaged.subarray(0, 200)).indexOf('{"feeds"');
  truthy(at > 0, "the library payload was found in the zip");
  damaged[at + 4] = damaged[at + 4] ^ 0xff;

  const b = device("tablet");
  const message = await refusal(b.import(damaged, T + 200));
  mentions(message, "library.json");
  deepEqual(await feedUrls(b), [], "the library after a damaged archive");
});

/* --------------------------------------------------------------------------
 * The lines the panel prints
 * ----------------------------------------------------------------------- */

await check("the export line names what the archive holds", async () => {
  const { a } = await sourceLibrary();
  const archive = await a.export(T + 100);
  equal(
    describeCounts(archive.counts),
    "2 feeds, 1 folder, 2 marks, the sidebar's arrangement and a reading position",
    "the export's line",
  );
  equal(
    describeCounts(countsOf({ ...archive.snapshot, marks: {} })),
    "2 feeds, 1 folder, the sidebar's arrangement and a reading position",
    "a line with no marks and no plural",
  );
});

await check("an import of a library that is already here says nothing new arrived", async () => {
  const { a } = await sourceLibrary();
  const archive = await a.export(T + 100);
  const again = device("laptop");
  await addFeed(again, FEED_A, { title: "Comics", folder: "Funny books" });
  await addFeed(again, FEED_B, { title: "Other" });
  const result = await again.import(archive.bytes, T + 200);
  const note = describeImport(result);
  truthy(note.startsWith("Nothing new arrived"), `a second import's line: ${note}`);
});

console.log(`\nsync-archive: ${passed} checks passed`);
