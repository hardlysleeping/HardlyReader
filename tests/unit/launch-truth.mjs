/**
 * The state the app has before it has asked.
 *
 * A launch used to draw every category and then sweep the hidden ones away when
 * the state read landed — a few hundred milliseconds of the sidebar lying about
 * what is in it, and, on a locked account, of the rows a lock exists to cover.
 * This suite pins the fix from the reader's own side:
 *
 * - the stored snapshot is drawn while the launch load is still in the air, and
 *   the live read is asked for in the same round as the sidebar;
 * - a live answer replaces the snapshot, and the newer answer is what the next
 *   launch reads;
 * - a cached `locked` stays down when the read that answers it fails, because a
 *   dropped connection is not news about the curtain — and a lock pressed a
 *   second before quitting is drawn on the first frame of the next launch;
 * - a server that answers "no such route" has its snapshot deleted, so a server
 *   that never had the add-on is not drawn from a cache forever;
 * - the one row Settings shows about the add-on is three answers read from state
 *   the app already holds, with no request of its own.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/launch-truth.mjs
 *
 * No browser and no server: `localStorage` is a Map, IndexedDB does not exist
 * (which `persist.ts` treats as "no cache", so nothing here is answered from the
 * sidebar blob), and `fetch` is a router that answers by URL. The reader is the
 * real one, built by the same helper the other reader suites use.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { accountSlug, scopedKey } from "../../src/lib/account-key.ts";
import { API_SNAPSHOT_KEY, readApiSnapshot, writeApiSnapshot } from "../../src/lib/api-snapshot.ts";
import { parseFavorites, parseState } from "../../src/api/hardlyread.ts";
import { GEN_DIR, buildReaderModule } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** One login. Both halves are synthetic; no token is used for anything but the header. */
const ACCOUNT = { serverUrl: "https://reader.test", email: "u@reader.test" };
const SESSION = { ...ACCOUNT, apiPath: "/api/greader.php", token: "u/0123456789abcdef" };

/** A `localStorage` over a Map, so a relaunch is a new object over the same map. */
function memoryStore() {
  const store = new Map();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A promise somebody else settles: the point of it is that it has not settled. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What the server reports when the extension is there and the account is open. */
const LIVE = {
  apiVersion: 1,
  hiddenCategories: {
    available: true,
    mode: "strict",
    view: "revealed",
    effectiveView: "revealed",
    hiddenIds: [12],
    locked: false,
    hasPasscode: true,
    categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ],
  },
  favorites: {
    available: true,
    view: "all",
    ids: [7],
    categories: [
      { id: 12, name: "Technology", favorite: false },
      { id: 7, name: "Art", favorite: true },
    ],
  },
  sidebarIndent: { available: true, px: 24, max: 60 },
  peopleAvailable: false,
};

/** The same account with the curtain down, as the extension reports it. */
const LOCKED = {
  ...LIVE,
  hiddenCategories: { ...LIVE.hiddenCategories, view: "hidden", effectiveView: "hidden", locked: true },
};

/**
 * The server, by URL.
 *
 * `state` decides what `/v1/state` does — a body, a promise of one, or a throw —
 * and everything else answers the shape FreshRSS's GReader API would: empty
 * lists, which is all the launch load needs to land. Every request is recorded,
 * because "was it asked" is half of what this suite is about.
 */
function stubServer({ state = () => json(LIVE), lock = () => json({ changed: true, hiddenCategories: LOCKED.hiddenCategories }) } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (url.includes("/misc.php/")) {
      if (url.endsWith("/v1/state")) return state();
      if (url.endsWith("/v1/lock")) return lock();
      if (url.endsWith("/v1/positions")) return json({ updatedAt: 1, categories: [], feeds: [] });
      return json({});
    }
    // Two feeds in two categories: enough for "is the hidden one out of the
    // sidebar" to be a question with an answer.
    if (url.includes("/subscription/list")) {
      return json({
        subscriptions: [
          { id: "feed/1", title: "Ars Technica", url: "https://example.invalid/1", categories: [{ id: "user/-/label/Technology", label: "Technology" }] },
          { id: "feed/2", title: "MoMA", url: "https://example.invalid/2", categories: [{ id: "user/-/label/Art", label: "Art" }] },
        ],
      });
    }
    return json({ tags: [], unreadcounts: [], items: [], continuation: null });
  };
  return calls;
}

/** The snapshot a previous launch would have left: locked, one category hidden. */
function seedSnapshot(storage, over = {}) {
  const hidden = parseState({
    ...(over.locked === false ? LIVE.hiddenCategories : LOCKED.hiddenCategories),
    ...(over.hidden ?? {}),
  });
  writeApiSnapshot(storage, ACCOUNT, {
    hiddenCategories: hidden,
    favorites: parseFavorites(LIVE.favorites),
    sidebarIndent: LIVE.sidebarIndent,
  });
}

const labels = (groups) => groups.map((group) => group.label).join(",");

/** Let the launch load reach the network: the disk read it awaits is a microtask chain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "launch-truth-reader.mjs");
writeFileSync(generated, buildReaderModule());
const { ReaderState } = await import(pathToFileURL(generated).href);

// ---------------------------------------------------------------------------
// The first frame: drawn from storage, before the state read answers.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  seedSnapshot(storage);
  const answer = deferred();
  const calls = stubServer({ state: () => answer.promise });

  const reader = new ReaderState();
  const started = reader.start(SESSION);

  // Nothing has been awaited yet, so this is what the first frame draws.
  check("the lock is already down on the first frame", reader.hiddenLocked === true);
  check("and the view is already the locked one", reader.hiddenView === "hidden", reader.hiddenView);
  check("the hidden category is known as hidden before any feed is drawn", reader.isCategoryHidden("Technology") === true);
  check("the pinned category came back with it", reader.isCategoryPinned("Art") === true);
  check("so did the indent", reader.sidebarIndent.px === 24, String(reader.sidebarIndent.px));
  check(
    "and the first frame did not wait on the state read",
    calls.every((call) => !call.endsWith("/v1/state")),
    calls.join(", "),
  );

  await settle();
  check(
    "the live state read goes out with the launch load",
    calls.some((call) => call.endsWith("/v1/state")),
    calls.join(", "),
  );
  check("the curtain is still down while it is out", reader.hiddenLocked === true);

  answer.resolve(json(LIVE));
  await started;

  check("the live answer replaces the snapshot", reader.hiddenLocked === false && labels(reader.categories) === "Art,Technology", labels(reader.categories));
  const saved = readApiSnapshot(storage, ACCOUNT);
  check("and is what the next launch will read", saved?.hiddenCategories.locked === false && saved?.savedAt > 0);
  check("with the pins and indent it answered with", saved?.favorites.ids.includes(7) === true && saved?.sidebarIndent.px === 24);
}

// ---------------------------------------------------------------------------
// A read that failed is not news about the curtain.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  seedSnapshot(storage);
  stubServer({ state: () => Promise.reject(new TypeError("Failed to fetch")) });

  const reader = new ReaderState();
  await reader.start(SESSION);

  check("a failed state read leaves the lock down", reader.hiddenLocked === true);
  check(
    "and the hidden category still out of the sidebar",
    labels(reader.categories) === "Art",
    labels(reader.categories),
  );
  check("the failure is recorded, so a menu can say why", reader.hiddenError !== null);
  check("the snapshot survives a dropped connection", readApiSnapshot(storage, ACCOUNT) !== null);
  // The app is still holding a state the extension gave it; a dropped connection
  // is not evidence the adapter went away, so the row does not claim it did.
  check("and the add-on keeps its last answer", reader.addOn === "connected", reader.addOn);

  // Nothing cached and nothing answered is the third answer.
  globalThis.localStorage = memoryStore();
  const cold = new ReaderState();
  await cold.start(SESSION);
  check("a server that has never answered is unknown, not absent", cold.addOn === "unknown", cold.addOn);
}

// ---------------------------------------------------------------------------
// A server with no such route: the snapshot goes, and stays gone.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  seedSnapshot(storage);
  const calls = stubServer({
    state: () => json({ error: { code: "route_not_found", message: "Unknown route." } }, 404),
  });

  const reader = new ReaderState();
  await reader.start(SESSION);

  check("route_not_found clears the snapshot", readApiSnapshot(storage, ACCOUNT) === null);
  check("the sidebar stops hiding what it cannot verify", labels(reader.categories) === "Art,Technology", labels(reader.categories));
  check("and Settings says the add-on is not installed", reader.addOn === "absent", reader.addOn);
  check("the route was tried once, not once per category", calls.filter((call) => call.endsWith("/v1/state")).length === 1);
}

// ---------------------------------------------------------------------------
// A server that is not FreshRSS is not asked at all.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  seedSnapshot(storage);
  const calls = stubServer();

  const reader = new ReaderState();
  await reader.start({ ...SESSION, apiPath: "/api/aggregator.php" });

  check("no extension route leaves for a server that cannot host it", calls.every((call) => !call.includes("/misc.php/")), calls.join(", "));
  check("and its snapshot is not drawn forever either", readApiSnapshot(storage, ACCOUNT) === null);
  check("add-on: not installed", reader.addOn === "absent", reader.addOn);
}

// ---------------------------------------------------------------------------
// Before any answer has landed there is nothing to say.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  const answer = deferred();
  stubServer({ state: () => answer.promise });

  const reader = new ReaderState();
  const started = reader.start(SESSION);
  check("no snapshot and no answer reads as unknown", reader.addOn === "unknown", reader.addOn);
  check(
    "and nothing is hidden on a guess",
    reader.isCategoryHidden("Technology") === false && reader.hiddenAvailable === false,
  );

  answer.resolve(json(LIVE));
  await started;
  check("the first answer makes it connected", reader.addOn === "connected", reader.addOn);
}

// ---------------------------------------------------------------------------
// A lock pressed before quitting is a lock on the next launch.
// ---------------------------------------------------------------------------
// The reply to the lock is a state the server just wrote, which is the freshest
// thing there is — so it is stored, not left for the next read to notice.
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  stubServer();
  const before = new ReaderState();
  before.session = SESSION;
  before.hiddenCategories = parseState(LIVE.hiddenCategories);
  await before.lockHidden();
  check("locking stores the state it left the server in", readApiSnapshot(storage, ACCOUNT)?.hiddenCategories.locked === true);

  // A relaunch over the same storage, with the state read held open.
  const answer = deferred();
  stubServer({ state: () => answer.promise });
  const after = new ReaderState();
  const started = after.start(SESSION);
  check("so the next launch opens locked", after.hiddenLocked === true);
  check("with the locked view already applied", after.hiddenView === "hidden" && after.isCategoryHidden("Technology"));
  answer.resolve(json(LOCKED));
  await started;
  check("and the live read agrees rather than correcting it", after.hiddenLocked === true);
}

// ---------------------------------------------------------------------------
// An unlock is the one answer allowed to lift it.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  seedSnapshot(storage);
  stubServer();
  const reader = new ReaderState();
  reader.session = SESSION;
  reader.hiddenCategories = parseState(LOCKED.hiddenCategories);
  // The reply to an unlock is the state without the lock; `apiUnlockHidden`
  // answers the whole block, and the snapshot follows it.
  globalThis.fetch = async () => json({ changed: true, hiddenCategories: LIVE.hiddenCategories });
  const unlocked = await reader.unlockHidden("1234");
  check("an accepted passcode lifts the curtain", unlocked === true && reader.hiddenLocked === false);
  check("and the next launch opens unlocked", readApiSnapshot(storage, ACCOUNT)?.hiddenCategories.locked === false);
}

// ---------------------------------------------------------------------------
// The one new key: scoped like every other, and naming nobody.
// ---------------------------------------------------------------------------
{
  const storage = memoryStore();
  globalThis.localStorage = storage;
  stubServer();
  const reader = new ReaderState();
  await reader.start(SESSION);

  const keys = [...storage.store.keys()];
  const snapshotKey = keys.find((key) => key.includes(API_SNAPSHOT_KEY));
  check("the snapshot has a key of its own", snapshotKey !== undefined, keys.join(", "));
  check("scoped to this account's slug", snapshotKey === scopedKey(API_SNAPSHOT_KEY, ACCOUNT), snapshotKey);
  check("...which is a hash, not the address", snapshotKey?.includes(accountSlug(ACCOUNT)) === true && !snapshotKey.includes("@"));
  check(
    "no stored key names the address or the server",
    keys.every((key) => !key.includes("@") && !key.includes("reader.test")),
    keys.join(", "),
  );
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
