/**
 * Account-scoped IndexedDB caching.
 *
 * The `localStorage` half of this app was scoped to an account in 0.5.1; the
 * IndexedDB cache kept building its keys as `${serverUrl}|${email}|${name}`, so
 * the sidebar, stream and post-text blobs on disk spelled out both the server
 * and the address — the exact thing the release notes say never appears in a key.
 * These checks pin the fix:
 *
 * - one account hashes to one key, two accounts to two;
 * - a key is `<slug>|<name>` and carries neither the address nor the server;
 * - the reader's and the search index's caches still round-trip, through their
 *   real modules, and never across accounts;
 * - pruning and sign-out clearing stay inside one account's keys;
 * - blobs written by the old layout are never read, and are dropped rather than
 *   left on disk holding an address.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/persist-scope.mjs
 *
 * IndexedDB does not exist in Node, and `persist.ts` treats that as "no cache",
 * so the suite installs a small in-memory stand-in for it: open/upgrade, one
 * object store, and deferred requests, which is the whole surface the file uses.
 * Nothing here touches a real browser store.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { accountSlug } from "../../src/lib/account-key.ts";
import { GEN_DIR, ROOT, buildReaderModule } from "./build-reader.mjs";

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

/** A session carries a token; the key path must not care. */
const sessionOf = (account) => ({
  serverUrl: account.serverUrl,
  apiPath: "/api/greader.php",
  email: account.email,
  token: "test-token",
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

// --- a stand-in for IndexedDB ------------------------------------------------
// Only what `src/state/persist.ts` calls: open with an upgrade hook, one store
// keyed by "key", and get/put/delete/getAll/getAllKeys delivered asynchronously
// the way the real thing delivers them.
{
  const stores = new Map();
  const storeFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };

  const request = (work) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = work();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };

  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      const map = storeFor(name);
      return { createIndex: () => ({}) , map };
    },
    transaction(name) {
      const map = storeFor(name);
      return {
        objectStore: () => ({
          get: (key) => request(() => map.get(key)),
          put: (entry) => {
            map.set(entry.key, entry);
            return request(() => entry.key);
          },
          delete: (key) => {
            map.delete(key);
            return request(() => undefined);
          },
          getAll: () => request(() => [...map.values()]),
          getAllKeys: () => request(() => [...map.keys()]),
        }),
      };
    },
  };

  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = database;
        // The app's upgrade hook: create the store if this is a first run.
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  /** The one store, read and written directly by the checks. */
  globalThis.__idbStore = storeFor("entries");

  // `persist.ts` thinks it is talking to a browser store it has already used:
  // seed the blobs an older build would have left behind, plus one blob this
  // build could have written, and see which of them survive the first open.
  const legacyScoped = "https://one.example|one@one.example|sidebar";
  const legacyBare = "stream:feed/1";
  globalThis.__legacyKeys = [legacyScoped, legacyBare];
  for (const key of globalThis.__legacyKeys) {
    globalThis.__idbStore.set(key, { key, value: { stale: true }, at: 1 });
  }
  const ownKey = `${accountSlug(ONE)}|sidebar`;
  globalThis.__ownKey = ownKey;
  globalThis.__idbStore.set(ownKey, { key: ownKey, value: { stale: false }, at: 2 });
}

/** localStorage, for the reader and search modules that read their prefs at import. */
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const { readCached, scopeKey, pruneStreams, clearScope, writeCached } = await import(
  "../../src/state/persist.ts"
);

const store = globalThis.__idbStore;
const keysNow = () => [...store.keys()];

/** A key is not a place for a server or an address. */
function names(account, key) {
  return key.includes(account.email) || key.includes(account.serverUrl) || key.includes("@") ||
    key.includes("one.example") || key.includes("two.example");
}

// --- the key -----------------------------------------------------------------
// Same account, same key; two accounts, two keys; no name in either.
{
  const key = scopeKey(ONE, "stream:feed/1");
  check("the key is the slug and the name", key === `${accountSlug(ONE)}|stream:feed/1`, key);
  check("the same account always has the same key", scopeKey({ ...ONE }, "stream:feed/1") === key);
  check(
    "...even when the server was typed with a trailing slash and a capital",
    scopeKey({ serverUrl: "https://ONE.example/", email: " one@one.example " }, "stream:feed/1") === key,
    scopeKey({ serverUrl: "https://ONE.example/", email: " one@one.example " }, "stream:feed/1"),
  );
  check("two accounts differ", scopeKey(TWO, "stream:feed/1") !== key, scopeKey(TWO, "stream:feed/1"));
  check("the email is not in the key", !key.includes("@"), key);
  check("the server is not in the key", !key.includes("example") && !key.includes("://"), key);
  check("every name gets that account's prefix", scopeKey(ONE, "sidebar").startsWith(`${accountSlug(ONE)}|`));
  check(
    "and two names under one account stay apart",
    scopeKey(ONE, "sidebar") !== scopeKey(ONE, "stream:feed/1"),
  );
  check(
    "a session with no address still hashes instead of throwing",
    (() => {
      try {
        return /^[0-9a-f]{8}\|sidebar$/.test(scopeKey({ serverUrl: ONE.serverUrl }, "sidebar"));
      } catch {
        return false;
      }
    })(),
  );
  check(
    "...and is still told apart from another server",
    scopeKey({ serverUrl: ONE.serverUrl }, "sidebar") !== scopeKey({ serverUrl: TWO.serverUrl }, "sidebar"),
  );
}

// --- the upgrade path --------------------------------------------------------
// First open drops what this build cannot read. It is a cache: the cost of
// losing a blob is one round-trip, and the reason to lose it is that its key
// held an address.
await writeCached(scopeKey(ONE, "sidebar"), { subscriptions: [], tags: [], counts: [] });
await tick();

{
  check(
    "a blob from the old layout is gone",
    !store.has("https://one.example|one@one.example|sidebar"),
    keysNow().join(", "),
  );
  check("so is the bare pre-scoping key", !store.has("stream:feed/1"));
  check(
    "the stale value was not copied to a scoped key",
    (await readCached(scopeKey(ONE, "stream:feed/1"))) === undefined,
  );
  check("a key this build writes is recognised and survives the sweep", store.has(globalThis.__ownKey), keysNow().join(", "));
  check(
    "the sweep did not eat the blob just written",
    (await readCached(scopeKey(ONE, "sidebar"))) !== undefined,
  );
}

// --- reading and writing -----------------------------------------------------
// Two accounts, one device: what one writes the other cannot see.
{
  await writeCached(scopeKey(ONE, "stream:feed/1"), { items: [{ id: "item-1" }], continuation: undefined });
  check(
    "a value written for one account comes back for that account",
    (await readCached(scopeKey(ONE, "stream:feed/1")))?.value.items.length === 1,
  );
  check(
    "the other account's key is a miss, not the first account's value",
    (await readCached(scopeKey(TWO, "stream:feed/1"))) === undefined,
  );
  check("the timestamp is stored with it", typeof (await readCached(scopeKey(ONE, "stream:feed/1")))?.at === "number");
}

// --- pruning and sign-out stay inside one account -----------------------------
// Both filter on a prefix, so the prefix has to be the account's own.
{
  // Seeded as a previous launch would have left them: distinct write times, so
  // "oldest first" is a fact rather than a tie.
  store.delete(scopeKey(ONE, "stream:feed/1"));
  for (let index = 0; index < 62; index += 1) {
    const key = scopeKey(ONE, `stream:prune-${index}`);
    store.set(key, { key, value: { index }, at: 1_000 + index });
  }
  await writeCached(scopeKey(TWO, "stream:keep-me"), { kept: true });
  await pruneStreams(scopeKey(ONE, "stream:"));

  const one = keysNow().filter((key) => key.startsWith(`${accountSlug(ONE)}|stream:`));
  const two = keysNow().filter((key) => key.startsWith(`${accountSlug(TWO)}|stream:`));
  check("the account keeps at most the newest sixty streams", one.length === 60, String(one.length));
  check(
    "the oldest go first",
    !one.includes(scopeKey(ONE, "stream:prune-0")) &&
      !one.includes(scopeKey(ONE, "stream:prune-1")) &&
      one.includes(scopeKey(ONE, "stream:prune-61")),
    `${one.length} kept, prune-0 ${one.includes(scopeKey(ONE, "stream:prune-0")) ? "kept" : "dropped"}`,
  );
  check("another account's streams are not pruned", two.length === 1, two.join(", "));

  await clearScope(`${accountSlug(ONE)}|`);
  check(
    "sign-out clears this account and nothing else",
    keysNow().every((key) => !key.startsWith(`${accountSlug(ONE)}|`)),
    keysNow().join(", "),
  );
  check("the other account survives sign-out", store.has(scopeKey(TWO, "stream:keep-me")));
}

// --- the reader's caches, through the real reader ----------------------------
// A restart paints the sidebar from disk, and a second account starts empty.
{
  mkdirSync(GEN_DIR, { recursive: true });
  const generated = join(GEN_DIR, "persist-reader.mjs");
  writeFileSync(generated, buildReaderModule());
  const { ReaderState } = await import(pathToFileURL(generated).href);

  const reader = new ReaderState();
  reader.session = sessionOf(ONE);
  reader.subscriptions = [
    { id: "feed/1", title: "Ars Technica", url: "https://example.invalid/feed/1", categories: [] },
  ];
  reader.tags = [{ id: "user/-/label/Tech", label: "Tech" }];
  reader.persistSidebar([{ id: "feed/1", count: 7 }]);
  await tick();

  const sidebarKey = reader.diskKey("sidebar");
  check("the reader's sidebar key names no account", !names(ONE, sidebarKey), sidebarKey);
  check("...and is the scoped key", sidebarKey === scopeKey(ONE, "sidebar"), sidebarKey);

  const restarted = new ReaderState();
  restarted.session = sessionOf(ONE);
  await restarted.hydrateSidebar();
  check(
    "a restart paints the sidebar from disk",
    restarted.subscriptions.length === 1 && restarted.subscriptions[0].title === "Ars Technica",
    JSON.stringify(restarted.subscriptions.map((feed) => feed.title)),
  );
  check("with its tags", restarted.tags.length === 1, JSON.stringify(restarted.tags));
  check("and its counts", restarted.counts.get("feed/1") === 7, String(restarted.counts.get("feed/1")));

  const otherAccount = new ReaderState();
  otherAccount.session = sessionOf(TWO);
  await otherAccount.hydrateSidebar();
  check("another account does not inherit the sidebar", otherAccount.subscriptions.length === 0);

  reader.rememberStream("feed/1", [{ id: "item-1", title: "One" }], "next-page");
  await tick();
  const streamKey = reader.diskKey("stream:feed/1");
  check("a stream lands on disk under the account's key", streamKey === scopeKey(ONE, "stream:feed/1"), streamKey);
  check("the stream key names no account", !names(ONE, streamKey), streamKey);
  const back = await readCached(streamKey);
  check("the stream round-trips, continuation and all", back?.value.items.length === 1 && back?.value.continuation === "next-page");
  check(
    "the other account's stream key is a miss",
    (await readCached(otherAccount.diskKey("stream:feed/1"))) === undefined,
  );
}

// --- the search index, through the real search module -----------------------
// Compiled the way the app's build compiles it, run three times: a first run
// that fills the index, a restart that reads it back, and another account that
// must not find it.
{
  function buildSearchModule() {
    const source = readFileSync(join(ROOT, "src/state/search.svelte.ts"), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: "search.svelte.ts",
    });
    const compiled = compileModule(outputText, { generate: "client", filename: "search.svelte.ts" });
    const code = compiled.js.code
      .replaceAll('"../api/freshrss"', JSON.stringify(absolute("src/api/freshrss.ts")))
      .replaceAll('"../api/transport"', JSON.stringify(absolute("src/api/transport.ts")))
      .replaceAll('"../api/backend"', JSON.stringify(absolute("src/api/backend.ts")))
      .replaceAll('"../api/greader-backend"', JSON.stringify(absolute("src/api/greader-backend.ts")))
      .replaceAll('"../api/profile"', JSON.stringify(absolute("src/api/profile.ts")))
      .replaceAll('"../lib/search"', JSON.stringify(absolute("src/lib/search.ts")))
      .replaceAll('"./persist"', JSON.stringify(absolute("src/state/persist.ts")));
    mkdirSync(GEN_DIR, { recursive: true });
    const out = join(GEN_DIR, "persist-search.mjs");
    writeFileSync(out, code);
    return pathToFileURL(out).href;
  }

  const searchModule = buildSearchModule();
  const feeds = [{ id: "feed/1", title: "Ars Technica" }];
  let calls = [];

  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        id: "feed/1",
        items: [
          { id: "item-1", title: "Phones reviewed", content: { content: "<p>we tested the folding screen</p>" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { search } = await import(`${searchModule}?run=1`);
  await search.refresh(feeds, sessionOf(ONE));
  check("the first run reads the feed over the network", calls.length === 1, String(calls.length));
  await tick();

  const feedKey = scopeKey(ONE, "feedtext:feed/1");
  check("the extracted text is written under the account's key", store.has(feedKey), keysNow().join(", "));
  check("the post-text key names no account", !names(ONE, feedKey), feedKey);

  const { search: restarted } = await import(`${searchModule}?run=2`);
  calls = [];
  await restarted.refresh(feeds, sessionOf(ONE));
  check("a restart answers from disk, not the network", calls.length === 0, String(calls.length));
  check(
    "the text it answers with is the stored text",
    restarted.index["feed/1"]?.posts[0]?.text.includes("folding screen") === true,
    JSON.stringify(restarted.index["feed/1"]?.posts),
  );

  const { search: otherAccount } = await import(`${searchModule}?run=3`);
  calls = [];
  await otherAccount.refresh(feeds, sessionOf(TWO));
  check("another account's cache is empty, so it fetches its own", calls.length === 1, String(calls.length));
  check(
    "and its index was written under its own key",
    store.has(scopeKey(TWO, "feedtext:feed/1")) && feedKey !== scopeKey(TWO, "feedtext:feed/1"),
  );
}

// --- nothing on disk names a server or an address ---------------------------
// The claim in the release notes, checked against every key actually stored.
{
  const all = keysNow();
  check("the store is not empty, so this is worth checking", all.length > 0, String(all.length));
  check(
    "no stored key carries an address",
    all.every((key) => !key.includes("@")),
    all.find((key) => key.includes("@")) ?? "",
  );
  check(
    "no stored key carries a server",
    all.every((key) => !key.includes("example") && !key.includes("://")),
    all.find((key) => key.includes("://")) ?? "",
  );
  check(
    "every stored key starts with a slug",
    all.every((key) => /^[0-9a-f]{8}\|/.test(key)),
    all.find((key) => !/^[0-9a-f]{8}\|/.test(key)) ?? "",
  );
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
