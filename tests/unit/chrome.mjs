import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  CHROME_KEY,
  readAutoSync,
  readAutoSyncHours,
  readBandCollapsed,
  readIndentOpen,
  readPinPad,
  writeAutoSync,
  writeAutoSyncHours,
  writeBandCollapsed,
  writeIndentOpen,
  writePinPad,
} from "../../src/lib/chrome-prefs.ts";

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

check("a first run is expanded", readBandCollapsed(storage) === false);
check("no storage means expanded", readBandCollapsed(undefined) === false);

writeBandCollapsed(storage, true);
check("collapsing writes its own key", storage.store.has(CHROME_KEY));
check("the value is the collapsed flag", JSON.parse(storage.store.get(CHROME_KEY))?.bandCollapsed === true);
check("only one key is written", storage.store.size === 1, [...storage.store.keys()].join(","));
check("it reads back as collapsed", readBandCollapsed(storage) === true);

// A relaunch is just another read of the same storage.
check("a relaunch stays collapsed", readBandCollapsed(storage) === true);

writeBandCollapsed(storage, false);
check("expanding is persisted", readBandCollapsed(storage) === false);

// The indent slider is a second flag in the same key: writing one must not
// drop the other.
const shared = memoryStorage();
check("the indent slider starts collapsed", readIndentOpen(shared) === false);
writeBandCollapsed(shared, true);
writeIndentOpen(shared, true);
check("opening the slider keeps the band collapsed", readBandCollapsed(shared) === true);
check("the slider reads back as open", readIndentOpen(shared) === true);
check("still one key", shared.store.size === 1, [...shared.store.keys()].join(","));
writeBandCollapsed(shared, false);
check("expanding the band keeps the slider open", readIndentOpen(shared) === true);
writeIndentOpen(shared, false);
check("closing the slider keeps the band expanded", readBandCollapsed(shared) === false);
check("a half-written key defaults both flags quiet", (() => {
  const half = memoryStorage();
  half.store.set(CHROME_KEY, JSON.stringify({ indentOpen: true }));
  return readIndentOpen(half) === true && readBandCollapsed(half) === false;
})());

storage.store.set(CHROME_KEY, "{not json");
check("corrupt JSON falls back to expanded", readBandCollapsed(storage) === false);
storage.store.set(CHROME_KEY, JSON.stringify({ bandCollapsed: "yes" }));
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
check("it writes the flag, not its own key", JSON.parse(pad.store.get(CHROME_KEY))?.pinPad === true);
check("one key holds every chrome flag", pad.store.size === 1, [...pad.store.keys()].join(","));

// The three flags share one key: each write must carry the others along.
writeBandCollapsed(pad, true);
writeIndentOpen(pad, true);
check("the keypad survives the other writes", readPinPad(pad) === true);
check("and the band flag survives the keypad write", readBandCollapsed(pad) === true);
writePinPad(pad, false);
check("turning it off is persisted too", readPinPad(pad) === false);
check("turning it off left the band flag alone", readBandCollapsed(pad) === true);

// A prefs blob written before the keypad existed must not invent it.
const old = memoryStorage();
old.store.set(CHROME_KEY, JSON.stringify({ bandCollapsed: true, indentOpen: false }));
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

  const saved = JSON.parse(fresh.store.get(CHROME_KEY));
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
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
