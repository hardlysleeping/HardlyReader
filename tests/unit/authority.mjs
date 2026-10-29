/**
 * One authority at a time.
 *
 * `docs/authority.md` states the rule every sync surface answers to:
 *
 *   FreshRSS profile → FreshRSS + its extensions are authoritative → free
 *   Local profile    → the local database is authoritative → optional paid provider
 *
 * Two writers for one flag is a conflict generator, and the conflict resolution
 * would be invisible: the server says hidden, the cloud says revealed, and
 * whichever device ran last is right on a screen nobody is looking at. This
 * suite is the rule made checkable, in four parts.
 *
 * 1. **A FreshRSS profile never touches a provider.** The gate is
 *    `localStoreOf` — a server profile answers `null` — and the run refuses
 *    before a provider is constructed. Asserted three ways: the gate's answer,
 *    the run driven through the real `DeviceSyncState` with a provider whose
 *    reads and writes are counted, and the source text that puts the
 *    construction after the guard.
 * 2. **A local profile's snapshot carries the whole feature set.** Two
 *    libraries, one provider: hidden categories, pins, both views, the indent,
 *    the feed and category orders and the reading place. Then the second
 *    device's sidebar is read back through the same rules the sidebar draws
 *    with, not merely compared as JSON.
 * 3. **Switching profile never migrates.** Connecting FreshRSS does not upload
 *    the local library; signing out of FreshRSS does not import its hidden set
 *    into the local one. Both directions, both asserted, plus the assignment
 *    sites that would be needed to cheat.
 * 4. **No entitlement on a reading path.** `cloudSync` gates the provider and
 *    nothing else: proved by walking the reading seam's real import graph, by an
 *    allowlist of the files allowed to name the capability, and by running a
 *    local sync and a read with a global `cloudSync` that throws if anything
 *    looks at it.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/authority.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import {
  emptySnapshot,
  parseSyncSnapshot,
  serializeSnapshot,
  syncOnce,
} from "../../src/api/local/sync.ts";
import { localProfile, localStoreOf, syncProfile } from "../../src/api/profile.ts";
import { emptyPrefs, preferencesBody, PREFS_NAMESPACES } from "../../src/lib/prefs-sync.ts";
import {
  emptyPlace,
  emptySidebar,
  parseSidebar,
} from "../../src/lib/sidebar-doc.ts";
import {
  hiddenStore,
  isLocallyHidden,
  resolveHidden,
  visibleGroups,
} from "../../src/state/hidden.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Under the suite's own scratch directory, which `.gitignore` already covers.
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}/authority`);

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

const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/* --------------------------------------------------------------------------
 * The two profiles, as the app builds them
 * ----------------------------------------------------------------------- */

/** A session-shaped object: `syncProfile` hashes the server and the address. */
const SESSION = {
  serverUrl: "https://rss.example.test",
  apiPath: "/api/greader.php",
  email: "ada@example.test",
  token: "not-a-real-token",
};

/** A backend a server profile would carry: anything that is not a local one. */
const SERVER_BACKEND = { kind: "greader" };

/** The profile a reader gets when they connect FreshRSS. */
function freshRssProfile() {
  return syncProfile(SESSION, SERVER_BACKEND);
}

/** The profile a reader gets with no account at all. */
async function localProfileWithLibrary() {
  const store = new LocalStore(new MemoryDatabase());
  const backend = new LocalBackend(store);
  return { profile: localProfile(backend), store };
}

/**
 * A provider that counts what was asked of it.
 *
 * The file *is* the provider in this harness (`sync-provider.ts`), so a write
 * counted here is a file written on a reader's disk, and a read counted here is
 * one opened. Counting is how "no provider was constructed" becomes observable
 * rather than a claim about the UI.
 */
class SpyProvider {
  id = "folder";
  label = "Spy";
  reads = 0;
  writes = [];
  contents = null;

  async read() {
    this.reads += 1;
    return this.contents;
  }

  async write(document) {
    this.writes.push(document);
    this.contents = document;
  }

  describe() {
    return "a provider that counts what was asked of it";
  }
}

/* --------------------------------------------------------------------------
 * A device: a library, its settings, its sidebar and where it was
 * ----------------------------------------------------------------------- */

/**
 * One local device.
 *
 * `sidebar` and `place` are what the reader has arranged and where they were —
 * the same two things `reader.svelte.ts` persists — so a sync has something real
 * to carry and the second device has something real to adopt.
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
    sidebar: null,
    place: null,
    adopted: { prefs: [], sidebar: 0, place: 0 },
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
            this.adopted.prefs.push(...namespaces);
          },
          sidebar: {
            local: this.sidebar,
            adopt: (doc) => {
              // The stamp is the document's, not the reader's: what this device
              // draws is the arrangement itself.
              const { at, ...arrangement } = doc;
              this.sidebar = arrangement;
              this.adopted.sidebar += 1;
            },
          },
          place: {
            local: this.place,
            adopt: (doc) => {
              const { at, ...where } = doc;
              this.place = where;
              this.adopted.place += 1;
            },
          },
        },
      });
      this.base = run.snapshot;
      return run;
    },
  };
}

/** A full arrangement: every feature the card names, with a value of its own. */
function arrangedSidebar() {
  return {
    hidden: ["Comics", "News"],
    hiddenView: "only",
    pins: ["Comics"],
    pinFeeds: [`feed/${FEED_A}`],
    pinView: "only",
    indentPx: 18,
    feedOrder: [`feed/${FEED_B}`, `feed/${FEED_A}`],
    categoryOrder: ["cat/2", "cat/1"],
  };
}

function somewhere() {
  return {
    streamId: `feed/${FEED_B}`,
    streamTitle: "Comics",
    articleId: "post-9",
    expandedFeedId: null,
    articleScroll: 240,
    listScroll: 40,
  };
}

/* --------------------------------------------------------------------------
 * 1. A FreshRSS profile never constructs a provider, and writes no file
 * ----------------------------------------------------------------------- */

await check("the gate answers null for a server profile and a store for a local one", async () => {
  const { profile, store } = await localProfileWithLibrary();

  equal(localStoreOf(freshRssProfile()), null, "a FreshRSS profile's store");
  equal(localStoreOf(null), null, "no profile at all");
  equal(localStoreOf(profile), store, "a local profile's store is the open library");
  equal(profile.kind, "local", "and the profile says which authority it is");
  equal(freshRssProfile().kind, "greader", "while a server profile says the other");
});

/**
 * The run, through the app's own gate.
 *
 * `state/device-sync.svelte.ts` is compiled the way this repo compiles its runes
 * modules (type-stripped, then `compileModule`, with every relative specifier
 * rewritten to the real file). Nothing is stubbed: the gate, the engine and the
 * provider are the app's own code.
 */
const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function buildRunes(relativePath) {
  const file = join(ROOT, relativePath);
  const { outputText } = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relativePath });
  const rewritten = compiled.js.code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(file, specifier);
    if (source === null) return whole;
    return `${before}${quote}${built.get(source) ?? pathToFileURL(source).href}${quote}`;
  });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relativePath.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewritten);
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

/** A storage a device has, so the panel's record behaves as it does in the app. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const LOCAL_IDENTITY = { serverUrl: "device://local", email: "local" };

buildRunes("src/lib/sync-setup.ts");
buildRunes("src/state/device-sync.svelte.ts");
const { DeviceSyncState } = await import(built.get(join(ROOT, "src/state/device-sync.svelte.ts")));

await check("a server profile cannot run a sync, even with a provider and a folder chosen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "hardlyread-authority-"));
  try {
    globalThis.localStorage = fakeStorage();
    const spy = new SpyProvider();
    const state = new DeviceSyncState();
    // Exactly what a panel does with a signed-in profile: `localStoreOf` answers
    // null, so there is no library to merge and nothing sensible to bind.
    state.bind(localStoreOf(freshRssProfile()), LOCAL_IDENTITY, { provider: spy });
    state.choose("icloud");
    state.setFolder(folder);

    const run = await state.syncNow({ local: emptyPrefs(), adopt: () => {} });

    equal(run, null, "the run");
    equal(state.note, "There is no library on this device to sync", "the one line it says");
    equal(spy.reads, 0, "the provider was never asked for a document");
    equal(spy.writes.length, 0, "and never written to");
    deepEqual(readdirSync(folder), [], "so the chosen folder holds no file");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    delete globalThis.localStorage;
  }
});

await check("the provider is constructed after the guard, in the only place src builds one", async () => {
  // The construction site, and the guard it sits behind. This is a source-text
  // check because the claim is about the order of two statements in the code
  // path — a runtime check can only prove the branch that ran was refused.
  const deviceSync = read("src/state/device-sync.svelte.ts");
  const guard = deviceSync.indexOf("if (store === null)");
  const construction = deviceSync.indexOf("syncProviderAt(");
  truthy(guard > 0, "the no-library guard exists");
  truthy(construction > 0, "the provider is built somewhere in this file");
  truthy(guard < construction, "and the guard comes first");

  // Nothing else in `src` constructs one: a second construction site would be a
  // second way to reach a provider from a profile that must not have one.
  const builders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry.name)) continue;
      const source = readFileSync(join(ROOT, path), "utf8");
      if (/syncProviderAt\(|new FolderSyncProvider\(/.test(source)) builders.push(path);
    }
  };
  walk("src");
  deepEqual(
    builders.sort(),
    ["src/api/local/sync-provider.ts", "src/state/device-sync.svelte.ts"],
    "the files that can construct a provider",
  );
});

/* --------------------------------------------------------------------------
 * 2. A local snapshot carries the whole feature set
 * ----------------------------------------------------------------------- */

await check("the snapshot carries hidden, pins, both views, indent and both orders", async () => {
  const provider = new SpyProvider();
  const laptop = device("laptop");
  const phone = device("phone");

  await laptop.store.subscribe(FEED_A, { title: "Comics", folder: "Funny books" });
  await laptop.store.subscribe(FEED_B, { title: "News" });
  laptop.sidebar = arrangedSidebar();
  laptop.place = somewhere();

  const first = await laptop.sync(provider, T + 100);
  deepEqual(first.snapshot.sidebar.hidden, ["Comics", "News"], "hidden in the document");
  equal(first.snapshot.sidebar.hiddenView, "only", "the hidden view");
  deepEqual(first.snapshot.sidebar.pins, ["Comics"], "pins");
  deepEqual(first.snapshot.sidebar.pinFeeds, [`feed/${FEED_A}`], "feed pins");
  equal(first.snapshot.sidebar.pinView, "only", "the pin view");
  equal(first.snapshot.sidebar.indentPx, 18, "the indent");
  deepEqual(first.snapshot.sidebar.feedOrder, [`feed/${FEED_B}`, `feed/${FEED_A}`], "the feed order");
  deepEqual(first.snapshot.sidebar.categoryOrder, ["cat/2", "cat/1"], "the category order");
  deepEqual(first.snapshot.place.streamId, `feed/${FEED_B}`, "where the laptop was");

  await phone.sync(provider, T + 101);

  deepEqual(phone.sidebar, arrangedSidebar(), "the phone's arrangement, entirely");
  deepEqual(phone.place, somewhere(), "and where the laptop was reading");
  equal(phone.adopted.sidebar, 1, "the phone was told it adopted the arrangement");
  equal(phone.adopted.place, 1, "and the place");
});

await check("the second device's sidebar is read back through the sidebar's own rules", async () => {
  const provider = new SpyProvider();
  const laptop = device("laptop");
  const phone = device("phone");

  await laptop.store.subscribe(FEED_A, { title: "Comics" });
  await laptop.store.subscribe(FEED_B, { title: "News" });
  laptop.sidebar = arrangedSidebar();
  await laptop.sync(provider, T + 100);
  await phone.sync(provider, T + 101);

  // Exactly what the reader does with a local profile: the server has no
  // extension to ask, so this device's set is the authority.
  const noExtension = {
    available: false,
    mode: "",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [],
    locked: false,
    hasPasscode: false,
    categories: [],
  };
  const block = resolveHidden(noExtension, { categories: phone.sidebar.hidden, view: phone.sidebar.hiddenView }, "local");
  equal(hiddenStore("local"), "local", "the authority behind the phone's sidebar");
  equal(block.view, "only", "the view the reader left it in");
  deepEqual(
    visibleGroups([{ label: "Comics" }, { label: "News" }, { label: "Art" }], block).map((group) => group.label),
    ["Comics", "News"],
    "the rows the phone draws",
  );
  equal(isLocallyHidden({ categories: phone.sidebar.hidden, view: phone.sidebar.hiddenView }, "Art"), false, "a category the laptop never hid");
  equal(phone.sidebar.indentPx, 18, "the indent the phone draws the sidebar with");
  deepEqual(phone.sidebar.feedOrder, [`feed/${FEED_B}`, `feed/${FEED_A}`], "the order the phone draws");
});

await check("the arrangement survives the file a second sync actually reads", async () => {
  const provider = new SpyProvider();
  const laptop = device("laptop");
  laptop.sidebar = arrangedSidebar();
  laptop.place = somewhere();
  await laptop.sync(provider, T + 100);

  const onDisk = parseSyncSnapshot(provider.contents);
  deepEqual(parseSidebar(onDisk.sidebar), arrangedSidebar(), "the arrangement as parsed from the file");
  equal(onDisk.sidebar.at, T + 100, "stamped with the second it changed");
  equal(onDisk.place.streamId, `feed/${FEED_B}`, "the place, from the file");
});

await check("a device that changed nothing does not claim the arrangement moved", async () => {
  const provider = new SpyProvider();
  const laptop = device("laptop");
  const phone = device("phone");

  laptop.sidebar = arrangedSidebar();
  await laptop.sync(provider, T + 100);
  await phone.sync(provider, T + 101);

  const writes = provider.writes.length;
  const quiet = await phone.sync(provider, T + 200);

  equal(quiet.unchanged, true, "a phone that adopted and changed nothing");
  equal(provider.writes.length, writes, "wrote nothing back");
  equal(quiet.snapshot.sidebar.at, T + 100, "and left the arrangement's stamp alone");
  equal(phone.adopted.sidebar, 1, "without adopting a second time");
});

await check("the arrangement never enters the settings document a server holds", async () => {
  // The other direction of the same rule: the sidebar document is the local
  // authority's, and the FreshRSS prefs route must not learn it — the extension
  // would then be a second writer of a flag it already owns.
  const namespaces = [...PREFS_NAMESPACES];
  equal(namespaces.includes("sidebar"), false, "sidebar is not a prefs namespace");
  const body = JSON.stringify(preferencesBody(emptyPrefs()));
  equal(/hidden|pins|indent|categoryOrder|feedOrder/.test(body), false, "and none of its fields reach the wire");
});

await check("the arrangement travels in the document's own shape, and nothing lock-shaped", async () => {
  // The operator's rule in one assertion: the shape is extended, never
  // paralleled. The full field list is pinned in `local-sync.mjs`; this checks
  // the half that belongs to this card — the arrangement and the place are
  // groups of the same document — and that no lock or passcode rides along.
  const snapshot = emptySnapshot("laptop", T);
  for (const field of ["sidebar", "place", "prefs", "feeds", "folders", "marks"]) {
    equal(field in snapshot, true, `the document has a ${field} group`);
  }
  const travelling = { sidebar: { ...arrangedSidebar(), at: T }, place: { ...somewhere(), at: T } };
  const keys = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        keys.push(key);
        collect(entry);
      }
    }
  };
  collect(travelling);
  const lockish = keys.filter((key) => /lock|passcode|passphrase|secret|keypad|code/i.test(key));
  deepEqual(lockish, [], "a lock-shaped field in the travelling half");
});

/* --------------------------------------------------------------------------
 * 3. Switching profile never migrates
 * ----------------------------------------------------------------------- */

await check("connecting FreshRSS does not upload the local library", async () => {
  const folder = mkdtempSync(join(tmpdir(), "hardlyread-authority-"));
  try {
    globalThis.localStorage = fakeStorage();
    const { profile, store } = await localProfileWithLibrary();
    await store.subscribe(FEED_A, { title: "Comics", folder: "Funny books" });
    const feedsBefore = (await store.feeds()).map((feed) => feed.key);

    // The local profile had a provider and an agreement of its own.
    const spy = new SpyProvider();
    const localState = new DeviceSyncState();
    localState.bind(localStoreOf(profile), LOCAL_IDENTITY, { provider: spy });
    localState.choose("folder");
    localState.setFolder(folder);
    const ran = await localState.syncNow({ local: emptyPrefs(), adopt: () => {} });
    truthy(ran !== null, "the local profile synced");
    const document = spy.contents;
    equal(spy.writes.length, 1, "one document, from the local profile");

    // Now the reader connects FreshRSS. A new profile, the same window, the same
    // provider available — and nothing happens to it.
    const fresh = new DeviceSyncState();
    fresh.bind(localStoreOf(freshRssProfile()), { serverUrl: SESSION.serverUrl, email: SESSION.email }, { provider: spy });
    fresh.choose("folder");
    fresh.setFolder(folder);
    const attempted = await fresh.syncNow({ local: emptyPrefs(), adopt: () => {} });

    equal(attempted, null, "the server profile did not sync");
    equal(spy.writes.length, 1, "the provider holds exactly the one document");
    equal(spy.contents, document, "byte for byte what the local profile wrote");
    deepEqual((await store.feeds()).map((feed) => feed.key), feedsBefore, "and the library is untouched");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    delete globalThis.localStorage;
  }
});

await check("signing out does not import the server's hidden set into the local one", async () => {
  const server = {
    available: true,
    mode: "extension",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [4],
    locked: false,
    hasPasscode: false,
    categories: [{ id: 4, name: "CelebMafia", hidden: true }],
  };
  const device = { categories: [], view: "hidden" };
  const before = JSON.parse(JSON.stringify(device));

  // Signed in: the extension answers, so the device's own set is not read, not
  // merged and not written.
  const signedIn = resolveHidden(server, device, "backend");
  equal(hiddenStore("backend"), "extension", "the extension is the authority while it answers");
  deepEqual(signedIn.categories.map((category) => category.name), ["CelebMafia"], "the block the server sent");
  deepEqual(device, before, "and the device's own set was not touched");

  // Signed out: nothing answers, so this device decides. The server's set was
  // never copied, so nothing it hid is hidden here.
  const signedOut = {
    available: false,
    mode: "",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [],
    locked: false,
    hasPasscode: false,
    categories: [],
  };
  const local = resolveHidden(signedOut, device, "local");
  equal(hiddenStore("local"), "local", "the device is the authority once the server is gone");
  deepEqual(local.categories, [], "no category arrived from the server");
  equal(isLocallyHidden(device, "CelebMafia"), false, "and the server's label is not hidden here");
  deepEqual(device, before, "the local set is still what the reader left");
});

await check("nothing in the app writes the local hidden set from a server's", async () => {
  // The assignment sites are the only way a migration could happen, so they are
  // the thing to enumerate. Each one is the reader deciding, a stored blob being
  // read, or this device adopting a *local* document.
  const source = read("src/state/reader.svelte.ts");
  const lines = source.split("\n").filter((line) => line.includes("this.localHidden ="));
  truthy(lines.length > 0, "the local set is assigned somewhere");
  const allowed = [
    "this.localHidden = emptyHidden()",
    "this.localHidden = parseHidden(raw?.hidden)",
    "this.localHidden = parseHidden({ categories: doc.hidden, view: doc.hiddenView })",
    "this.localHidden = { ...this.localHidden, ...change }",
    // A split pane starts from the reader beside it — the *same* account's set,
    // not a server's: `seedFrom` copies the account the pane is reading as, and
    // nothing else. The check below still refuses a copy out of `hiddenCategories`.
    "this.localHidden = other.localHidden",
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    truthy(
      allowed.some((shape) => trimmed.startsWith(shape)),
      `an unexpected writer of the local hidden set: ${trimmed}`,
    );
  }
  // And nothing reads the extension's block into it.
  equal(/localHidden\s*=\s*[^;\n]*(hiddenCategories|server|categories: *this\.hidden)/.test(source), false, "no assignment from the server's block");
});

/* --------------------------------------------------------------------------
 * 4. No entitlement on a reading path
 * ----------------------------------------------------------------------- */

const BILLING = /cloudSync|entitlement|purchase|productId|hardlyreader\.sync\.(monthly|yearly)/i;

await check("the reading seam's import graph names no entitlement", async () => {
  const roots = [
    "src/api/local/local-backend.ts",
    "src/api/local/store.ts",
    "src/api/local/sync.ts",
    "src/api/greader-backend.ts",
    "src/api/backend.ts",
    "src/state/hidden.ts",
  ];
  const seen = new Set();
  const offenders = [];
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(join(ROOT, path), "utf8");
    if (BILLING.test(source)) offenders.push(path);
    const file = join(ROOT, path);
    for (const [, specifier] of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const source = sourceOf(file, specifier);
      if (source === null) continue;
      visit(relative(ROOT, source));
    }
  };
  roots.forEach(visit);

  deepEqual(offenders, [], "files on the reading path that mention billing");
  truthy(seen.size > 20, `the graph was actually walked (${seen.size} files)`);
  for (const path of seen) {
    equal(path.startsWith("src/state/entitlements"), false, "the entitlement module is not in the graph");
  }
});

await check("cloudSync is named only by the module that owns it, the sheet that sells it, and the shell", async () => {
  // `App.svelte` is the join, and the only one: the reader holds the ladder and is
  // told the answer as one boolean (`reader.paid`), so the entitlement's own name
  // stays out of every module that reads or writes an article.
  const allowed = new Set([
    "src/state/entitlements.svelte.ts",
    "src/components/DeviceSyncPanel.svelte",
    "src/App.svelte",
  ]);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry.name)) continue;
      if (/cloudSync/.test(readFileSync(join(ROOT, path), "utf8"))) found.push(path);
    }
  };
  walk("src");
  for (const path of found) {
    truthy(allowed.has(path), `a file outside the entitlement and its sheet reads cloudSync: ${path}`);
  }
  // Nothing on the reading side even says the word, whatever it is spelled as.
  for (const path of ["src/api/local/local-backend.ts", "src/state/reader.svelte.ts", "src/api/greader-backend.ts"]) {
    equal(BILLING.test(read(path)), false, `${path} mentions billing`);
  }
});

await check("a local sync and a read run with a cloudSync that throws if it is looked at", async () => {
  let consulted = 0;
  Object.defineProperty(globalThis, "cloudSync", {
    configurable: true,
    get() {
      consulted += 1;
      throw new Error("something on the reading path consulted cloudSync");
    },
  });
  try {
    const provider = new SpyProvider();
    const laptop = device("laptop");
    const phone = device("phone");

    await laptop.store.subscribe(FEED_A, { title: "Comics" });
    await laptop.store.putEntries([{ feedUrl: FEED_A, guid: "p1", title: "A post" }]);
    const post = localItemId(FEED_A, "p1");
    await laptop.store.setRead([post], true);
    laptop.sidebar = arrangedSidebar();

    const run = await laptop.sync(provider, T + 100);
    equal(run.applied.feedsAdded.length, 0, "the feed was already here");
    await phone.sync(provider, T + 101);
    deepEqual(phone.sidebar.hidden, ["Comics", "News"], "the phone's sidebar arrived");

    await phone.store.putEntries([{ feedUrl: FEED_A, guid: "p1", title: "A post" }]);
    await phone.sync(provider, T + 150);
    equal((await phone.store.entry(localItemId(FEED_A, "p1"))).read, 1, "and so did the read mark");

    equal(consulted, 0, "nothing on that path looked at cloudSync");
  } finally {
    delete globalThis.cloudSync;
  }
});

await check("the engine does not know what a licence is, one document at a time", async () => {
  // The same claim from the other end: `sync.ts` merges two documents and takes
  // three injected halves. If it ever needed to know whether sync was paid for,
  // the parameter would have to appear here.
  const source = read("src/api/local/sync.ts");
  equal(BILLING.test(source), false, "sync.ts mentions billing");
  equal(/licen[cs]e/i.test(source), false, "sync.ts mentions a licence");
});

console.log(`\n${passed} checks passed`);
