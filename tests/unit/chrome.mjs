import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  CHROME_KEY,
  MULTI_ACCOUNT_KEY,
  readMultiAccount,
  writeMultiAccount,
  readAutoSync,
  readAutoSyncHours,
  readBandCollapsed,
    readPinPad,
  writeAutoSync,
  writeAutoSyncHours,
  writeBandCollapsed,
    writePinPad,
} from "../../src/lib/chrome-prefs.ts";
import { settingsKey } from "../../src/lib/settings-scope.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function memoryStorage() {
  const store = new Map();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

const storage = memoryStorage();

/** The key the chrome actually lives on: the settings scope, this device's with
 *  no HardlyReader account. The bare `CHROME_KEY` seeds below are the legacy blob
 *  an older build wrote, which is adopted once. */
const KEY = (store) => settingsKey(store, CHROME_KEY);

check("a first run is expanded", readBandCollapsed(storage) === false);
check("no storage means expanded", readBandCollapsed(undefined) === false);

writeBandCollapsed(storage, true);
check("collapsing writes the settings key", storage.store.has(KEY(storage)));
check("the value is the collapsed flag", JSON.parse(storage.store.get(KEY(storage)))?.bandCollapsed === true);
check("only one key is written", storage.store.size === 1, [...storage.store.keys()].join(","));
check("it reads back as collapsed", readBandCollapsed(storage) === true);

// A relaunch is just another read of the same storage.
check("a relaunch stays collapsed", readBandCollapsed(storage) === true);

writeBandCollapsed(storage, false);
check("expanding is persisted", readBandCollapsed(storage) === false);

// The key holds flags that each write must carry along, and an indent flag an
// older build wrote is simply not read any more: the sidebar has no such row.
const shared = memoryStorage();
writeBandCollapsed(shared, true);
check("still one key", shared.store.size === 1, [...shared.store.keys()].join(","));
writeBandCollapsed(shared, false);
check("an older blob's indent flag is not read as the band's", (() => {
  const half = memoryStorage();
  half.store.set(CHROME_KEY, JSON.stringify({ indentOpen: true }));
  return readBandCollapsed(half) === false;
})());

storage.store.set(KEY(storage), "{not json");
check("corrupt JSON falls back to expanded", readBandCollapsed(storage) === false);
storage.store.set(KEY(storage), JSON.stringify({ bandCollapsed: "yes" }));
check("a non-boolean is not collapsed", readBandCollapsed(storage) === false);

// Storage that throws must never take the sidebar down with it.
const angry = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
};
check("a throwing read returns expanded", readBandCollapsed(angry) === false);
let threw = false;
try {
  writeBandCollapsed(angry, true);
} catch {
  threw = true;
}
check("a throwing write is swallowed", threw === false);

// --- the passcode keypad is an opt-in --------------------------------------
// Off is the promise: a keyboard is faster with a mouse, and nobody should get
// a number pad because they upgraded.
const pad = memoryStorage();
check("a first run types the passcode", readPinPad(pad) === false);
check("no storage types the passcode", readPinPad(undefined) === false);

writePinPad(pad, true);
check("turning the keypad on is persisted", readPinPad(pad) === true);
check("it writes the flag, not its own key", JSON.parse(pad.store.get(KEY(pad)))?.pinPad === true);
check("one key holds every chrome flag", pad.store.size === 1, [...pad.store.keys()].join(","));

// The remaining flags share one key: each write must carry the others along.
writeBandCollapsed(pad, true);
check("the keypad survives the other writes", readPinPad(pad) === true);
check("and the band flag survives the keypad write", readBandCollapsed(pad) === true);
writePinPad(pad, false);
check("turning it off is persisted too", readPinPad(pad) === false);
check("turning it off left the band flag alone", readBandCollapsed(pad) === true);

// A prefs blob written before the keypad existed must not invent it.
const old = memoryStorage();
old.store.set(CHROME_KEY, JSON.stringify({ bandCollapsed: true }));
check("an older prefs blob means typed entry", readPinPad(old) === false);
old.store.set(CHROME_KEY, JSON.stringify({ pinPad: "yes" }));
check("a non-boolean keypad flag is off", readPinPad(old) === false);
old.store.set(CHROME_KEY, JSON.stringify({ pinPad: 1 }));
check("one is not true here either", readPinPad(old) === false);


// Automatic sync shares the same key and the same rules: off until asked for,
// and an interval that has to be one the panel actually offers.
{
  const fresh = memoryStorage();
  check("auto sync is off on a first run", readAutoSync(fresh) === false);
  check("and hourly until it is changed", readAutoSyncHours(fresh) === 1);
  check("no storage still means off", readAutoSync(undefined) === false);

  writeAutoSync(fresh, true);
  check("turning it on reads back on", readAutoSync(fresh) === true);
  check("...without losing the other flags", readBandCollapsed(fresh) === false && readPinPad(fresh) === false);

  writeAutoSyncHours(fresh, 12);
  check("the interval reads back", readAutoSyncHours(fresh) === 12);
  check("...and the toggle survives it", readAutoSync(fresh) === true);

  writeAutoSyncHours(fresh, 7);
  check("an interval the panel does not offer is refused", readAutoSyncHours(fresh) === 1);

  const saved = JSON.parse(fresh.store.get(KEY(fresh)));
  check("both live under the one chrome key", saved.autoSync === true && saved.autoSyncHours === 1);
  check("only one key is ever written", fresh.store.size === 1);
}

/* ---------------------------------------------------------------------------
 * The lock's fold is not the reader's fold.
 *
 * The curtain folds the band on a phone. That fold is about the lock, not about
 * how the reader wants their sidebar: stored, one lock would leave the band
 * folded for every launch after it, and no reader asked for that. So the fold
 * is remembered (`collapseBandForLock`) and given back (`restoreBand`), while
 * `setBandCollapsed` — the reader asking — still writes.
 *
 * `chrome.svelte.ts` is a runes module, so it is compiled to plain ESM here the
 * same way `accounts.mjs` compiles it, against a Map-backed `localStorage`.
 * ------------------------------------------------------------------------- */
{
  const ROOT = new URL("../../", import.meta.url).pathname;
  const GEN = join(ROOT, `tests/unit/.gen-${process.pid}`);

  /** A runes module as plain ESM, imported from inside the project. */
  function buildModule(relative, outName) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: relative,
    });
    const compiled = compileModule(outputText, { generate: "client", filename: relative });
    const folder = dirname(relative);
    const code = compiled.js.code.replace(/from\s+"(\.[^"]*)"/g, (whole, specifier) => {
      const target = join(ROOT, folder, `${specifier}.ts`);
      if (!existsSync(target)) throw new Error(`unresolved import ${specifier} from ${relative}`);
      return `from ${JSON.stringify(pathToFileURL(target).href)}`;
    });
    mkdirSync(GEN, { recursive: true });
    const out = join(GEN, outName);
    writeFileSync(out, code);
    return pathToFileURL(out).href;
  }

  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  const { chrome } = await import(`${buildModule("src/state/chrome.svelte.ts", "chrome-fold.mjs")}?fold=1`);

  chrome.load();
  check("a launch starts on the stored fold", chrome.bandCollapsed === false);

  chrome.collapseBandForLock();
  check("the curtain folds the band", chrome.bandCollapsed === true);
  check("...and writes nothing down", store.size === 0, [...store.keys()].join(","));

  // A second lock while one is held must keep the fold already put aside, not
  // record "folded" as the reader's choice.
  chrome.collapseBandForLock();
  chrome.restoreBand();
  check("unlocking gives the band back the fold it had", chrome.bandCollapsed === false);
  check("...still without writing anything", store.size === 0, [...store.keys()].join(","));

  // The reader's own fold is stored, and a lock must not lose it.
  chrome.setBandCollapsed(true);
  check("a fold the reader asked for is stored", store.size === 1, [...store.keys()].join(","));
  chrome.collapseBandForLock();
  check("a lock on a folded band leaves it folded", chrome.bandCollapsed === true);
  chrome.restoreBand();
  check("and unlocking returns to the stored fold, not to open", chrome.bandCollapsed === true);

  // A reload is the next launch (or the next account): a fold held for a lock
  // that is over must not be handed back over the fold that was just read.
  chrome.setBandCollapsed(false);
  chrome.collapseBandForLock();
  chrome.load();
  check("a reload drops the held fold", chrome.bandCollapsed === false);
  chrome.restoreBand();
  check("so nothing restores over the fold it read", chrome.bandCollapsed === false);

  check("combined view defaults on", chrome.multiAccount === true);
  chrome.setMultiAccount(false);
  check("switch changes chrome immediately", chrome.multiAccount === false);
  check("choice uses its own device key", store.get(MULTI_ACCOUNT_KEY) === "false");
  chrome.load();
  check("choice survives reload", chrome.multiAccount === false);
  store.set("hardlyreader.session", JSON.stringify({ serverUrl: "https://other.example", email: "other" }));
  chrome.load();
  check("switching accounts does not reset device choice", chrome.multiAccount === false);
  chrome.setMultiAccount(true);
  check("on is persisted", readMultiAccount(globalThis.localStorage) === true);
}

{
  const storage = memoryStorage();

/** The key the chrome actually lives on: the settings scope, this device's with
 *  no HardlyReader account. The bare `CHROME_KEY` seeds below are the legacy blob
 *  an older build wrote, which is adopted once. */
const KEY = (store) => settingsKey(store, CHROME_KEY);
  check("missing storage preserves approved on default", readMultiAccount(undefined));
  for (const raw of [null, "garbage", "null", "0", "true"]) {
    if (raw !== null) storage.setItem(MULTI_ACCOUNT_KEY, raw);
    check(`only explicit false turns combined off (${raw})`, readMultiAccount(storage));
  }
  writeMultiAccount(storage, false);
  check("false round trips", !readMultiAccount(storage));
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  check("blocked reads default on", readMultiAccount(blocked));
  writeMultiAccount(blocked, false);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
