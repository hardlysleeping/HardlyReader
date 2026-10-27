/**
 * Checks for the sidebar arrangement: the document's rules, and the reader that
 * keeps it on the account.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/positions.mjs
 *
 * Two halves. The first is the pure document — which device's order survives,
 * what a malformed payload may do — and needs nothing but the module. The
 * second drives the real `ReaderState` against a fake server: the sidebar is a
 * runes module, so it is type-stripped, compiled with Svelte's `compileModule`
 * and imported from a throwaway directory inside the project (the same harness
 * `reader-state.mjs` uses). Every request is recorded and answered in-process,
 * so nothing here reaches a network, a GUI or the owner's account.
 *
 * What is asserted is what a caller can see: the arrays the sidebar draws, the
 * preferences a relaunch would read, and the requests — which route, which
 * method, what body, and how many times.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  EMPTY_POSITIONS,
  mergePositions,
  nextStamp,
  parsePositions,
  positionsBody,
  samePositions,
} from "../../src/lib/positions.ts";
import { scopedKey } from "../../src/lib/account-key.ts";

/** One blob holds pins, the local fold set and the indent cache. */
const PREFS_BASE = "hardlyreader.prefs.v1";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${JSON.stringify(detail)})`}`);
  }
}

/* ---------------------------------------------------------------------------
 * The document's own rules
 * ------------------------------------------------------------------------ */

const older = { updatedAt: 1000, categories: ["cat/A"], feeds: ["feed/1"] };
const newer = { updatedAt: 2000, categories: ["cat/B"], feeds: ["feed/2"] };

check("the newer arrangement wins", mergePositions(older, newer).positions === newer);
check("and the older one is not quietly kept", mergePositions(newer, older).positions === newer);
check(
  "a tie goes to the copy on screen",
  mergePositions(older, { ...older, updatedAt: 1000 }).source === "local",
);
check("an empty remote never wipes a local order", mergePositions(older, EMPTY_POSITIONS).positions === older);
check("an empty local adopts the remote", mergePositions(EMPTY_POSITIONS, newer).positions === newer);

check("a stamp always advances", nextStamp(5000, 5000) === 5001);
check("even when the clock has gone backwards", nextStamp(5000, 4000) === 5001);
check("and otherwise it is the clock", nextStamp(1000, 1700000000000) === 1700000000000);

const parsed = parsePositions({
  updatedAt: 42,
  categories: ["cat/A", "cat/A", "", 7],
  feeds: ["feed/9"],
});
check("parsing keeps the ids", JSON.stringify(parsed.categories) === JSON.stringify(["cat/A", "cat/A"]));
check("and drops everything that is not an id", parsed.feeds.length === 1 && parsed.feeds[0] === "feed/9");
check("a missing timestamp reads as zero", parsePositions({ categories: [] }).updatedAt === 0);
check("garbage reads as empty", samePositions(parsePositions("nope"), EMPTY_POSITIONS));
check("a negative timestamp is refused", parsePositions({ updatedAt: -5 }).updatedAt === 0);

const body = positionsBody({ updatedAt: 7, categories: ["a"], feeds: ["b"] });
check("the write carries both lists and the stamp", body.updatedAt === 7 && Array.isArray(body.categories));
check(
  "exactly those three keys, and no others",
  JSON.stringify(Object.keys(body).sort()) === '["categories","feeds","updatedAt"]',
);
check(
  "and hands over copies, so a caller cannot mutate what it sent",
  (() => {
    const source = { updatedAt: 1, categories: ["a"], feeds: [] };
    const sent = positionsBody(source);
    sent.categories.push("mutated");
    return source.categories.length === 1;
  })(),
);
check("two identical arrangements compare equal", samePositions(older, { ...older }));
check("a reordered one does not", !samePositions(older, { ...older, feeds: ["feed/2"] }));

// The client half of the wire: the route, the two calls and the order of them.
const api = readFileSync(new URL("../../src/api/hardlyread.ts", import.meta.url), "utf8");
check("a read of the arrangement exists", /export async function getPositions\(/.test(api));
check("a write exists", /export async function putPositions\(/.test(api));
check("both use the same route", /"\/positions"/.test(api));
check(
  "a 404 is read as an adapter without the route, not as a failure",
  /export function isRouteMissing\([\s\S]{0,120}status === 404/.test(api),
);
check(
  "a 409 is an answer the caller acts on, not a throw",
  /status === 409 && error\.code === "stale_positions"/.test(api),
);
check(
  "the arrangement is stamped next to the route that compares stamps",
  /export async function savePositions\([\s\S]{0,400}nextStamp\(previous\)/.test(api),
);

/* ---------------------------------------------------------------------------
 * The reader, against a fake server
 * ------------------------------------------------------------------------ */

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

function compileRunes(sourcePath, fileName) {
  const source = readFileSync(join(ROOT, sourcePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  });
  return compileModule(outputText, { generate: "client", filename: fileName }).js.code;
}

/** `src/state/reading.svelte.ts`, which the reader imports, as plain ESM. */
function buildReadingModule() {
  const code = compileRunes("src/state/reading.svelte.ts", "reading.svelte.ts")
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"../lib/extract"', JSON.stringify(absolute("src/lib/extract.ts")))
    .replaceAll('"../lib/feed-order"', JSON.stringify(absolute("src/lib/feed-order.ts")))
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/scroll-advance"', JSON.stringify(absolute("src/lib/scroll-advance.ts")))
    .replaceAll('"../lib/reading-layout"', JSON.stringify(absolute("src/lib/reading-layout.ts")))
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "positions-reading.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

function buildThemeModule() {
  const code = compileRunes("src/state/theme.svelte.ts", "theme.svelte.ts").replaceAll(
    '"../lib/theme"',
    JSON.stringify(absolute("src/lib/theme.ts")),
  );
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "positions-theme.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

function buildFloodsModule() {
  const code = compileRunes("src/state/floods.svelte.ts", "floods.svelte.ts").replaceAll(
    '"../lib/floods"',
    JSON.stringify(absolute("src/lib/floods.ts")),
  );
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "positions-floods.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

function buildReaderModule() {
  const code = compileRunes("src/state/reader.svelte.ts", "reader.svelte.ts")
    .replaceAll('"../api/freshrss"', JSON.stringify(absolute("src/api/freshrss.ts")))
    .replaceAll('"../api/hardlyread"', JSON.stringify(absolute("src/api/hardlyread.ts")))
    .replaceAll('"../api/transport"', JSON.stringify(absolute("src/api/transport.ts")))
    .replaceAll('"../lib/reading-order"', JSON.stringify(absolute("src/lib/reading-order.ts")))
    .replaceAll('"../lib/feed-order"', JSON.stringify(absolute("src/lib/feed-order.ts")))
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"./reading.svelte"', JSON.stringify(buildReadingModule()))
    .replaceAll('"./theme.svelte"', JSON.stringify(buildThemeModule()))
    .replaceAll('"./floods.svelte"', JSON.stringify(buildFloodsModule()))
    .replaceAll('"../lib/stream-cycle"', JSON.stringify(absolute("src/lib/stream-cycle.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"../lib/sync-progress"', JSON.stringify(absolute("src/lib/sync-progress.ts")))
    .replaceAll('"../lib/place"', JSON.stringify(absolute("src/lib/place.ts")))
    .replaceAll('"./hidden-write"', JSON.stringify(absolute("src/state/hidden-write.ts")))
    .replaceAll('"./hidden"', JSON.stringify(absolute("src/state/hidden.ts")))
    .replaceAll('"./favorites"', JSON.stringify(absolute("src/state/favorites.ts")))
    .replaceAll('"./write"', JSON.stringify(absolute("src/state/write.ts")))
    .replaceAll('"./stream-cache"', JSON.stringify(absolute("src/state/stream-cache.ts")))
    .replaceAll('"./pins"', JSON.stringify(absolute("src/state/pins.ts")))
    .replaceAll('"./persist"', JSON.stringify(absolute("src/state/persist.ts")))
    .replaceAll('"../lib/api-snapshot"', JSON.stringify(absolute("src/lib/api-snapshot.ts")))
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")))
    .replaceAll('"../lib/extract-ledger"', JSON.stringify(absolute("src/lib/extract-ledger.ts")))
    .replaceAll('"../lib/full-text"', JSON.stringify(absolute("src/lib/full-text.ts")))
    .replaceAll('"../lib/stream-loads"', JSON.stringify(absolute("src/lib/stream-loads.ts")))
    .replaceAll('"../lib/stream-perf"', JSON.stringify(absolute("src/lib/stream-perf.ts")))
    .replaceAll('"../lib/stream-scroll"', JSON.stringify(absolute("src/lib/stream-scroll.ts")));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "positions-reader.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const SESSION = { serverUrl: "https://reader.test", email: "u@reader.test", token: "u/0123456789abcdef" };
const OTHER = { ...SESSION, email: "other@reader.test" };

const PREFS = (session) => scopedKey(PREFS_BASE, session);

function subscription(id, title, label) {
  return {
    id,
    title,
    url: `https://example.invalid/${id}`,
    categories: label === null ? [] : [{ id: `user/-/label/${label}`, label }],
  };
}

const SUBSCRIPTIONS = [
  subscription("feed/1", "Ars Technica", "Technology"),
  subscription("feed/2", "MoMA", "Art"),
  subscription("feed/3", "Untagged", null),
  subscription("feed/4", "Nautilus", "Science"),
];

const TECH = "user/-/label/Technology";
const ART = "user/-/label/Art";
const SCI = "user/-/label/Science";

/** A plain-Map `localStorage`, so preferences survive a "relaunch" in here. */
function installStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  return store;
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fake FreshRSS: the GReader calls a real `start()` makes, the extension's
 * `/v1/state`, and the arrangement store that obeys the same rule the PHP
 * adapter does — a write stamped older than the stored one is refused 409,
 * carrying only the winning stamp.
 */
function installServer({ document: initial, route = true, onWrite } = {}) {
  const server = {
    document: initial ?? { updatedAt: 0, categories: [], feeds: [] },
    route,
    requests: [],
    writes: [],
    refusals: 0,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const payload = typeof init.body === "string" ? JSON.parse(init.body) : null;
    server.requests.push({ method, url, body: payload });

    if (url.includes("/v1/positions")) {
      if (!server.route) {
        return json(404, { ok: false, error: { code: "route_not_found", message: "Unknown route." } });
      }
      if (method === "GET") return json(200, { apiVersion: 1, ...server.document });
      if (onWrite !== undefined) onWrite(server, payload);
      if (server.document.updatedAt > payload.updatedAt) {
        server.refusals += 1;
        return json(409, {
          ok: false,
          error: { code: "stale_positions", message: "A newer arrangement is already stored." },
          updatedAt: server.document.updatedAt,
        });
      }
      server.document = { updatedAt: payload.updatedAt, categories: payload.categories, feeds: payload.feeds };
      server.writes.push(payload);
      return json(200, { apiVersion: 1, ...server.document });
    }
    if (url.includes("/v1/state")) {
      return json(200, {
        apiVersion: 1,
        hiddenCategories: { available: false },
        favorites: { available: false },
        sidebarIndent: { available: false },
      });
    }
    if (url.includes("/subscription/list")) return json(200, { subscriptions: SUBSCRIPTIONS });
    if (url.includes("/tag/list")) return json(200, { tags: [] });
    if (url.includes("/unread-count")) return json(200, { unreadcounts: [] });
    if (url.includes("/stream/contents")) return json(200, { items: [], continuation: null });
    return json(404, { ok: false });
  };
  return server;
}

const positionsCalls = (server) => server.requests.filter((entry) => entry.url.includes("/v1/positions"));
const methods = (server) => positionsCalls(server).map((entry) => entry.method);

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const drawnIds = (reader) => reader.categories.map((group) => group.id);

const { ReaderState } = await import(buildReaderModule());
const realFetch = globalThis.fetch;
const realStorage = globalThis.localStorage;

try {
  /* --- 1. start adopts the account's copy when it is the newer one -------- */

  {
    const now = Date.now();
    const store = installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/2", "feed/1"],
        positionsAt: now - 60_000,
      }),
    });
    const server = installServer({
      document: { updatedAt: now + 60_000, categories: [TECH, ART], feeds: ["feed/1", "feed/2"] },
    });
    const reader = new ReaderState();
    await reader.start(SESSION);
    await reader.positionsLanded;

    check(
      "start adopts a newer arrangement from the account",
      same(reader.categoryOrder, [TECH, ART]) && same(reader.feedOrder, ["feed/1", "feed/2"]),
      { categories: reader.categoryOrder, feeds: reader.feedOrder },
    );
    check(
      "the adopted order is what the sidebar draws, in front of the rest",
      same(drawnIds(reader).slice(0, 2), [TECH, ART]),
      drawnIds(reader),
    );
    const relaunched = new ReaderState();
    relaunched.session = SESSION;
    relaunched.loadPrefs();
    check(
      "and it is saved, so the next launch paints it before any request",
      same(relaunched.categoryOrder, [TECH, ART]) && same(relaunched.feedOrder, ["feed/1", "feed/2"]),
      { categories: relaunched.categoryOrder },
    );
    check(
      "the adopted stamp is remembered with it",
      JSON.parse(store.get(PREFS(SESSION))).positionsAt === now + 60_000,
      JSON.parse(store.get(PREFS(SESSION))).positionsAt,
    );
    check("starting reads the arrangement once", methods(server).length === 1, methods(server));
    check("starting writes nothing: the local copy has nothing newer to say", server.writes.length === 0);

    // A drag after the adoption must carry a stamp past the one adopted, which
    // is only possible if the stamp came back with the read.
    reader.arrangeCategory(ART, TECH);
    await until(() => server.writes.length === 1);
    check(
      "a drag after the adoption writes a stamp newer than the copy it adopted",
      server.writes.length === 1 && server.writes[0].updatedAt > now + 60_000,
      server.writes[0]?.updatedAt,
    );
  }

  /* --- 2. no adoption when the local copy is the newer one ---------------- */

  {
    const now = Date.now();
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/2", "feed/1"],
        positionsAt: now + 60_000,
      }),
    });
    const server = installServer({
      document: { updatedAt: now, categories: [TECH, ART], feeds: ["feed/1", "feed/2"] },
    });
    const reader = new ReaderState();
    await reader.start(SESSION);
    await reader.positionsLanded;

    check(
      "a newer local arrangement is not overwritten by an older account copy",
      same(reader.categoryOrder, [ART, TECH]) && same(reader.feedOrder, ["feed/2", "feed/1"]),
      { categories: reader.categoryOrder, feeds: reader.feedOrder },
    );
    check(
      "and the read happened anyway — the comparison is the point",
      positionsCalls(server).length === 1 && positionsCalls(server)[0].method === "GET",
      methods(server),
    );
    check("a launch that keeps the local copy writes nothing", server.writes.length === 0);
  }

  /* --- 3. an adapter without the route: local only, and silent ------------- */

  {
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/2", "feed/1"],
        positionsAt: 1000,
      }),
    });
    const server = installServer({ route: false });
    const reader = new ReaderState();
    await reader.start(SESSION);
    await reader.positionsLanded;

    check(
      "a 404 keeps the local order exactly as it was",
      same(reader.categoryOrder, [ART, TECH]) && same(reader.feedOrder, ["feed/2", "feed/1"]),
      { categories: reader.categoryOrder, feeds: reader.feedOrder },
    );
    check("…and says nothing: an old adapter is not an error", reader.error === null, reader.error);
    check(
      "…and the sidebar still draws, in the dragged order",
      same(drawnIds(reader).slice(0, 2), [ART, TECH]),
      drawnIds(reader),
    );

    // A drag on a server known to have no route must not spend a request.
    reader.arrangeCategory(TECH, ART);
    await new Promise((resolve) => setTimeout(resolve, 60));
    check("a drag on an adapter without the route sends nothing", methods(server).length === 1, methods(server));
    check(
      "…but the drag is still drawn and kept",
      same(reader.categoryOrder, [TECH, ART]) &&
        same(JSON.parse(globalThis.localStorage.getItem(PREFS(SESSION))).categoryOrder, [TECH, ART]),
      reader.categoryOrder,
    );
  }

  /* --- 4. a drag writes the two lists, and only after it is drawn --------- */

  {
    installStorage();
    const server = installServer();
    const reader = new ReaderState();
    reader.session = SESSION;
    reader.subscriptions = SUBSCRIPTIONS;
    reader.loadPrefs();
    reader.categoryOrder = [ART, TECH];
    // An id this account no longer has must never travel: the document says what
    // the sidebar shows, and the sidebar cannot show a feed that is not there.
    reader.feedOrder = ["feed/2", "feed/1", "feed/999"];

    let drawnAtWrite = null;
    const serverFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input).includes("/v1/positions") && (init.method ?? "GET") === "PUT") {
        // What the sidebar is drawing at the instant the request leaves.
        drawnAtWrite = [...reader.categoryOrder];
      }
      return serverFetch(input, init);
    };

    const requestsBefore = server.requests.length;
    const drawnGroups = reader.categories.length + reader.allCategories.length;
    check(
      "drawing the sidebar asks the network for nothing",
      drawnGroups > 0 && server.requests.length === requestsBefore,
      `${server.requests.length - requestsBefore} requests`,
    );

    reader.arrangeCategory(ART, null);
    await until(() => server.writes.length === 1);

    check("the drag is drawn before the write leaves, never after", same(drawnAtWrite ?? [], [TECH, ART]), drawnAtWrite);
    check("the drag reaches the account", server.writes.length === 1, server.writes.length);
    const sent = server.writes[0] ?? {};
    check(
      "the write carries the two id lists and the stamp, nothing else",
      same(Object.keys(sent).sort(), ["categories", "feeds", "updatedAt"]),
      Object.keys(sent).sort(),
    );
    check("the categories are the order on screen", same(sent.categories, [TECH, ART]), sent.categories);
    check("and a feed the account does not have is not sent", same(sent.feeds, ["feed/2", "feed/1"]), sent.feeds);
    check(
      "the stamp is a real millisecond clock",
      Number.isInteger(sent.updatedAt) && sent.updatedAt > 1e12,
      sent.updatedAt,
    );
  }

  /* --- 4b. a feed drag is a drag too -------------------------------------- */

  {
    installStorage();
    const server = installServer();
    const reader = new ReaderState();
    reader.session = SESSION;
    reader.subscriptions = SUBSCRIPTIONS;
    reader.loadPrefs();
    reader.categoryOrder = [ART, TECH];
    reader.feedOrder = ["feed/1", "feed/2"];

    const ok = await reader.arrangeFeed("feed/1", "Technology", null);
    await until(() => server.writes.length === 1);

    check("a feed drag inside its own category commits", ok === true);
    check(
      "…and the moved feed is where the drag put it",
      same(reader.feedOrder, ["feed/2", "feed/1"]),
      reader.feedOrder,
    );
    check(
      "…and the account is told, in a positions write only",
      server.writes.length === 1 &&
        same(server.writes[0].feeds, ["feed/2", "feed/1"]) &&
        positionsCalls(server).length === 1,
      { writes: server.writes.length, calls: methods(server) },
    );
  }

  /* --- 5. a 409: adopt the account's copy, do not fight it ---------------- */

  {
    const now = Date.now();
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/1", "feed/2"],
        positionsAt: 1000,
      }),
    });
    // Another device wrote later than this one's clock: the only way a write is
    // genuinely stale.
    const server = installServer({
      document: { updatedAt: now + 60_000, categories: [TECH, SCI, ART], feeds: ["feed/2", "feed/4"] },
    });
    const reader = new ReaderState();
    reader.session = SESSION;
    reader.subscriptions = SUBSCRIPTIONS;
    reader.loadPrefs();

    reader.arrangeCategory(TECH, ART);
    await until(() => server.refusals === 1);
    await until(() => same(reader.categoryOrder, [TECH, SCI, ART]), 500);

    check("the refused write is refused once, not retried", server.refusals === 1, server.refusals);
    check("the account's arrangement is adopted", same(reader.categoryOrder, [TECH, SCI, ART]), reader.categoryOrder);
    check("…and its feed order comes with it", same(reader.feedOrder, ["feed/2", "feed/4"]), reader.feedOrder);
    check(
      "…after one read of the copy that won, and no second write",
      methods(server).filter((method) => method === "GET").length === 1 && server.writes.length === 0,
      methods(server),
    );
    const kept = JSON.parse(globalThis.localStorage.getItem(PREFS(SESSION)));
    check(
      "…and the adopted copy is what a relaunch would read",
      same(kept.categoryOrder, [TECH, SCI, ART]) && kept.positionsAt === now + 60_000,
      kept,
    );
  }

  /* --- 6. two devices converge after a stale write ------------------------ */

  {
    const now = Date.now();
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH, SCI],
        order: ["feed/2", "feed/1"],
        positionsAt: now + 60_000,
      }),
      [PREFS(OTHER)]: JSON.stringify({
        categoryOrder: [SCI, ART, TECH],
        order: ["feed/1", "feed/2"],
        positionsAt: 1000,
      }),
    });
    const server = installServer();
    const thisDevice = new ReaderState();
    thisDevice.session = SESSION;
    thisDevice.subscriptions = SUBSCRIPTIONS;
    thisDevice.loadPrefs();
    const otherDevice = new ReaderState();
    otherDevice.session = OTHER;
    otherDevice.subscriptions = SUBSCRIPTIONS;
    otherDevice.loadPrefs();

    // This device rearranges; its stamp is ahead of the clock, so it is stored.
    thisDevice.arrangeCategory(TECH, null);
    await until(() => server.writes.length === 1);
    check(
      "the first device's drag is stored",
      same(server.document.categories, [ART, SCI, TECH]),
      server.document.categories,
    );

    // The other device drags from an older stamp and is refused.
    otherDevice.arrangeCategory(SCI, null);
    await until(() => server.refusals === 1);
    await until(() => same(otherDevice.categoryOrder, [ART, SCI, TECH]), 500);

    check("the stale write is refused", server.refusals === 1, server.refusals);
    check(
      "the other device ends up on the same arrangement",
      same(otherDevice.categoryOrder, thisDevice.categoryOrder) &&
        same(otherDevice.feedOrder, thisDevice.feedOrder),
      { other: otherDevice.categoryOrder, this: thisDevice.categoryOrder },
    );
    check(
      "the account's copy was not overwritten by the stale write",
      same(server.document.categories, [ART, SCI, TECH]) && same(server.document.feeds, ["feed/2", "feed/1"]),
      server.document,
    );
    check(
      "neither device retried: two writes attempted, one stored",
      server.writes.length === 1 && server.refusals === 1,
      { stored: server.writes.length, refused: server.refusals },
    );
  }

  /* --- 6b. a refusal also rules out the drag queued behind it ------------- */

  {
    const now = Date.now();
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/1", "feed/2"],
        positionsAt: 1000,
      }),
    });
    const server = installServer({
      document: { updatedAt: now + 60_000, categories: [TECH, SCI, ART], feeds: ["feed/2", "feed/4"] },
    });
    const reader = new ReaderState();
    reader.session = SESSION;
    reader.subscriptions = SUBSCRIPTIONS;
    reader.loadPrefs();

    // Two drags in a row, before the first answer is back: both are built from
    // an order the account has already superseded.
    reader.arrangeCategory(TECH, ART);
    reader.arrangeCategory(SCI, TECH);
    await until(() => server.refusals === 1);
    await until(() => same(reader.categoryOrder, [TECH, SCI, ART]), 500);

    check("two quick drags send one write, not two", methods(server).filter((m) => m === "PUT").length === 1, methods(server));
    check("the queued drag is dropped rather than forced through", server.writes.length === 0, server.writes.length);
    check(
      "and the account's arrangement is what stays on screen",
      same(reader.categoryOrder, [TECH, SCI, ART]),
      reader.categoryOrder,
    );

    // Voiding is not permanent: the next drag, made against the order the user
    // can now see, is sent and stored.
    reader.arrangeCategory(ART, TECH);
    await until(() => server.writes.length === 1);
    check(
      "a drag made after the refusal is written as usual",
      server.writes.length === 1 && same(server.document.categories, [ART, TECH, SCI]),
      server.document.categories,
    );
  }

  /* --- 7. a failure is not allowed to touch the screen -------------------- */

  {
    installStorage({
      [PREFS(SESSION)]: JSON.stringify({
        categoryOrder: [ART, TECH],
        order: ["feed/2", "feed/1"],
        positionsAt: 1000,
      }),
    });
    const dead = installServer();
    const serverFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input).includes("/v1/positions")) throw new TypeError("network down");
      return serverFetch(input, init);
    };
    const reader = new ReaderState();
    await reader.start(SESSION);
    await reader.positionsLanded;

    check(
      "a dead network leaves the local arrangement alone",
      same(reader.categoryOrder, [ART, TECH]) && same(reader.feedOrder, ["feed/2", "feed/1"]),
      { categories: reader.categoryOrder },
    );
    check("…and raises nothing on screen", reader.error === null, reader.error);
    check("…and the sidebar still draws", drawnIds(reader).length === 4, drawnIds(reader).length);
    check("…and no write was attempted behind the failed read", dead.writes.length === 0, methods(dead));

    // The network comes back. A failure must not have been remembered as "this
    // adapter has no route" — that would silently cost every later drag.
    const back = installServer();
    reader.arrangeCategory(TECH, ART);
    await until(() => back.writes.length === 1);
    check(
      "a failed read is not remembered as a missing route: the next drag is still sent",
      back.writes.length === 1,
      methods(back),
    );
    check(
      "…and that drag carried the order on screen",
      same(back.writes[0]?.categories, [TECH, ART]),
      back.writes[0]?.categories,
    );
  }
} finally {
  globalThis.fetch = realFetch;
  if (realStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = realStorage;
  for (const name of ["positions-reader.mjs", "positions-reading.mjs", "positions-theme.mjs", "positions-floods.mjs"]) {
    rmSync(join(GEN_DIR, name), { force: true });
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
