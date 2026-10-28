/**
 * Changing provider is a migration, not a re-connect.
 *
 * `docs/sync-format.md` says the nine steps, and this suite is the proof of them
 * against the engine and the state behind Settings:
 *
 *   1. fully sync the current provider      6. write canonical state to the new one
 *   2. read canonical state                 7. verify what was written
 *   3. connect the new provider             8. switch the active provider
 *   4. look for existing state              9. never delete the old provider's files
 *   5. merge if there is any
 *
 * What is worth pinning is everything a "connect and hope" would get wrong:
 *
 *   - the old folder is left **whole** — step 1 is a full sync, so the file that
 *     stays behind is everything this device knows, and no later step writes to
 *     it or deletes it;
 *   - a failure at any step leaves the old provider in use, leaves the new folder
 *     as it was, and names the step — `ProviderSwitchError.step`, and the same
 *     word in the one line the panel shows;
 *   - a new folder that already holds a document belongs to the device that moved
 *     first, and the second device cannot bury its changes;
 *   - the agreement moves with the provider, so the device that switched does not
 *     resurrect the abandoned provider's state on its next run.
 *
 * The acceptance at the end is the owner's own sentence, run over two real
 * `LocalStore`s and three folders: one device switches while the other is
 * offline, and both end on the new provider with the same feeds and marks.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/provider-switch.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncFolder } from "../../src/api/local/sync-folder.ts";
import { MemorySyncProvider, SYNC_PROVIDERS } from "../../src/api/local/sync-provider.ts";
import {
  ProviderSwitchError,
  emptySnapshot,
  parseSyncSnapshot,
  serializeSnapshot,
  syncOnce,
  switchProvider,
} from "../../src/api/local/sync.ts";
import { emptyPrefs } from "../../src/lib/prefs-sync.ts";
import { emptySetup, folderFor, parseSetup, serializeSetup, withFolder, withProvider, withSwitch } from "../../src/lib/sync-setup.ts";

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

/** Runs `fn` expecting a `ProviderSwitchError`, and answers it. */
async function switchFailure(fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ProviderSwitchError) return error;
    fail(`expected a ProviderSwitchError, got ${error?.name}: ${error?.message}`);
  }
  fail("expected the migration to fail, and it did not");
}

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";
const FEED_C = "https://c.test/atom.xml";

const PREFS = () => ({
  local: emptyPrefs(),
  adopt: () => {},
});

/** One device: a library, the last agreement it reached, and its settings. */
function device(name) {
  const database = new MemoryDatabase();
  const store = new LocalStore(database);
  return {
    name,
    store,
    database,
    base: null,
    async sync(provider, at) {
      const run = await syncOnce({
        store,
        provider,
        device: name,
        base: this.base,
        now: at,
        prefs: PREFS(),
      });
      this.base = run.snapshot;
      return run;
    },
    async move(from, to, at) {
      const run = await switchProvider({
        store,
        from,
        to,
        device: name,
        base: this.base,
        now: at,
        prefs: PREFS(),
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

/** An article on a device, with the time this device stored it. */
async function addEntry(dev, feedUrl, guid, { storedAt = T - 10 } = {}) {
  await dev.store.putEntries([{ feedUrl, guid, title: `Post ${guid}` }]);
  const id = localItemId(feedUrl, guid);
  const row = await dev.database.get("entries", id);
  await dev.database.write([{ type: "put", table: "entries", row: { ...row, stored_at: storedAt } }]);
  return id;
}

async function feedUrls(dev) {
  return (await dev.store.feeds()).map((feed) => feed.key).sort();
}

/**
 * A provider wearing a service's own name.
 *
 * `MemorySyncProvider` is `folder`-named because it stands in for a folder; a
 * migration's sentences name the two services, so the stand-ins do too — the
 * message a reader sees is then the one the card is about.
 */
class NamedProvider extends MemorySyncProvider {
  constructor(id) {
    super();
    this.id = id;
    this.label = SYNC_PROVIDERS[id].label;
  }

  describe() {
    return `${this.label}, in memory`;
  }
}

/** A provider whose read fails on one chosen call, for the steps after the sync. */
class FaultyReader extends NamedProvider {
  reads = 0;
  failOn = 0;

  async read() {
    this.reads += 1;
    if (this.reads === this.failOn) throw new Error("The cloud client is still uploading");
    return super.read();
  }
}

/** A provider that loses a feed on the way in: the write says it worked and it did not. */
class ForgetfulProvider extends NamedProvider {
  /** The feed key it drops from every document it is handed. */
  drop = "";

  async write(document) {
    const snapshot = JSON.parse(document);
    delete snapshot.feeds[this.drop];
    await super.write(JSON.stringify(snapshot));
  }
}

/* --------------------------------------------------------------------------
 * The engine: one order, and what a failure leaves behind
 * ----------------------------------------------------------------------- */

await check("a migration carries the library across and leaves the old file whole", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  await a.sync(icloud, T + 100);

  const leftBehind = icloud.peek();
  const moved = await a.move(icloud, drive, T + 200);

  // 6 and 7: the new folder holds the merged document, and it parses back to it.
  const written = parseSyncSnapshot(drive.peek());
  deepEqual(written.feeds[FEED_A].title, "Comics", "the feed arrived");
  equal(written.marks[post].read, true, "and so did the read mark");
  deepEqual(written.prefs, moved.snapshot.prefs, "and the settings");
  equal(moved.adoptedTarget, false, "nothing was there before");

  // 1, 2 and 9: the old folder is what step 1 left, untouched since.
  equal(icloud.peek(), leftBehind, "the old file is byte for byte what the sync left");

  // A second device could still have read the old folder the whole time.
  const b = device("tablet");
  await b.sync(icloud, T + 201);
  deepEqual(await feedUrls(b), [FEED_A], "a device still on the old provider is not stranded");
});

await check("the old folder is never written to after the first step", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(icloud, T + 100);

  const writes = icloud.writes.length;
  await a.move(icloud, drive, T + 200);
  equal(icloud.writes.length, writes, "the migration wrote nothing more to the old folder");
  equal(drive.writes.length, 1, "and the new folder was written once");
});

await check("a device that has already synced leaves the old file literally unmodified", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");
  const a = device("laptop");
  await addFeed(a, FEED_A, { title: "Comics" });
  await a.sync(icloud, T + 100);
  const before = icloud.peek();

  await a.move(icloud, drive, T + 200);
  equal(icloud.peek(), before, "step 1 had nothing to write, so the file is untouched");
});

await check("a failure at any step names the step and leaves the old provider in use", async () => {
  const build = async () => {
    const icloud = new NamedProvider("icloud");
    const drive = new NamedProvider("gdrive");
    const a = device("laptop");
    await addFeed(a, FEED_A, { title: "Comics" });
    const post = await addEntry(a, FEED_A, "p1");
    await a.store.setRead([post], true);
    await a.sync(icloud, T + 100);
    return { icloud, drive, a, post };
  };

  // Step 1: the full sync of the current provider.
  {
    const { icloud, drive, a } = await build();
    icloud.readError = new Error("The iCloud folder could not be read");
    const before = await feedUrls(a);
    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "sync", "the failing step");
    equal(drive.writes.length, 0, "the new folder was not written");
    deepEqual(await feedUrls(a), before, "and the library is untouched");
    truthy(error.message.includes("iCloud Drive is still the provider"), error.message);
  }

  // Step 1 again, with a document a newer build wrote: refused by the sync
  // rather than merged, and the new folder is never reached.
  {
    const { icloud, drive, a, post } = await build();
    icloud.write(serializeSnapshot({ ...emptySnapshot("phone", T + 150), version: 99 }));
    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "sync", "the failing step");
    equal(drive.writes.length, 0, "nothing was written to the new folder");
    equal((await a.store.entry(post)).read, 1, "and the local library is untouched");
    truthy(error.message.includes("newer version"), error.message);
  }

  // Step 2: reading the canonical state back. A folder that answered the sync and
  // then stopped answering is a failure with nothing half-done.
  {
    const icloud = new FaultyReader("icloud");
    const drive = new NamedProvider("gdrive");
    const a = device("laptop");
    await addFeed(a, FEED_A, { title: "Comics" });
    await a.sync(icloud, T + 100);
    // The migration's own sync reads first; this fails the read after it.
    icloud.failOn = icloud.reads + 2;

    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "read", "the failing step");
    equal(drive.writes.length, 0, "nothing was written to the new folder");
    deepEqual(await feedUrls(a), [FEED_A], "and the library is untouched");
    truthy(error.message.includes("iCloud Drive is still the provider in use"), error.message);
  }

  // Step 4: looking in the new folder. A file this build cannot read might be
  // the other device's, so it is never written over.
  {
    const { icloud, drive, a, post } = await build();
    await drive.write("{ truncated");
    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "look", "the failing step");
    equal(drive.peek(), "{ truncated", "the unreadable file is exactly as it was");
    equal((await a.store.entry(post)).read, 1, "and the library is untouched");
  }

  // Step 6: the write.
  {
    const { icloud, drive, a, post } = await build();
    drive.writeError = new Error("No space left on device");
    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "write", "the failing step");
    equal(drive.peek(), null, "the new folder is still empty");
    equal((await a.store.entry(post)).read, 1, "and the library is untouched");
    truthy(error.message.includes("iCloud Drive is still the provider"), error.message);
  }

  // Step 7: the verification. A provider that accepts the write and drops a feed
  // is caught here, not discovered by the reader a week later.
  {
    const icloud = new NamedProvider("icloud");
    const drive = new ForgetfulProvider("gdrive");
    drive.drop = FEED_B;
    const a = device("laptop");
    await addFeed(a, FEED_A, { title: "Comics" });
    await addFeed(a, FEED_B, { title: "News" });
    const post = await addEntry(a, FEED_A, "p1");
    await a.store.setRead([post], true);
    await a.sync(icloud, T + 100);

    const error = await switchFailure(() => a.move(icloud, drive, T + 200));
    equal(error.step, "verify", "the failing step");
    truthy(error.message.includes("not what was written"), error.message);
    truthy(error.message.includes("iCloud Drive is still the provider in use"), error.message);
    equal((await a.store.entry(post)).read, 1, "and the library is untouched");
  }

  // Step 8: applying what came back from the new folder.
  {
    const { icloud, drive, a } = await build();
    // The new folder already holds a mark from the device that moved first, so
    // the merge has something to apply here — and the store refuses to take it.
    const other = device("phone");
    await addFeed(other, FEED_A, { title: "Comics" });
    const post = await addEntry(other, FEED_A, "p1");
    await other.store.setStarred([post], true);
    await other.sync(drive, T + 150);

    // The same library, wearing one refusal: every method and row resolves
    // through the real store, and starring throws the way a read-only library
    // would. Delegated rather than re-listed, so a store call this build adds
    // later is not a hole in the check — the step this pins is the *apply*, and
    // a missing method would fail step 1 instead and pass for the wrong reason.
    const refusing = Object.assign(Object.create(a.store), {
      setStarred: () => {
        throw new Error("The library is open read-only");
      },
    });
    const error = await switchFailure(() =>
      switchProvider({
        store: refusing,
        from: icloud,
        to: drive,
        device: "laptop",
        base: a.base,
        now: T + 200,
        prefs: PREFS(),
      }),
    );
    equal(error.step, "apply", "the failing step");
    truthy(error.message.includes("this device is still on iCloud Drive"), error.message);
  }
});

await check("a folder that already holds a document belongs to the device that moved first", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");

  const a = device("laptop");
  const b = device("tablet");
  await addFeed(a, FEED_A, { title: "Comics" });
  await addFeed(b, FEED_A, { title: "Comics" });
  await addFeed(b, FEED_B, { title: "News" });
  const post = await addEntry(a, FEED_A, "p1");
  await a.store.setRead([post], true);
  await a.sync(icloud, T + 100);
  await b.sync(icloud, T + 101);

  // A moves first.
  await a.move(icloud, drive, T + 200);
  // B has a change that never reached iCloud, and then moves too.
  await addFeed(b, FEED_C, { title: "Later" });
  await b.sync(icloud, T + 300); // still on the old provider, which A left behind
  const moved = await b.move(icloud, drive, T + 400);

  equal(moved.adoptedTarget, true, "the second device found the first one's document");
  const written = parseSyncSnapshot(drive.peek());
  deepEqual(Object.keys(written.feeds).sort(), [FEED_A, FEED_B, FEED_C], "nothing either device added was lost");
  equal(written.feeds[FEED_A].title, "Comics", "the name the first device agreed survived");
});

/* --------------------------------------------------------------------------
 * The acceptance: one device switches, the other is offline
 *
 * A is on iCloud. B is on iCloud and then goes offline with an unstarred star
 * and a new feed. A switches to Google Drive. B comes back, moves to Google
 * Drive as well, and the two libraries end the same — while iCloud's file is
 * still there, complete, and not deleted.
 * ----------------------------------------------------------------------- */

await check("switching with the second device offline ends with both devices on the new provider", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");

  const a = device("laptop");
  const b = device("tablet");

  await addFeed(a, FEED_A, { title: "Comics", folder: "Funny books" });
  await addFeed(a, FEED_B, { title: "News" });
  const post = await addEntry(a, FEED_A, "p1");
  const other = await addEntry(a, FEED_A, "p2");
  await a.store.setRead([post, other], true);
  await a.store.setStarred([other], true);
  await a.sync(icloud, T + 100);

  await b.sync(icloud, T + 101);
  // Articles do not travel, so the tablet fetches them itself — after the
  // agreement, so its unread state is an arrival and not an unmark — and syncs
  // once more to have the marks on its own rows.
  await addEntry(b, FEED_A, "p1", { storedAt: T + 101 });
  await addEntry(b, FEED_A, "p2", { storedAt: T + 101 });
  await b.sync(icloud, T + 102);
  deepEqual(await feedUrls(b), [FEED_A, FEED_B], "the tablet started in step");
  equal((await b.store.entry(other)).starred, 1, "and in step about the star");

  // B goes offline: a feed added, and a star removed, in its own library only.
  await addFeed(b, FEED_C, { title: "Later" });
  await b.store.setStarred([other], false);

  // A switches. This is the whole of the card: sync, read, look, merge, write,
  // verify — and only then the provider in use changes. A had just synced, so
  // step 1 has nothing of its own to write and the file is untouched by the
  // migration.
  const leftBehind = icloud.peek();
  const movedA = await a.move(icloud, drive, T + 200);
  equal(icloud.peek(), leftBehind, "the old file is exactly what A's last sync wrote");
  equal(movedA.adoptedTarget, false, "and Google Drive was empty");

  // The old provider is not deleted, and still says everything A knew.
  truthy(icloud.peek() !== null, "the old file is still there");
  const abandoned = parseSyncSnapshot(icloud.peek());
  deepEqual(Object.keys(abandoned.feeds).sort(), [FEED_A, FEED_B], "it still holds A's subscriptions");
  equal(abandoned.marks[other].starred, true, "and A's marks, as A last synced them");

  // B comes back online and moves too — its own migration, from the file that is
  // still there to the folder the other device is already using. B had offline
  // work, so step 1 is what puts it into the old file: the copy B leaves behind
  // is complete rather than stale.
  const movedB = await b.move(icloud, drive, T + 300);
  equal(movedB.adoptedTarget, true, "B found A's document in the new folder");
  const stranded = parseSyncSnapshot(icloud.peek());
  deepEqual(
    Object.keys(stranded.feeds).sort(),
    [FEED_A, FEED_B, FEED_C],
    "the old file still holds everything B knew, so a device left on it is not stranded",
  );
  equal(stranded.marks[other].starred, false, "including the star B removed");

  // B's own library: A's state arrived, and B's offline changes are still B's.
  deepEqual(await feedUrls(b), [FEED_A, FEED_B, FEED_C], "B has A's feeds and its own");
  equal((await b.store.entry(other)).starred, 0, "and B's unstar is still B's");

  // A syncs on the new provider and picks up what B did offline.
  await a.sync(drive, T + 400);
  deepEqual(await feedUrls(a), [FEED_A, FEED_B, FEED_C], "A adopted the feed B added offline");
  equal((await a.store.entry(other)).starred, 0, "and the star B removed");

  // Both devices, the same feeds and the same marks.
  deepEqual(await feedUrls(a), await feedUrls(b), "the same subscriptions");
  for (const id of [post, other]) {
    const left = await a.store.entry(id);
    const right = await b.store.entry(id);
    equal(left.read, right.read, `the same read mark on ${id}`);
    equal(left.starred, right.starred, `the same star on ${id}`);
  }

  // Both files still exist: the new one, and the reader's own where they put it.
  truthy(drive.peek() !== null && icloud.peek() !== null, "two files, on purpose");
  truthy(
    Object.keys(parseSyncSnapshot(drive.peek()).feeds).length === 3,
    "and the new one is the whole library",
  );
});

await check("the agreement moves with the provider, so the old state is not resurrected", async () => {
  const icloud = new NamedProvider("icloud");
  const drive = new NamedProvider("gdrive");

  const a = device("laptop");
  const b = device("tablet");
  await addFeed(a, FEED_A, { title: "Comics" });
  await addFeed(a, FEED_B, { title: "News" });
  await a.sync(icloud, T + 100);
  await b.sync(icloud, T + 101);

  // B deletes a feed on the new provider *after* A has switched there, and A
  // switches before B has touched anything.
  await a.move(icloud, drive, T + 200);
  await b.move(icloud, drive, T + 201);
  await b.store.unsubscribe(FEED_B);
  await b.sync(drive, T + 300);

  const synced = await a.sync(drive, T + 301);
  deepEqual(await feedUrls(a), [FEED_A], "the deletion reached the device that switched first");
  equal(synced.unchanged, true, "and the run had nothing left to say");

  // The abandoned provider's document still lists FEED_B. A must not read it,
  // and must not bring it back.
  deepEqual(await feedUrls(a), [FEED_A], "nothing came back from the old provider");
  const quiet = await a.sync(drive, T + 400);
  equal(quiet.unchanged, true, "a later run is quiet too");
});

/* --------------------------------------------------------------------------
 * The record: the agreement is replaced, not dropped
 * ----------------------------------------------------------------------- */

await check("withSwitch keeps the document the migration wrote, and the folder", async () => {
  const before = withFolder(withProvider(emptySetup(), "icloud"), "icloud", "~/iCloud/HardlyReader");
  const document = parseSyncSnapshot(
    serializeSnapshot({ ...emptySnapshot("laptop", T + 200), feeds: { [FEED_A]: { at: T, title: "A", titleSource: "feed", folder: null, addedAt: T, removed: false } } }),
  );

  const after = withSwitch(
    withFolder(before, "gdrive", "~/Drive/HardlyReader"),
    "gdrive",
    document,
    T * 1000,
  );
  equal(after.provider, "gdrive", "the provider moved");
  equal(folderFor(after, "gdrive"), "~/Drive/HardlyReader", "its folder is the one written to");
  equal(folderFor(after, "icloud"), "~/iCloud/HardlyReader", "and the old folder is still remembered");
  equal(after.base, document, "the agreement is the document the migration wrote");
  equal(after.lastSyncedAt, T * 1000, "the last-run time is the migration's");

  // A folder typed for the service being switched to does not drop the
  // agreement of the one still in use.
  const typed = withFolder(before, "gdrive", "~/Drive/HardlyReader");
  equal(typed.base, before.base, "another service's folder leaves this agreement alone");
  equal(typed.lastSyncedAt, before.lastSyncedAt, "and its last-run time");

  // Round-trips through storage like every other record.
  const back = parseSetup(serializeSetup(after));
  equal(back.provider, "gdrive", "the provider is read back");
  equal(back.base?.writtenAt, T + 200, "and so is the agreement");
});

/* --------------------------------------------------------------------------
 * The state behind Settings: the picker is not a switch
 * ----------------------------------------------------------------------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}/provider-switch`);

let checks = 0;
let failures = 0;
function checkOnly(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function expect(actual, expected, what) {
  checkOnly(what, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const built = new Map();

function buildRunes(relative) {
  const file = join(ROOT, relative);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  const rewritten = compiled.js.code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(file, specifier);
    if (source === null) return whole;
    return `${before}${quote}${built.get(source) ?? pathToFileURL(source).href}${quote}`;
  });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewritten);
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const LOCAL = { serverUrl: "device://local", email: "local" };

try {
  buildRunes("src/lib/sync-setup.ts");
  buildRunes("src/state/device-sync.svelte.ts");

  const { DeviceSyncState } = await import(built.get(join(ROOT, "src/state/device-sync.svelte.ts")));

  const stateOf = async (library, providers) => {
    const store = new LocalStore(new MemoryDatabase());
    await store.subscribe(FEED_A, { title: "Comics" });
    const state = new DeviceSyncState();
    state.bind(store, LOCAL, { providers });
    return { state, store };
  };

  {
    globalThis.localStorage = fakeStorage();
    const icloud = new NamedProvider("icloud");
    const drive = new NamedProvider("gdrive");
    const { state, store } = await stateOf(null, { icloud, gdrive: drive });

    state.choose("icloud", PREFS());
    state.setFolder("~/iCloud/HardlyReader", PREFS());
    const first = await state.syncNow(PREFS());
    checkOnly("a first run works", first !== null);
    const agreement = state.setup.base;
    const oldFile = icloud.peek();

    // Pressing another service is not a switch on its own: it needs the folder
    // that service mirrors, and until then the provider in use has not changed.
    state.choose("gdrive", PREFS());
    expect(state.provider, "icloud", "the provider in use is still the old one");
    expect(state.pending, "gdrive", "the service being switched to is pending");
    expect(state.shown, "gdrive", "and the rows are about it");
    expect(state.folder, "", "its folder is the one thing missing");
    expect(drive.writes.length, 0, "nothing was written before there was a folder");
    expect(state.setup.base, agreement, "and the agreement is untouched");

    state.setFolder("~/Drive/HardlyReader", PREFS());
    // The migration is async; one microtask turn plus the folder reads is enough.
    for (let i = 0; i < 20 && state.running; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.provider, "gdrive", "the switch finished and the provider moved");
    expect(state.pending, null, "nothing is pending any more");
    expect(drive.writes.length, 1, "the new folder was written once");
    expect(icloud.peek(), oldFile, "the old file is exactly what its last sync wrote");
    expect(folderFor(state.setup, "icloud"), "~/iCloud/HardlyReader", "the old folder is still remembered");
    expect(state.note, null, "a switch that worked says nothing extra");
    checkOnly("and it says where the old file is", state.movedFrom?.where === "~/iCloud/HardlyReader", JSON.stringify(state.movedFrom));
    checkOnly(
      "the agreement is the document the migration wrote",
      JSON.stringify(state.setup.base) === JSON.stringify(drive.peek() === null ? null : parseSyncSnapshot(drive.peek())),
    );
    deepEqual(
      parseSyncSnapshot(drive.peek()).feeds[FEED_A].title,
      "Comics",
      "the feed is in the new folder under the name it had",
    );

    // The run after a switch is a run against the new provider, and it does not
    // resurrect anything from the old one.
    const after = await state.syncNow(PREFS());
    checkOnly("a run after the switch works", after !== null);
    expect(icloud.writes.length, 1, "the old folder was written by the first run only");
    deepEqual((await store.feeds()).map((feed) => feed.key), [FEED_A], "the library is what it was");
  }

  {
    globalThis.localStorage = fakeStorage();
    const icloud = new NamedProvider("icloud");
    const drive = new NamedProvider("gdrive");
    const { state } = await stateOf(null, { icloud, gdrive: drive });

    state.choose("icloud", PREFS());
    state.setFolder("~/iCloud/HardlyReader", PREFS());
    await state.syncNow(PREFS());
    const agreement = state.setup.base;
    const lastRun = state.setup.lastSyncedAt;

    drive.writeError = new Error("The Drive folder is not writable");
    state.choose("gdrive", PREFS());
    state.setFolder("~/Drive/HardlyReader", PREFS());
    for (let i = 0; i < 20 && state.running; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.provider, "icloud", "a failed migration leaves the old provider in use");
    expect(state.pending, null, "and does not leave a half-chosen service behind");
    expect(state.setup.base, agreement, "the agreement is untouched");
    expect(state.setup.lastSyncedAt, lastRun, "and so is the last-run time");
    checkOnly(
      "the one line names the step and the provider that is still in use",
      (state.note ?? "").includes("writing the new file to Google Drive") &&
        (state.note ?? "").includes("iCloud Drive is still the provider"),
      String(state.note),
    );
    checkOnly("and says the copy did not move", state.movedFrom === null);
  }

  {
    globalThis.localStorage = fakeStorage();
    const icloud = new NamedProvider("icloud");
    const drive = new NamedProvider("gdrive");
    const { state, store } = await stateOf(null, { icloud, gdrive: drive });

    // A device with no library has nothing to migrate, so choosing is choosing.
    state.bind(null, LOCAL, { providers: { icloud, gdrive: drive } });
    state.choose("icloud", PREFS());
    expect(state.provider, "icloud", "a choice with no library is remembered");
    state.choose("gdrive", PREFS());
    expect(state.provider, "gdrive", "and so is the next one: there is no document to move");
    checkOnly("no migration ran", drive.writes.length === 0 && store !== null);
  }

  // The panel says what happens to the reader's own file, in the section's own
  // words, and the picker is never mistaken for a finished move.
  {
    const panel = read("src/components/DeviceSyncPanel.svelte");
    checkOnly(
      "the section says the old file is not deleted",
      /The file in the old folder is never\s+deleted — it stays where you put it/.test(panel),
      "no sentence about the old file",
    );
    checkOnly(
      "and after a switch it says where that file is",
      /Moved to \{deviceSync\.providerLabel\}/.test(panel) && /never deletes it/.test(panel),
    );
    checkOnly(
      "the rows show the service being switched to, not a switched one",
      /deviceSync\.shown === id/.test(panel) && /\{#if deviceSync\.switching\}/.test(panel),
    );
    checkOnly("no modal", !panel.includes("alert("));
    checkOnly(
      "the panel hands the migration the folder picker's own settings",
      /deviceSync\.choose\(id, syncPrefs\(\)\)/.test(panel) && /deviceSync\.setFolder\(typed, syncPrefs\(\)\)/.test(panel),
    );
    // The engine's sentences name the two services, never a path.
    const error = new ProviderSwitchError("read", "from", SYNC_PROVIDERS.icloud.label, SYNC_PROVIDERS.gdrive.label, "no permission");
    checkOnly("the sentence names the step and both services", error.message.includes("reading the copy in iCloud Drive") && error.message.includes("Google Drive"));
    checkOnly("and never a path", !error.message.includes("/"), error.message);
  }
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`${passed} scenarios, ${checks - failures}/${checks} checks`);
if (failures) process.exit(1);
