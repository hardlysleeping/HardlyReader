import { CHROME_KEY, readBandCollapsed, writeBandCollapsed } from "../../src/lib/chrome-prefs.ts";

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

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
