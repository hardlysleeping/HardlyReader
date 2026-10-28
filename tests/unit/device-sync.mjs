/**
 * Device sync in Settings: the record, the gate, and the run.
 *
 * The section draws two halves and the entitlement decides which one, but three
 * things behind it are worth pinning because they are what the card promises:
 *
 *   1. **A run is unreachable without a provider.** `syncNow()` refuses before it
 *      builds a document, so a device that has not chosen a service writes
 *      nothing anywhere — asserted by a provider whose writes are counted.
 *   2. **A FreshRSS profile never touches a provider.** Handed the same run with
 *      no library on this device, nothing is read and nothing is written: the
 *      server is that profile's authority (`docs/authority.md`).
 *   3. **A failed run leaves local data and the agreement alone.** The record is
 *      written only after the engine answers, so the feeds, the last agreement and
 *      the last-run time are what they were.
 *
 * The record itself is plain rules (`lib/sync-setup`), so it is checked without a
 * store at all — per provider, per profile, and never in the synced settings
 * document.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/device-sync.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import { emptySnapshot } from "../../src/api/local/sync.ts";
import { emptyPrefs } from "../../src/lib/prefs-sync.ts";
import {
  SYNC_SETUP_KEY,
  describeLastSynced,
  emptySetup,
  folderFor,
  parseSetup,
  readSetup,
  serializeSetup,
  withFolder,
  withProvider,
  withRun,
  writeSetup,
} from "../../src/lib/sync-setup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, "tests/unit/.gen-device-sync");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function equal(actual, expected, what) {
  check(what, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

/* ---------------------------------------------------------------------------
 * A storage a device would have, so the record can be checked per profile.
 * ------------------------------------------------------------------------- */

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

const LOCAL = { serverUrl: "device://local", email: "local" };
const OTHER = { serverUrl: "https://rss.example.test", email: "ada@example.test" };

/* ---------------------------------------------------------------------------
 * 1. The record: per provider, per profile, and never in the settings document.
 * ------------------------------------------------------------------------- */
{
  const empty = parseSetup(null);
  equal(empty.provider, null, "a device with no record has no provider");
  equal(empty.lastSyncedAt, 0, "and has never synced");
  equal(parseSetup("{ not json").provider, null, "a corrupt record is a device that has not synced");
  equal(parseSetup(JSON.stringify({ provider: "carrier-pigeon" })).provider, null, "an unknown provider is dropped");

  let setup = withProvider(emptySetup(), "icloud");
  equal(setup.provider, "icloud", "choosing a provider remembers it");
  setup = withFolder(setup, "icloud", "~/Library/Mobile Documents/com~apple~CloudDocs/HardlyReader");
  equal(folderFor(setup, "icloud"), "~/Library/Mobile Documents/com~apple~CloudDocs/HardlyReader", "its folder is remembered");
  equal(folderFor(setup, "dropbox"), "", "and no other service has one yet");

  // A second service has its own folder, and the first one is not lost.
  setup = withProvider(setup, "dropbox");
  setup = withFolder(setup, "dropbox", "~/Dropbox/HardlyReader");
  equal(folderFor(setup, "dropbox"), "~/Dropbox/HardlyReader", "Dropbox gets its own folder");
  check("iCloud keeps the folder it already had", folderFor(setup, "icloud").includes("CloudDocs"));

  // Switching back is not a new document: the folder is there, the agreement is not.
  const back = withProvider(setup, "icloud");
  equal(folderFor(back, "icloud"), folderFor(setup, "icloud"), "switching back finds its folder");
  equal(back.base, null, "and starts from a fresh agreement");
  equal(back.lastSyncedAt, 0, "with no last-run time borrowed from another folder");

  const one = { provider: "icloud", folders: { icloud: "~/i" }, lastSyncedAt: 1, base: null };
  const moved = withFolder(one, "icloud", "~/elsewhere");
  equal(moved.base, null, "a different folder drops the agreement");
  equal(moved.lastSyncedAt, 0, "and the last-run time");

  // The last agreement survives a round-trip through storage.
  const ran = withRun(one, emptySnapshot("laptop", 10), 1_700_000_000_000);
  const reparsed = parseSetup(serializeSetup(ran));
  check("the agreement is read back", reparsed.base !== null && reparsed.base.writtenAt === 10);
  equal(reparsed.lastSyncedAt, 1_700_000_000_000, "and the last-run time");

  // How long ago, in the row's words.
  const at = 1_700_000_000_000;
  equal(describeLastSynced(0, at), "Never", "nothing yet reads Never");
  equal(describeLastSynced(at - 30_000, at), "Just now", "half a minute is Just now");
  equal(describeLastSynced(at - 60_000, at), "1 minute ago", "one minute is singular");
  equal(describeLastSynced(at - 120_000, at), "2 minutes ago", "two minutes is plural");
  equal(describeLastSynced(at - 3 * 3600_000, at), "3 hours ago", "hours");
  equal(describeLastSynced(at - 26 * 3600_000, at), "1 day ago", "a day is singular");
  equal(describeLastSynced(at - 3 * 24 * 3600_000, at), "3 days ago", "days");
}

/* ---------------------------------------------------------------------------
 * 2. The key: a device key per profile, not the synced settings document.
 * ------------------------------------------------------------------------- */
{
  const storage = fakeStorage();
  const setup = withFolder(withProvider(emptySetup(), "gdrive"), "gdrive", "~/Drive/HardlyReader");
  writeSetup(storage, LOCAL, setup);
  writeSetup(storage, OTHER, withFolder(withProvider(emptySetup(), "onedrive"), "onedrive", "~/"));

  const keys = storage.keys();
  check("the record is written under its own base key", keys.every((key) => key.startsWith(SYNC_SETUP_KEY)), keys.join(", "));
  equal(keys.length, 2, "one record per profile");
  check(
    "neither key names the server or the address",
    keys.every((key) => !key.includes("example.test") && !key.includes("ada")),
    keys.join(", "),
  );
  check("and none of them is the synced preferences document", keys.every((key) => !key.includes("hardlyreader.prefs")));

  equal(folderFor(readSetup(storage, LOCAL), "gdrive"), "~/Drive/HardlyReader", "a profile reads its own folder");
  equal(folderFor(readSetup(storage, OTHER), "gdrive"), "", "and not another profile's");
}

/* ---------------------------------------------------------------------------
 * 3. The store: the gate, the run, and what a failure leaves behind.
 *
 * The runes module is compiled the way `mobile-nav.mjs` compiles the layout —
 * type-stripped, then `compileModule` — and every relative specifier is rewritten
 * to the real file, because a generated module does not sit beside its source.
 * Nothing is stubbed: the store, the engine and the provider are the app's own.
 * ------------------------------------------------------------------------- */
const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

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
    return `${before}${quote}${(built.get(source) ?? pathToFileURL(source).href)}${quote}`;
  });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewritten);
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

try {
  buildRunes("src/lib/sync-setup.ts");
  buildRunes("src/state/device-sync.svelte.ts");

  const { deviceSync, showsDeviceSync, DeviceSyncState } = await import(
    built.get(join(ROOT, "src/state/device-sync.svelte.ts"))
  );

  /** A fresh state, so one check cannot leak into the next. */
  function freshState() {
    return new DeviceSyncState();
  }

  /** A library with one feed in it, which is what a reader who syncs has. */
  async function library() {
    const store = new LocalStore(new MemoryDatabase());
    await store.subscribe("https://a.test/rss", { title: "A" });
    return store;
  }

  const prefs = () => ({ local: emptyPrefs(), adopt: () => {} });
  // The gate: a section that has not been given a provider cannot sync anything,
  // and the provider it would have used is never written to.
  {
    globalThis.localStorage = fakeStorage();
    const state = freshState();
    const store = await library();
    const provider = new MemorySyncProvider();
    state.bind(store, LOCAL, { provider });

    equal(state.provider, null, "a device that has chosen nothing has no provider");
    equal(state.hasFolder, false, "and no folder");

    const run = await state.syncNow(prefs());
    equal(run, null, "a sync with no provider answers nothing");
    check("and says why in one line", (state.note ?? "").includes("provider"), String(state.note));
    equal(provider.writes.length, 0, "nothing was written to any provider");
    equal(state.setup.lastSyncedAt, 0, "and the device did not claim a run");

    state.choose("icloud");
    const withoutFolder = await state.syncNow(prefs());
    equal(withoutFolder, null, "a provider with no folder answers nothing");
    check("and names the folder it needs", (state.note ?? "").includes("folder"), String(state.note));
    equal(provider.writes.length, 0, "still nothing written");

    // Choosing a provider is remembered, and so is its folder.
    state.setFolder("~/icloud/HardlyReader");
    equal(state.folder, "~/icloud/HardlyReader", "the folder is the one chosen");
    equal(state.hasFolder, true, "which is what makes a run possible");
    equal(state.filePath, "~/icloud/HardlyReader/hardlyreader-sync.json", "the row can say where the file is");

    const storage = globalThis.localStorage;
    const saved = readSetup(storage, LOCAL);
    equal(saved.provider, "icloud", "the choice is a device key");
    equal(folderFor(saved, "icloud"), "~/icloud/HardlyReader", "and so is the folder");
  }

  // The run itself: the document is written, the agreement is kept, and the row
  // has a time to say.
  {
    globalThis.localStorage = fakeStorage();
    const state = freshState();
    const store = await library();
    const provider = new MemorySyncProvider();
    state.bind(store, LOCAL, { provider });
    state.choose("dropbox");
    state.setFolder("~/Dropbox/HardlyReader");

    const run = await state.syncNow(prefs());
    check("a run with a provider and a folder answers the run", run !== null);
    equal(provider.writes.length, 1, "and the document was written once");
    equal(state.note, null, "a run that worked says nothing extra");
    check("the last-run time is set", state.setup.lastSyncedAt > 0);
    equal(state.lastSyncedAt(state.setup.lastSyncedAt + 120_000), "2 minutes ago", "and reads as 2 minutes ago");
    check("the agreement is this run's document", state.setup.base !== null && state.setup.base.device !== "");
    equal(readSetup(globalThis.localStorage, LOCAL).lastSyncedAt, state.setup.lastSyncedAt, "the record remembers the run");

    // A second run against the same provider is quiet: the document did not change.
    const again = await state.syncNow(prefs());
    check("a second run still answers", again !== null);
    equal(provider.writes.length, 1, "and does not rewrite a document nothing changed in");
  }

  // A failure is one line, and it leaves the library and the agreement alone.
  {
    globalThis.localStorage = fakeStorage();
    const state = freshState();
    const store = await library();
    const provider = new MemorySyncProvider();
    state.bind(store, LOCAL, { provider });
    state.choose("onedrive");
    state.setFolder("~/OneDrive/HardlyReader");

    const first = await state.syncNow(prefs());
    check("the first run worked", first !== null);
    const agreedAt = state.setup.lastSyncedAt;
    const agreement = state.setup.base;
    const feedsBefore = (await store.feeds()).length;

    provider.readError = new Error("The folder could not be read");
    const failed = await state.syncNow(prefs());
    equal(failed, null, "a failing run answers nothing");
    equal(state.note, "The folder could not be read", "and says why in one line");
    equal(state.setup.lastSyncedAt, agreedAt, "the last-run time is the last run that finished");
    equal(state.setup.base, agreement, "and the agreement is untouched");
    equal((await store.feeds()).length, feedsBefore, "the library is untouched");
    equal(provider.writes.length, 1, "and nothing was written over the document");
    check("the one line is never a modal", !read("src/components/DeviceSyncPanel.svelte").includes("alert("));
  }

  // A FreshRSS profile: no library here, so no provider is ever used —
  // `docs/authority.md`, check 1. The server is that profile's authority.
  {
    globalThis.localStorage = fakeStorage();
    const state = freshState();
    const provider = new MemorySyncProvider();
    state.bind(null, OTHER, { provider });

    const run = await state.syncNow(prefs());
    equal(run, null, "a profile with no library here does not sync");
    check("and says so", (state.note ?? "").includes("library"), String(state.note));
    equal(provider.writes.length, 0, "the provider is never written to");
    equal(provider.peek(), null, "and holds nothing");
  }

  // The section's gate: drawn for a library on this device that has feeds, and
  // nowhere else. First launch has no feeds, so it is never sold anything.
  {
    const local = { kind: "local" };
    const greader = { kind: "greader" };
    equal(showsDeviceSync(local, 1), true, "a local library with a feed draws the section");
    equal(showsDeviceSync(local, 0), false, "an empty library does not — no paywall on first launch");
    equal(showsDeviceSync(greader, 12), false, "a FreshRSS profile does not: its sync is FreshRSS's");
    equal(showsDeviceSync(null, 12), false, "and neither does a window with no profile yet");
  }

  // The section is drawn in the sheet, and the interval row is not called Sync.
  {
    const panel = read("src/components/SettingsPanel.svelte");
    check("the sheet mounts the device sync section", /import DeviceSyncPanel from "\.\/DeviceSyncPanel\.svelte"/.test(panel));
    check("the interval row reads Refreshing", /label: "Refreshing"/.test(panel) && !/label: "Sync"/.test(panel));
    check("and the device section is gated by the profile and its feeds", /showsDeviceSync\(reader\.profile, reader\.categories\.length\)/.test(panel));
  }
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
