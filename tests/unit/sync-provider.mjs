/**
 * The provider seam: the engine talks to a provider, not to a folder.
 *
 * `sync.ts` merges two libraries; `sync-provider.ts` says where the document
 * lives. What is worth pinning here is that the seam is real rather than a
 * rename:
 *
 * - two devices reconcile through a provider that is not a filesystem at all,
 * - a provider whose `read()` throws reaches nothing — not the library, not the
 *   document, not the last agreement,
 * - the four cloud ids are *names for a folder the reader's own sync client
 *   mirrors*, so a write lands in the folder object they were given and nowhere
 *   else. No OAuth, no account, no network.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/sync-provider.mjs
 */
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncFolder } from "../../src/api/local/sync-folder.ts";
import {
  FolderSyncProvider,
  MemorySyncProvider,
  SYNC_PROVIDERS,
  SYNC_PROVIDER_IDS,
  syncProviderAt,
} from "../../src/api/local/sync-provider.ts";
import { syncOnce } from "../../src/api/local/sync.ts";
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

function truthy(value, what) {
  if (!value) fail(`${what}: expected something, got ${JSON.stringify(value)}`);
}

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/**
 * One device: a library, the last agreement it reached, and its settings.
 *
 * The same shape `local-sync.mjs` uses, with the provider passed in — a device
 * never sees the provider's type, only that it can read and write a document.
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
    async sync(provider, at) {
      const run = await syncOnce({
        store,
        provider,
        device: name,
        base: this.base,
        now: at,
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

/** An article on a device, stored at a given second. */
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

/* --------------------------------------------------------------------------
 * Two devices, one provider
 * ----------------------------------------------------------------------- */

await check("two devices merge through one MemorySyncProvider", async () => {
  const shared = new MemorySyncProvider();
  const a = device("laptop");
  const b = device("tablet");

  await a.store.subscribe(FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);

  const first = await a.sync(shared, T + 100);
  equal(first.unchanged, false, "a provider with nothing in it is not unchanged");
  equal(shared.writes.length, 1, "the first sync wrote the document");

  // The tablet read the same document and agreed with every line of it, so it
  // wrote nothing back — which is what keeps a cloud folder quiet.
  const adopted = await b.sync(shared, T + 101);
  equal(adopted.unchanged, true, "a device that only listened did not write");
  deepEqual(await feedUrls(b), [FEED_A], "the tablet's subscriptions");
  equal(adopted.applied.marksSkipped, 1, "a mark for an article the tablet does not hold");

  // The tablet fetches the post afterwards and stars it.
  await addEntry(b, FEED_A, "p1", { storedAt: T + 150 });
  await b.store.setStarred([post], true);
  await b.sync(shared, T + 200);
  const followUp = await a.sync(shared, T + 201);
  equal(followUp.unchanged, true, "the laptop agreed with the document the tablet wrote");

  const onA = await a.store.entry(post);
  const onB = await b.store.entry(post);
  equal(onA.read, 1, "the laptop still has it read");
  equal(onA.starred, 1, "the laptop picked up the star");
  equal(onB.read, 1, "the tablet picked up the read mark");
  equal(onB.starred, 1, "the tablet still has its star");

  const document = JSON.parse(shared.peek());
  deepEqual(Object.keys(document.feeds).sort(), [FEED_A], "the subscriptions in the document");
  equal(document.marks[post].read, true, "the read mark in the document");
  equal(document.marks[post].starred, true, "the star in the document");
  equal(shared.writes.length, 2, "one write per document that actually changed");
});

/* --------------------------------------------------------------------------
 * A provider that cannot be read
 * ----------------------------------------------------------------------- */

await check("a provider whose read throws leaves the library and the document alone", async () => {
  const shared = new MemorySyncProvider();
  const a = device("laptop");

  await a.store.subscribe(FEED_A, { title: "Comics" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  await a.sync(shared, T + 100);

  const document = shared.peek();
  const writes = shared.writes.length;
  const agreement = a.base;

  // This device does something the merge has not seen, and then the folder is
  // out of reach: no permission, a cloud client holding the file, a drive that
  // is not mounted.
  await a.store.subscribe(FEED_B, { title: "Other" });
  shared.readError = new Error("Permission denied reading the sync folder");

  let threw = "";
  try {
    await a.sync(shared, T + 200);
  } catch (error) {
    threw = error.message;
  }
  truthy(threw.includes("Permission denied"), `the provider's own error: ${threw}`);

  deepEqual(await feedUrls(a), [FEED_A, FEED_B], "this device's subscriptions survived");
  equal((await a.store.entry(post)).read, 1, "the read mark survived");
  equal(shared.peek(), document, "the document was not written over");
  equal(shared.writes.length, writes, "nothing was written");
  equal(a.base, agreement, "the last agreement was not advanced");

  // With the folder back, the run carries the change it could not read past.
  await a.sync(shared, T + 300);
  truthy(
    JSON.parse(shared.peek()).feeds[FEED_B] !== undefined,
    "the feed the failed run withheld travels once the folder is readable",
  );
  equal((await a.store.entry(post)).read, 1, "the mark is still read");
});

/* --------------------------------------------------------------------------
 * The four clouds are folders
 * ----------------------------------------------------------------------- */

await check("the four cloud ids name a folder, and write to the one they were given", async () => {
  const path = "/home/reader/iCloud Drive";

  for (const id of ["icloud", "gdrive", "dropbox", "onedrive"]) {
    const folder = new MemorySyncFolder("{\"version\":1}");
    const provider = new FolderSyncProvider(id, folder, path);
    equal(provider.id, id, `the id of ${id}`);
    equal(provider.label, SYNC_PROVIDERS[id].label, `the label of ${id}`);

    const said = provider.describe();
    truthy(said.includes(SYNC_PROVIDERS[id].label), `${id} says which service it is: ${said}`);
    truthy(said.includes(path), `${id} says where it writes: ${said}`);

    // Underneath it is still just a folder: reading returns what the folder
    // holds, and a write lands there. Nothing opens a socket for any id.
    equal(await provider.read(), "{\"version\":1}", `${id} reads the folder it was given`);
    await provider.write(`written through ${id}`);
    equal(folder.peek(), `written through ${id}`, `${id} writes to that same folder`);
  }
});

await check("every id is listed once, and a folder provider without a path says so", async () => {
  deepEqual([...SYNC_PROVIDER_IDS].sort(), Object.keys(SYNC_PROVIDERS).sort(), "the ids and their tables");
  for (const id of SYNC_PROVIDER_IDS) {
    truthy(SYNC_PROVIDERS[id].label !== "", `${id} has a label`);
    truthy(SYNC_PROVIDERS[id].place !== "", `${id} has a place`);
  }

  const bare = new FolderSyncProvider("folder", new MemorySyncFolder());
  equal(bare.describe(), SYNC_PROVIDERS.folder.place, "a provider that was not told a path describes the place only");

  const memory = new MemorySyncProvider();
  equal(memory.id, "folder", "the test double stands in for a folder");
  equal(memory.label, SYNC_PROVIDERS.folder.label, "and says so");
});

await check("a folder provider for a reader's choice is refused where there is no folder to reach", async () => {
  // This suite runs in Node, which is the browser's case: no Tauri, so no folder
  // on the device, so the provider is refused rather than offered as a switch
  // that does nothing. The path rules are `syncFolderAt`'s.
  let empty = "";
  try {
    syncProviderAt("folder", "   ");
  } catch (error) {
    empty = error.message;
  }
  truthy(empty.includes("needs a path"), `an empty path: ${empty}`);

  let refused = "";
  try {
    syncProviderAt("icloud", "/home/reader/iCloud Drive");
  } catch (error) {
    refused = error.message;
  }
  truthy(refused.includes("needs the desktop app"), `a build that cannot reach a folder: ${refused}`);
});

/* --------------------------------------------------------------------------
 * The seam is the interface
 * ----------------------------------------------------------------------- */

await check("any object with the four members is a provider", async () => {
  let held = null;
  const provider = {
    id: "dropbox",
    label: "Dropbox",
    async read() {
      return held;
    },
    async write(document) {
      held = document;
    },
    describe() {
      return "somewhere a reader chose";
    },
  };

  const a = device("laptop");
  await a.store.subscribe(FEED_A, { title: "Comics" });
  await a.sync(provider, T + 100);

  truthy(held !== null, "the plain object was written through");
  equal(JSON.parse(held).feeds[FEED_A].title, "Comics", "the document it holds");
});

console.log(`\n${passed} checks passed`);
