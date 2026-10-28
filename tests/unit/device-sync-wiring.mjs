/**
 * The press in Settings carries the arrangement and the place.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/device-sync-wiring.mjs
 *
 * The engine merges `sidebar` and `place` (`tests/unit/authority.mjs`), and the
 * reader fills them in and adopts them back (`reader.svelte.ts`). Between those
 * two proved halves sat the half nobody proved: `DeviceSyncPanel`'s
 * `syncPrefs()`, which used to hand the engine the settings and nothing else, so
 * a local profile's arrangement and reading place were built, merged and written
 * by the tests and never by the app.
 *
 * So this suite drives the real thing, in the order the app does:
 *
 *   1. the **real `ReaderState`** — the compiled singleton, with a storage stub
 *      and no network — arranges the sidebar and leaves a place;
 *   2. the **panel's own `syncPrefs()`**, imported from the compiled component,
 *      is handed to `deviceSync.syncNow()`, which writes a document through a
 *      `MemorySyncProvider`;
 *   3. the written document is parsed back and checked group by group;
 *   4. another device's document is handed to the same `syncPrefs()`'s `adopt`,
 *      and the real reader is checked to have taken it — stored, not applied.
 *
 * What is stubbed, and why: the settings half (`state/prefs.svelte`) needs a
 * signed-in server, which this path does not, so it answers with a document of
 * its own. Everything else — the reader, the engine, the sync state, the
 * component — is the app's code.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, compileModule, preprocess } from "svelte/compiler";
import ts from "typescript";

import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { parseSyncSnapshot } from "../../src/api/local/sync.ts";
import { MemorySyncProvider } from "../../src/api/local/sync-provider.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { localProfile, scopeIdentity } from "../../src/api/profile.ts";
import { emptyPrefs, PREFS_NAMESPACES } from "../../src/lib/prefs-sync.ts";
import { GEN_DIR, ROOT, buildReaderModule } from "./build-reader.mjs";

// Under the suite's own scratch directory, which `.gitignore` already covers.
const GEN = join(GEN_DIR, "device-sync-wiring");

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

function deepEqual(actual, expected, what) {
  check(what, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

/* ---------------------------------------------------------------------------
 * Storage and network: a device with one and not the other
 * ------------------------------------------------------------------------ */

/** A stand-in for the window's storage, so the test owns what is on disk. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    dump: () => [...map.entries()],
  };
}

globalThis.localStorage = fakeStorage();
globalThis.fetch = () => {
  throw new Error("this suite is not allowed to reach the network");
};

/* ---------------------------------------------------------------------------
 * Building the app's modules the way the app's build does
 * ------------------------------------------------------------------------ */

const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function rewrite(code, fromFile) {
  return code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(fromFile, specifier);
    if (source === null) return whole;
    const target = built.get(source) ?? pathToFileURL(source).href;
    return `${before}${quote}${target}${quote}`;
  });
}

/** A runes module, type-stripped and compiled, pointed at real source files. */
function buildRunes(relative) {
  const file = join(ROOT, relative);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

const typescript = {
  script: ({ content, attributes }) => {
    if (attributes.lang !== "ts") return undefined;
    return {
      code: ts.transpileModule(content, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          // A component's imports are used in its *markup*, which TypeScript
          // cannot see: without this it elides them and the render dies.
          verbatimModuleSyntax: true,
        },
        fileName: "component.ts",
      }).outputText,
    };
  },
};

/** The component, compiled for the server target — enough to import and call. */
async function buildComponent(relative) {
  const file = join(ROOT, relative);
  const pre = await preprocess(read(relative), typescript, { filename: relative });
  const compiled = compile(pre.code, { generate: "server", filename: relative, dev: false });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.svelte$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

/**
 * The settings half, without a server.
 *
 * `PrefsSync` keeps the settings in step with a signed-in account; a local
 * profile has no account to talk to. The section only ever asks it for this
 * device's document and hands a merged one back, so that is what it answers —
 * with one readable entry, so the settings half is visibly still travelling.
 */
function stubPrefs() {
  const file = join(GEN, "prefs-stub.mjs");
  const document = emptyPrefs();
  document.entries.theme = { updatedAt: 1, value: { mode: "dark" } };
  writeFileSync(
    file,
    `export const prefs = {
  deviceDoc() { return ${JSON.stringify(document)}; },
  adoptFromDevice() {},
};
`,
  );
  built.set(join(ROOT, "src/state/prefs.svelte.ts"), pathToFileURL(file).href);
  return document;
}

mkdirSync(GEN, { recursive: true });

buildRunes("src/state/entitlements.svelte.ts");
buildRunes("src/state/device-sync.svelte.ts");

// The reader: the app's own module, compiled exactly as the other headless
// suites compile it. Written under this suite's directory rather than the shared
// `.gen`, so a sibling cannot overwrite it mid-run.
const readerFile = join(GEN, "reader.mjs");
writeFileSync(readerFile, buildReaderModule());
built.set(join(ROOT, "src/state/reader.svelte.ts"), pathToFileURL(readerFile).href);

const settingsHalf = stubPrefs();

const panelUrl = await buildComponent("src/components/DeviceSyncPanel.svelte");
const { syncPrefs } = await import(panelUrl);
const { reader } = await import(pathToFileURL(readerFile).href);
const { deviceSync } = await import(built.get(join(ROOT, "src/state/device-sync.svelte.ts")));

/* ---------------------------------------------------------------------------
 * A device: a library, an arrangement, and somewhere it was
 * ------------------------------------------------------------------------ */

const store = new LocalStore(new MemoryDatabase());
const profile = localProfile(new LocalBackend(store));
const identity = scopeIdentity(profile);
reader.profile = profile;

const FEED_A = "feed/art";
const FEED_B = "feed/comics";

/** Every feature the travelling half names, each with a value of its own. */
const ARRANGEMENT = {
  hidden: ["Comics", "News"],
  hiddenView: "only",
  pins: ["Comics"],
  pinFeeds: [FEED_B],
  pinView: "only",
  indentPx: 18,
  feedOrder: [FEED_B, FEED_A],
  categoryOrder: ["cat/2", "cat/1"],
};

reader.localHidden = { categories: [...ARRANGEMENT.hidden], view: ARRANGEMENT.hiddenView };
reader.localPins = {
  categories: [...ARRANGEMENT.pins],
  feeds: [...ARRANGEMENT.pinFeeds],
  view: ARRANGEMENT.pinView,
};
reader.localIndentPx = ARRANGEMENT.indentPx;
reader.feedOrder = [...ARRANGEMENT.feedOrder];
reader.categoryOrder = [...ARRANGEMENT.categoryOrder];

// The place, through the reader's own save path: the feed that is open, the post
// in it, and the line being read.
reader.activeStream = FEED_B;
reader.activeTitle = "Comics";
reader.selectedId = "item/7";
reader.expandedFeedId = null;
reader.rememberScroll("article", 240);
reader.rememberScroll("list", 60);
reader.savePlace();
const placeItLeft = reader.placeDoc();

/* ---------------------------------------------------------------------------
 * The shape the panel hands over
 * ------------------------------------------------------------------------ */

{
  const prefs = syncPrefs();
  deepEqual(
    Object.keys(prefs).sort(),
    ["adopt", "local", "place", "sidebar"],
    "one run carries the settings, the arrangement and the place",
  );
  check("the settings half is the store's own document", prefs.local.entries.theme?.value.mode === "dark");
  deepEqual(prefs.sidebar?.local, reader.sidebarDoc(), "the arrangement handed over is the reader's, not a copy of it");
  deepEqual(prefs.place?.local, placeItLeft, "and so is the place");
  check(
    "the arrangement is not a prefs namespace, so it cannot reach a FreshRSS prefs route",
    !PREFS_NAMESPACES.includes("sidebar") && !PREFS_NAMESPACES.includes("place"),
  );
}

/* ---------------------------------------------------------------------------
 * The app's press: syncPrefs() into syncNow(), written to the folder
 * ------------------------------------------------------------------------ */

const provider = new MemorySyncProvider();
deviceSync.bind(store, identity, { provider });
deviceSync.choose("dropbox");
deviceSync.setFolder("~/Dropbox/HardlyReader");

const run = await deviceSync.syncNow(syncPrefs());
check("the run happens: a library, a provider and a folder are all there", run !== null, String(deviceSync.note));
equal(provider.writes.length, 1, "one document was written to the folder");

const written = parseSyncSnapshot(provider.writes.at(-1));

{
  check("the document carries the arrangement", written.sidebar !== null);
  // The stamp is `at`, `rev` and `by` — the second, the revision and the device
  // — and it belongs to the record, not to the arrangement: what this compares
  // is what the reader arranged.
  const { at, rev, by, ...carried } = written.sidebar ?? {};
  deepEqual(carried, ARRANGEMENT, "every part of the sidebar arrived: hidden, pins, both views, indent, both orders");
  check("with a stamp of its own, separate from the place's", typeof at === "number", String(at));
  check("and a revision with a device on it", typeof rev === "number" && typeof by === "string", `${rev} ${by}`);

  const { at: placeAt, rev: placeRev, by: placeBy, ...where } = written.place ?? {};
  deepEqual(where, placeItLeft, "the reading place arrived: feed, title, post, unfolded feed and both offsets");
  check("and carries its own stamp", typeof placeAt === "number", String(placeAt));
  check("with its own revision", typeof placeRev === "number" && typeof placeBy === "string", `${placeRev} ${placeBy}`);

  equal(
    Object.keys(written.prefs.entries).every((name) => PREFS_NAMESPACES.includes(name)),
    true,
    "nothing but the settings namespaces travels in the settings group",
  );
  check("the settings half still travels beside them", written.prefs.entries.theme?.value.mode === "dark");
}

/* ---------------------------------------------------------------------------
 * The other device: its arrangement and its place, adopted through the panel
 * ------------------------------------------------------------------------ */

const ELSEWHERE = {
  hidden: ["Art"],
  hiddenView: "revealed",
  pins: [],
  pinFeeds: [],
  pinView: "all",
  indentPx: 4,
  feedOrder: [FEED_A],
  categoryOrder: ["cat/1"],
};

const ELSEWHERE_PLACE = {
  streamId: FEED_A,
  streamTitle: "Art",
  articleId: "item/9",
  expandedFeedId: FEED_A,
  articleScroll: 12,
  listScroll: 0,
};

{
  const prefs = syncPrefs();
  // The engine calls `adopt` with the value its merge kept, stamped.
  prefs.sidebar.adopt({ ...ELSEWHERE, at: 1 });
  prefs.place.adopt({ ...ELSEWHERE_PLACE, at: 1 });

  deepEqual(reader.localHidden, { categories: [...ELSEWHERE.hidden], view: ELSEWHERE.hiddenView }, "the adopted set is the reader's own hidden set");
  deepEqual(reader.localPins, { categories: [], feeds: [], view: ELSEWHERE.pinView }, "and its pins and pin filter");
  equal(reader.localIndentPx, ELSEWHERE.indentPx, "and the indent");
  deepEqual(
    { feedOrder: reader.feedOrder, categoryOrder: reader.categoryOrder },
    { feedOrder: [...ELSEWHERE.feedOrder], categoryOrder: [...ELSEWHERE.categoryOrder] },
    "and both orders",
  );

  deepEqual(reader.placeDoc(), ELSEWHERE_PLACE, "the place is stored under this device's own account key");
  equal(reader.activeStream, FEED_B, "the window did not move under the reader: a place is stored, not applied");
  equal(reader.activeTitle, "Comics", "and the feed it is showing is the one it was showing");
}

/* ---------------------------------------------------------------------------
 * The last line between the tested function and the button
 * ------------------------------------------------------------------------ */

{
  const source = read("src/components/DeviceSyncPanel.svelte");
  check("the Sync now button calls runSync", /onclick=\{runSync\}/.test(source));
  check(
    "...and runSync is the one line this suite drives",
    /void deviceSync\.syncNow\(syncPrefs\(\)\)/.test(source),
  );
  check(
    "the function it calls is the component's own, at module scope",
    /<script module lang="ts">[\s\S]*export function syncPrefs\(\): SyncPrefs/.test(source),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
