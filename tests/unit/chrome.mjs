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

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
