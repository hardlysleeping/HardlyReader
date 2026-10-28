/**
 * The one paid feature, and the promise its expiry makes.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/entitlements.mjs
 *
 * HardlyReader Sync is one subscription that unlocks every provider:
 * `hardlyreader.sync.monthly` and `hardlyreader.sync.yearly` grant the same
 * capability — `cloudSync` — and nothing is sold per provider. This suite holds
 * the capability to that, and to the second half of the promise, which is what
 * happens when it lapses: `cloudSync` goes false, and **nothing local is
 * touched**. A real local library is opened here while the subscription is
 * expired, because "no data loss on expiry" is only worth anything against the
 * store that actually holds the posts.
 *
 * `Store` is the seam, so the suite never needs a shop: `FakeStore` grants,
 * expires, goes into grace and throws on demand. `NativeStore` is the stub the
 * desktop build gets until the Rust side exists, and it is checked to refuse by
 * name rather than quietly granting.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { READING_LIST } from "../../src/api/freshrss.ts";
import { GEN_DIR, ROOT } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const FEED = "https://fixture.test/feed.xml";
const T = 1_700_000_000;

/* --------------------------------------------------------------------------
 * The capability, built the way the reader and layout suites build theirs
 * ----------------------------------------------------------------------- */

function buildEntitlementsModule() {
  const file = join(ROOT, "src/state/entitlements.svelte.ts");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "entitlements.svelte.ts",
  });
  const compiled = compileModule(outputText, {
    generate: "client",
    filename: "entitlements.svelte.ts",
  });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "entitlements.mjs");
  writeFileSync(out, compiled.js.code);
  return pathToFileURL(out).href;
}

const {
  Entitlements,
  FakeStore,
  NativeStore,
  SYNC_MONTHLY,
  SYNC_YEARLY,
  isNoStoreHere,
  readEntitlement,
} = await import(buildEntitlementsModule());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fresh(store) {
  const entitlement = new Entitlements(store);
  await entitlement.refresh();
  return entitlement;
}

/* --------------------------------------------------------------------------
 * No receipt, then each of the two prices
 * ----------------------------------------------------------------------- */

{
  const entitlement = await fresh(new FakeStore());
  check("a device with no receipt has no cloud sync", entitlement.cloudSync === false);
  check("and no subscription state to explain", entitlement.state === "none");
  check("and nothing to apologise for", entitlement.reason === null);
}

{
  const store = new FakeStore();
  store.grant(SYNC_MONTHLY);
  const entitlement = await fresh(store);
  check("a monthly subscription unlocks cloud sync", entitlement.cloudSync === true);
  check("the state says which way it stands", entitlement.state === "active");
}

{
  const store = new FakeStore();
  store.grant(SYNC_YEARLY);
  const entitlement = await fresh(store);
  check("a yearly subscription unlocks the same cloud sync", entitlement.cloudSync === true);
}

{
  // The whole point of one capability: there is no per-provider flag to check.
  const module = await import(buildEntitlementsModule());
  const exported = Object.keys(module).filter((name) => /purchase|drive|icloud/i.test(name));
  check("the capability exports no per-provider flag", exported.length === 0, exported.join(",") || "(none)");
  const entitlement = await fresh(new FakeStore());
  check(
    "and holds no field named after a provider",
    Object.keys(entitlement).every((key) => !/purchase|drive|icloud/i.test(key)),
    Object.keys(entitlement).join(","),
  );
}

/* --------------------------------------------------------------------------
 * Expiry: false, and the library is not touched
 * ----------------------------------------------------------------------- */

async function library() {
  const store = new LocalStore(new MemoryDatabase());
  const backend = new LocalBackend(store, { deviceName: "This laptop" });
  await backend.subscribe({ feedUrl: FEED, title: "Fixture feed" });
  await store.putEntries([
    { feedUrl: FEED, guid: "one", title: "Fixture one", published: T + 20, content: "<p>First.</p>" },
    { feedUrl: FEED, guid: "two", title: "Fixture two", published: T + 10, content: "<p>Second.</p>" },
  ]);
  return { store, backend };
}

{
  const store = new FakeStore();
  store.expire(SYNC_MONTHLY, T);
  const entitlement = await fresh(store);
  check("an expired subscription stops cloud sync", entitlement.cloudSync === false);
  check("and says why it stopped", entitlement.state === "expired" && /ended/.test(String(entitlement.reason)));

  // The promise: expiry is about syncing, not about the reader's own library.
  const { store: local, backend } = await library();
  const contents = await backend.stream(READING_LIST, { count: 10 });
  check(
    "the library on this device still opens while the subscription is expired",
    contents.items.length === 2,
    String(contents.items.length),
  );
  check(
    "and its posts still read",
    contents.items.map((item) => item.title).join(",") === "Fixture one,Fixture two",
    contents.items.map((item) => item.title).join(","),
  );
  const feeds = await local.feeds();
  check("no feed was removed on expiry", feeds.length === 1, String(feeds.length));
  const page = await local.queryEntries({ count: 10 });
  check("no post was deleted on expiry", page.entries.length === 2, String(page.entries.length));
  await local.close();
}

{
  // A stale "active" is the realistic shape of a lapsed subscription: the cache
  // was written before the card stopped working. The calendar outranks the word.
  const entitlement = await fresh(
    new FakeStore({ state: "active", productId: SYNC_MONTHLY, expiresAt: Date.now() - 60_000, reason: null }),
  );
  check("an active receipt whose date has passed is expired", entitlement.cloudSync === false);
  check("and is named as expired, not as active", entitlement.state === "expired", entitlement.state);

  const future = await fresh(
    new FakeStore({ state: "active", productId: SYNC_MONTHLY, expiresAt: Date.now() + 60_000, reason: null }),
  );
  check("a date still in the future grants", future.cloudSync === true);
}

/* --------------------------------------------------------------------------
 * Grace: a failed payment is not a customer who stopped paying
 * ----------------------------------------------------------------------- */

{
  const store = new FakeStore();
  store.grace(SYNC_MONTHLY, T);
  const entitlement = await fresh(store);
  check("a subscription in grace still grants cloud sync", entitlement.cloudSync === true);
  check(
    "and grace is not second-guessed by the failed payment's date",
    entitlement.state === "grace" && entitlement.cloudSync === true,
  );
}

/* --------------------------------------------------------------------------
 * Restore: a receipt for something else is not a receipt for this
 * ----------------------------------------------------------------------- */

{
  const store = new FakeStore();
  store.unknownReceipt("someone.else.thing");
  const entitlement = new Entitlements(store);
  const restored = await entitlement.restore();
  check("restoring a purchase for another product grants nothing", restored === false);
  check("and cloud sync stays off", entitlement.cloudSync === false);
  check(
    "with a reason naming the product it was not",
    /someone\.else\.thing is not a HardlyReader Sync product/.test(String(entitlement.reason)),
    String(entitlement.reason),
  );
  check("the store was actually asked", store.restores === 1);
}

{
  const store = new FakeStore();
  const entitlement = new Entitlements(store);
  store.grant(SYNC_YEARLY);
  check("restoring a real purchase turns cloud sync on", (await entitlement.restore()) === true);
  check("and the capability follows the receipt", entitlement.cloudSync === true);
}

/* --------------------------------------------------------------------------
 * A store that throws answers "no", never "yes"
 * ----------------------------------------------------------------------- */

{
  const store = new FakeStore();
  store.fail = "the store is offline";
  const entitlement = new Entitlements(store);
  await entitlement.refresh();
  check("a store that throws leaves cloud sync off", entitlement.cloudSync === false);
  check("not on, not granted, not remembered", entitlement.state === "none");
  check("the reason is the store's own words", entitlement.reason === "the store is offline", String(entitlement.reason));

  const bought = await entitlement.purchase(SYNC_MONTHLY);
  check("a purchase that throws answers false", bought === false && entitlement.cloudSync === false);
}

/* --------------------------------------------------------------------------
 * Buying: two prices, and an id this app does not sell is refused
 * ----------------------------------------------------------------------- */

{
  const store = new FakeStore();
  const entitlement = new Entitlements(store);
  const bought = await entitlement.purchase(SYNC_YEARLY);
  check("buying the yearly price unlocks cloud sync", bought === true && entitlement.cloudSync === true);
  check("the store was asked for that exact product", store.purchases.join(",") === SYNC_YEARLY);

  const refused = await entitlement.purchase("hardlyreader.sync.lifetime");
  check("an id this app does not sell is refused", refused === false);
  check("the store never hears about it", store.purchases.length === 1, store.purchases.join(","));
  check("and a real subscription is not dropped by the refusal", entitlement.cloudSync === true);
}

{
  const store = new FakeStore();
  const entitlement = new Entitlements(store);
  await entitlement.loadProducts();
  check("the offer is the two prices and nothing else", entitlement.offer.map((product) => product.id).join(",") === `${SYNC_MONTHLY},${SYNC_YEARLY}`);
  check("both are the same subscription, one capability", entitlement.cloudSync === false);
}

/* --------------------------------------------------------------------------
 * The stub the desktop build gets until the shell has a shop
 * ----------------------------------------------------------------------- */

{
  const store = new NativeStore();
  let thrown = null;
  try {
    await store.current();
  } catch (cause) {
    thrown = cause;
  }
  check("the native store refuses to answer without a shell", thrown !== null);
  check("it refuses by name", isNoStoreHere(thrown) && thrown.code === "no_store_here", String(thrown));

  const entitlement = new Entitlements(new NativeStore());
  await entitlement.refresh();
  check("a build with no store grants nothing", entitlement.cloudSync === false);
  check("and knows it has no store, rather than that the subscription lapsed", entitlement.available === false);
  check("so it has no reason to show a person", entitlement.reason === null);
}

/* --------------------------------------------------------------------------
 * Launch and visibility: a lapse is found on the next look, not the next restart
 * ----------------------------------------------------------------------- */

{
  const store = new FakeStore();
  store.grant(SYNC_MONTHLY);
  const entitlement = new Entitlements(store);

  const listeners = new Map();
  const doc = {
    visibilityState: "hidden",
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  const realDocument = globalThis.document;
  globalThis.document = doc;
  try {
    const stop = entitlement.watch();
    await settle();
    check("watching checks at launch", store.asked === 1 && entitlement.cloudSync === true);

    doc.visibilityState = "hidden";
    listeners.get("visibilitychange")();
    await settle();
    check("going away is not a reason to ask the store", store.asked === 1);

    doc.visibilityState = "visible";
    listeners.get("visibilitychange")();
    await settle();
    check("coming back asks again", store.asked === 2);

    store.expire(SYNC_MONTHLY, T);
    listeners.get("visibilitychange")();
    await settle();
    check("a subscription that lapsed while the window was open stops cloud sync", entitlement.cloudSync === false);
    check("and it was the return that found out", store.asked === 3);

    stop();
    check("the teardown removes the listener", listeners.size === 0 && listeners.has("visibilitychange") === false);
  } finally {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
}

/* --------------------------------------------------------------------------
 * The rules, without a store in the way
 * ----------------------------------------------------------------------- */

{
  check(
    "a receipt for another product never grants",
    readEntitlement({ state: "active", productId: "someone.else.thing", expiresAt: null, reason: null }).state === "none",
  );
  check(
    "no product id is no subscription",
    readEntitlement({ state: "none", productId: null, expiresAt: null, reason: null }).state === "none",
  );
  check(
    "grace grants even with a passed date on it",
    readEntitlement({ state: "grace", productId: SYNC_MONTHLY, expiresAt: 1, reason: null }, 2).state === "grace",
  );
}

/* --------------------------------------------------------------------------
 * The grep the acceptance names: one file reads a product id, and no file has
 * a per-provider flag
 * ----------------------------------------------------------------------- */

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|svelte|js|json)$/.test(name)) found.push(path);
  }
  return found;
}

{
  const files = sourceFiles(join(ROOT, "src"));
  const read = (path) => readFileSync(path, "utf8");
  // Prose is not code: the capability *names* the flags and the failure modes it
  // forbids, so the scan reads a file with its comments taken out.
  const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const named = files
    .filter((path) => /hardlyreader\.sync\.(monthly|yearly)/.test(code(path)))
    .map((path) => relative(ROOT, path));
  check(
    "the product ids are read in exactly one file",
    named.join(",") === "src/state/entitlements.svelte.ts",
    named.join(",") || "(none)",
  );

  const flags = files
    .filter((path) => /has[A-Za-z]*Purchase/.test(code(path)))
    .map((path) => relative(ROOT, path));
  check("no file carries a per-provider purchase flag", flags.length === 0, flags.join(",") || "(none)");

  const writers = files.filter((path) => /cloudSync\s*=[^=]/.test(code(path))).map((path) => relative(ROOT, path));
  check(
    "cloudSync is written in the capability and nowhere else",
    writers.join(",") === "src/state/entitlements.svelte.ts",
    writers.join(",") || "(none)",
  );

  // The capability must not be able to reach the library even by accident.
  const own = read(join(ROOT, "src/state/entitlements.svelte.ts"));
  const imports = [...own.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  check("the capability imports nothing from the app", imports.length === 0, imports.join(",") || "(none)");
  check(
    "and so can never delete, lock or sign anything out",
    !/readOnly|\blogout\b|deleteEntry|clearLibrary|unsubscribe/.test(code(join(ROOT, "src/state/entitlements.svelte.ts"))),
  );

  // The sync engine moves a document when it is asked to. It never learns why.
  const sync = code(join(ROOT, "src/api/local/sync.ts"));
  check(
    "the sync engine never learns about billing",
    !/entitlement|cloudSync|hardlyreader\.sync|purchase|receipt/i.test(sync),
  );

  // `docs/authority.md`, check 4: nothing on the FreshRSS path consults an
  // entitlement. A server-backed profile is free, and free means no billing
  // question is ever asked of it.
  const freshrssPath = [
    ...sourceFiles(join(ROOT, "src/api/local")),
    ...["freshrss.ts", "greader-backend.ts", "backend.ts", "session.ts", "transport.ts", "profile.ts"].map(
      (name) => join(ROOT, "src/api", name),
    ),
  ];
  const billed = freshrssPath
    .filter((path) => /entitlement|cloudSync|hardlyreader\.sync/i.test(code(path)))
    .map((path) => relative(ROOT, path));
  check("nothing on the FreshRSS or local-reading path consults an entitlement", billed.length === 0, billed.join(",") || "(none)");

  const app = read(join(ROOT, "src/App.svelte"));
  check("the shell checks the capability at launch", /entitlement\.watch\(\)/.test(app));
  check("and removes the listener when it unmounts", /stopWatchingEntitlement\?\.\(\)/.test(app));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
