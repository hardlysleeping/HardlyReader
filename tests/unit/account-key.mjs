/**
 * Per-account device keys.
 *
 * The app keeps its device-local state in `localStorage`, and until now that state
 * was global: one layout, one set of reading preferences, one chrome, one pin blob.
 * That was fine while a device held one session, and it is exactly what makes a
 * second login inherit the first one's panes, pins and indent. These checks pin the
 * rules that fix it:
 *
 * - the slug is stable, and different accounts get different slugs;
 * - no key contains an address (a key is not a place for one);
 * - two accounts driven through the real readers and writers never see each
 *   other's values;
 * - a pre-scoping key is adopted by the first account and left in place.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-key.mjs
 *
 * `reading.svelte.ts` is a runes module, so it is compiled the way the other
 * suites compile it: type-stripped, compiled with Svelte's `compileModule`, and
 * imported from a throwaway directory inside the project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  accountSlug,
  readAccountValue,
  scopedKey,
  storedAccount,
  writeAccountValue,
} from "../../src/lib/account-key.ts";
import { SESSION_KEY } from "../../src/api/session.ts";
import {
  CHROME_KEY,
  readBandCollapsed,
  readPinPad,
  writeBandCollapsed,
  writePinPad,
} from "../../src/lib/chrome-prefs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Two logins on one device. Synthetic hosts, no token and no password anywhere. */
const ONE = { serverUrl: "https://one.example", email: "one@one.example" };
const TWO = { serverUrl: "https://two.example", email: "two@two.example" };

/** One blob holds pins, the local fold set and the indent cache. */
const PREFS_BASE = "hardlyreader.prefs.v1";

/** A plain-Map `localStorage`, so a relaunch is a new object over the same map. */
function memoryStore(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/** `src/state/layout.svelte.ts` as plain ESM, as the other layout suites build it. */
function buildLayoutModule() {
  const source = readFileSync(join(ROOT, "src/state/layout.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "layout.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "layout.svelte.ts" });
  const code = compiled.js.code.replace(/from\s+"(\.[^"]*)"/g, (whole, specifier) => {
    const target = join(ROOT, "src/state", `${specifier}.ts`);
    if (!existsSync(target)) throw new Error(`unresolved import ${specifier} from layout.svelte.ts`);
    return `from ${JSON.stringify(pathToFileURL(target).href)}`;
  });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "account-layout.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

/** `src/state/reading.svelte.ts` as plain ESM, the way the app's build makes it. */
function buildReadingModule() {
  const source = readFileSync(join(ROOT, "src/state/reading.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "reading.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "reading.svelte.ts" });
  const code = compiled.js.code
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"../lib/extract"', JSON.stringify(absolute("src/lib/extract.ts")))
    .replaceAll('"../lib/feed-order"', JSON.stringify(absolute("src/lib/feed-order.ts")))
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/scroll-advance"', JSON.stringify(absolute("src/lib/scroll-advance.ts")))
    .replaceAll('"../lib/reading-layout"', JSON.stringify(absolute("src/lib/reading-layout.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "account-reading.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

// --- the slug ---------------------------------------------------------------
// One account has one slug, forever, and two accounts do not share one.
{
  const slug = accountSlug(ONE);
  check("a slug is hex and short", /^[0-9a-f]{8}$/.test(slug), slug);
  check("the same account always hashes the same", accountSlug({ ...ONE }) === slug, slug);
  check(
    "...even when the server was typed with a trailing slash",
    accountSlug({ serverUrl: "https://one.example/", email: ONE.email }) === slug,
    accountSlug({ serverUrl: "https://one.example/", email: ONE.email }),
  );
  check(
    "a different email on the same server is another slug",
    accountSlug({ ...ONE, email: "other@one.example" }) !== slug,
    accountSlug({ ...ONE, email: "other@one.example" }),
  );
  check(
    "the same email on another server is another slug",
    accountSlug({ serverUrl: TWO.serverUrl, email: ONE.email }) !== slug,
    accountSlug({ serverUrl: TWO.serverUrl, email: ONE.email }),
  );
  check("two accounts differ", accountSlug(TWO) !== slug, `${slug} vs ${accountSlug(TWO)}`);
}

// --- the key ----------------------------------------------------------------
// A key names an account without naming the account.
{
  const key = scopedKey(CHROME_KEY, ONE);
  check("the key is the base plus the slug", key === `${CHROME_KEY}:${accountSlug(ONE)}`, key);
  check("...and is stable", scopedKey(CHROME_KEY, { ...ONE }) === key);
  check("...and differs for the other account", scopedKey(CHROME_KEY, TWO) !== key);
  check("the email is not in the key", !key.includes(ONE.email), key);
  check("the server is not in the key", !key.includes("one.example"), key);
  check("no account yet means the bare key", scopedKey(CHROME_KEY, null) === CHROME_KEY);
  check("...and neither does undefined", scopedKey(CHROME_KEY, undefined) === CHROME_KEY);
}

// --- reading the account off the stored session ------------------------------
// The token in that blob is not this helper's business.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(ONE) });
  const account = storedAccount(storage);
  check("the stored session names the account", account?.email === ONE.email && account?.serverUrl === ONE.serverUrl);
  check("and nothing else is handed back", Object.keys(account ?? {}).sort().join(",") === "email,serverUrl");
  check("no session means no account", storedAccount(memoryStore()) === null);
  check("a broken session means no account", storedAccount(memoryStore({ [SESSION_KEY]: "{not json" })) === null);
  check("up to here nothing was written", storage.store.size === 1, [...storage.store.keys()].join(","));
}

// --- the upgrade path -------------------------------------------------------
// The legacy global key is adopted by whoever asks first, copied to the scoped
// key, and left in place: an older build still has to find it.
{
  const storage = memoryStore();
  const legacy = JSON.stringify({ mode: 2, collapsed: true });
  storage.setItem(CHROME_KEY, legacy);

  check("the first account reads what the global key held", readAccountValue(storage, CHROME_KEY, ONE) === legacy);
  check("it now has its own copy", storage.getItem(scopedKey(CHROME_KEY, ONE)) === legacy);
  check("the legacy key is still there", storage.getItem(CHROME_KEY) === legacy);
  check("a second account does not inherit it", readAccountValue(storage, CHROME_KEY, TWO) === null);
  check(
    "and its own copy is not written for it",
    storage.getItem(scopedKey(CHROME_KEY, TWO)) === null,
  );

  // Once the second account has its own value the two are independent.
  writeAccountValue(storage, CHROME_KEY, TWO, JSON.stringify({ mode: 1 }));
  check("the second account's write lands on its own key", readAccountValue(storage, CHROME_KEY, TWO) === JSON.stringify({ mode: 1 }));
  check("the first account is untouched", readAccountValue(storage, CHROME_KEY, ONE) === legacy);
  check("the legacy key survives both accounts", storage.getItem(CHROME_KEY) === legacy);
}

// --- the chrome, through its real reader and writer --------------------------
// Two accounts, one device, values that must not meet.
{
  const storage = memoryStore();
  writeBandCollapsed(storage, true, ONE);
  writePinPad(storage, true, TWO);

  check("the first account keeps its folded band", readBandCollapsed(storage, ONE) === true);
  check("...and not the second account's pad", readPinPad(storage, ONE) === false);
  check("the second account keeps its pad", readPinPad(storage, TWO) === true);
  check("...and not the first account's band", readBandCollapsed(storage, TWO) === false);
  check(
    "two keys, and neither names an address",
    [...storage.store.keys()].filter((key) => key.startsWith(CHROME_KEY)).length === 2 &&
      [...storage.store.keys()].every((key) => !key.includes("@") && !key.includes("one.example")),
    [...storage.store.keys()].join(", "),
  );

  // A device that already had the global key, now signing in: the first account
  // gets it, the second starts fresh.
  const upgraded = memoryStore({ [CHROME_KEY]: JSON.stringify({ bandCollapsed: true, indentOpen: false }) });
  check("the first account on an upgraded device keeps the fold", readBandCollapsed(upgraded, ONE) === true);
  check("the second account opens expanded", readBandCollapsed(upgraded, TWO) === false);
  check("the old global blob is still readable", JSON.parse(upgraded.getItem(CHROME_KEY))?.bandCollapsed === true);
}

// --- the reader's preference blob, through its adoption path ----------------
// Pins, the folded set and the indent cache share one blob; the pre-scoping key
// named the account outright, so only that account may pick it up.
{
  const storage = memoryStore();
  const legacyOne = `hardlyreader:prefs:${ONE.serverUrl}|${ONE.email}`;
  const pins = JSON.stringify({ pins: { categories: ["Tech"], feeds: [], view: "all" }, indentPx: 24 });
  storage.setItem(legacyOne, pins);

  check("the account named by the old key adopts it", readAccountValue(storage, PREFS_BASE, ONE, legacyOne) === pins);
  check("it lands on the scoped key", storage.getItem(scopedKey(PREFS_BASE, ONE)) === pins);
  check("the old blob stays for a downgrade", storage.getItem(legacyOne) === pins);
  check(
    "another account's old key is not consulted",
    readAccountValue(storage, PREFS_BASE, TWO, `hardlyreader:prefs:${TWO.serverUrl}|${TWO.email}`) === null,
  );
}

// --- the reading preferences, through the real module -----------------------
// Three launches over two accounts: A writes, B must not see it, A comes back and
// finds what it left. Each launch is a fresh module instance, like a restart.
{
  const readingModule = buildReadingModule();
  let launches = 0;
  const storage = memoryStore();
  const original = globalThis.localStorage;
  globalThis.localStorage = storage;

  const launch = async (account) => {
    if (account === null) storage.removeItem(SESSION_KEY);
    else storage.setItem(SESSION_KEY, JSON.stringify(account));
    const url = `${readingModule}?launch=${(launches += 1)}`;
    const { reading } = await import(url);
    reading.load();
    return reading;
  };

  try {
    const first = await launch(ONE);
    first.setListView("cards");
    check("the first account's choice is written", readAccountValue(storage, "hardlyreader.reading.v1", ONE)?.includes('"cards"') === true);

    const second = await launch(TWO);
    check("the second account opens on the shipped view", second.listView === "regular", second.listView);
    second.setListView("grid");

    const firstAgain = await launch(ONE);
    check("the first account comes back to its own view", firstAgain.listView === "cards", firstAgain.listView);

    const secondAgain = await launch(TWO);
    check("the second account keeps its own", secondAgain.listView === "grid", secondAgain.listView);

    const keys = [...storage.store.keys()];
    check(
      "two reading keys, one per account",
      keys.filter((key) => key.startsWith("hardlyreader.reading.v1")).length === 2,
      keys.filter((key) => key.startsWith("hardlyreader.reading.v1")).join(", "),
    );
    check(
      "no storage key names an address",
      keys.every((key) => !key.includes("@") && !key.includes("one.example") && !key.includes("two.example")),
      keys.join(", "),
    );
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
}

// --- the layout, through the real store -------------------------------------
// The layout is read at import, before anything renders, so the account has to be
// found the same way there as everywhere else — and with no account (a login
// screen) the bare key is still the one that works.
{
  const LAYOUT_KEY = "hardlyreader.layout.v1";
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(ONE) });
  globalThis.localStorage = storage;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 900,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    __TAURI_INTERNALS__: {},
  };
  globalThis.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });

  const { layout } = await import(`${buildLayoutModule()}?account=one`);
  layout.setMode(2);
  check("a signed-in account's layout goes under its slug", storage.getItem(scopedKey(LAYOUT_KEY, ONE)) !== null);
  check("...and not under the bare key", storage.getItem(LAYOUT_KEY) === null);

  storage.removeItem(SESSION_KEY);
  layout.setMode(1);
  check("with no account the bare key is still used", storage.getItem(LAYOUT_KEY) !== null);
  check(
    "and the account's copy was not overwritten",
    storage.getItem(scopedKey(LAYOUT_KEY, ONE)) !== null &&
      storage.getItem(scopedKey(LAYOUT_KEY, ONE)) !== storage.getItem(LAYOUT_KEY),
  );
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
