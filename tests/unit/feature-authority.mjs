/**
 * Every extra asks the resolver — through `ReaderState`, not through the pure
 * module.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feature-authority.mjs
 *
 * `tests/unit/capabilities.mjs` proves the ladder itself. This suite proves the
 * thing the ladder exists *for*: that hidden categories, the pins, the indent,
 * the arrangement and the place are decided by it inside the store, so no call
 * site keeps a hand-made rule of its own.
 *
 * Four backends, four answers, and the same reader all the way down:
 *
 *   1. FreshRSS **with** the extensions — everything `backend`, and buying adds
 *      nothing (`upgradePitch === "nothing"`).
 *   2. The Old Reader or Miniflux — `local` when free, `cloud` when paid, and the
 *      free case really does keep working on that device: categories hide, pins
 *      pin, the place resumes.
 *   3. A library on this device — everything `backend`, and paying adds the
 *      mirror.
 *   4. FreshRSS **without** the extensions (installed but off, or absent) —
 *      `local`/`cloud`, never `backend`.
 *
 * `ReaderState` is compiled the way the app's build compiles it and driven through
 * its real API client, with `fetch` replaced by a recorder and `localStorage` a
 * small stub. Nothing leaves the process.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { localProfile } from "../../src/api/profile.ts";
import { writePlace } from "../../src/lib/place.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
/** Only this suite's own corner: siblings run in parallel and share `.gen`. */
const GEN_DIR = join(ROOT, `tests/unit/.gen-${process.pid}/feature-authority`);

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/* ---------------------------------------------------------------------------
 * The harness: the runes modules, compiled and pointed at absolute paths
 * ------------------------------------------------------------------------ */

function buildRunesModule(file, name, replaces = {}) {
  const source = readFileSync(join(ROOT, "src/state", file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: file });
  let code = compiled.js.code;
  for (const [specifier, target] of Object.entries(replaces)) {
    code = code.replaceAll(specifier, JSON.stringify(absolute(target)));
  }
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, name);
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const buildReadingModule = () =>
  buildRunesModule("reading.svelte.ts", "reading.mjs", {
    '"../lib/article-filter"': "src/lib/article-filter.ts",
    '"../lib/list-view"': "src/lib/list-view.ts",
    '"../lib/extract"': "src/lib/extract.ts",
    '"../lib/feed-order"': "src/lib/feed-order.ts",
    '"../lib/indent"': "src/lib/indent.ts",
    '"../lib/dwell"': "src/lib/dwell.ts",
    '"../lib/scroll-advance"': "src/lib/scroll-advance.ts",
    '"../lib/reading-layout"': "src/lib/reading-layout.ts",
    '"../lib/account-key"': "src/lib/account-key.ts",
    '"../lib/add-feeds"': "src/lib/add-feeds.ts",
  });

const buildThemeModule = () =>
  buildRunesModule("theme.svelte.ts", "theme.mjs", { '"../lib/theme"': "src/lib/theme.ts" });

const buildFloodsModule = () =>
  buildRunesModule("floods.svelte.ts", "floods.mjs", { '"../lib/floods"': "src/lib/floods.ts" });

function buildReaderModule() {
  const source = readFileSync(join(ROOT, "src/state/reader.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "reader.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "reader.svelte.ts" });

  return compiled.js.code
    .replaceAll('"../api/freshrss"', JSON.stringify(absolute("src/api/freshrss.ts")))
    .replaceAll('"../api/hardlyread"', JSON.stringify(absolute("src/api/hardlyread.ts")))
    .replaceAll('"../api/transport"', JSON.stringify(absolute("src/api/transport.ts")))
    .replaceAll('"../api/backend"', JSON.stringify(absolute("src/api/backend.ts")))
    .replaceAll('"../api/greader-backend"', JSON.stringify(absolute("src/api/greader-backend.ts")))
    .replaceAll('"../api/profile"', JSON.stringify(absolute("src/api/profile.ts")))
    .replaceAll('"../lib/reading-order"', JSON.stringify(absolute("src/lib/reading-order.ts")))
    .replaceAll('"../lib/feed-order"', JSON.stringify(absolute("src/lib/feed-order.ts")))
    .replaceAll('"../lib/capabilities"', JSON.stringify(absolute("src/lib/capabilities.ts")))
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"../lib/stream-loads"', JSON.stringify(absolute("src/lib/stream-loads.ts")))
    .replaceAll('"../lib/stream-perf"', JSON.stringify(absolute("src/lib/stream-perf.ts")))
    .replaceAll('"../lib/stream-scroll"', JSON.stringify(absolute("src/lib/stream-scroll.ts")))
    .replaceAll('"./reading.svelte"', JSON.stringify(buildReadingModule()))
    .replaceAll('"./theme.svelte"', JSON.stringify(buildThemeModule()))
    .replaceAll('"./floods.svelte"', JSON.stringify(buildFloodsModule()))
    .replaceAll('"../lib/stream-cycle"', JSON.stringify(absolute("src/lib/stream-cycle.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"../lib/sync-progress"', JSON.stringify(absolute("src/lib/sync-progress.ts")))
    .replaceAll('"../lib/place"', JSON.stringify(absolute("src/lib/place.ts")))
    .replaceAll('"../lib/sidebar-doc"', JSON.stringify(absolute("src/lib/sidebar-doc.ts")))
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
    .replaceAll('"../lib/feed-move"', JSON.stringify(absolute("src/lib/feed-move.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")))
    .replaceAll('"../lib/extract-ledger"', JSON.stringify(absolute("src/lib/extract-ledger.ts")))
    .replaceAll('"../lib/full-text"', JSON.stringify(absolute("src/lib/full-text.ts")));
}

/* ---------------------------------------------------------------------------
 * A device's storage, and a server that answers by rule
 * ------------------------------------------------------------------------ */

function makeStorage() {
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
  };
}

/** `apiPath` is the whole difference between the four servers below. */
const FRESHRSS = {
  serverUrl: "https://rss.example.test",
  apiPath: "/api/greader.php",
  email: "ada@example.test",
  token: "not-a-real-token",
};
const MINIFLUX = {
  serverUrl: "https://miniflux.example.test",
  apiPath: "/v1/reader/api/0",
  email: "ada@example.test",
  token: "not-a-real-token",
};
const OLD_READER = {
  serverUrl: "https://theoldreader.example.test",
  apiPath: "/reader/api/0",
  email: "ada@example.test",
  token: "not-a-real-token",
};

const EXTENDED = [
  "categoryOrder",
  "feedOrder",
  "hiddenCategories",
  "pinnedCategories",
  "preferences",
  "readingPosition",
];

const SUBSCRIPTIONS = [
  {
    id: "feed/1",
    title: "Ars Technica",
    url: "https://example.invalid/1",
    categories: [{ id: "user/-/label/Technology", label: "Technology" }],
  },
  {
    id: "feed/2",
    title: "MoMA",
    url: "https://example.invalid/2",
    categories: [{ id: "user/-/label/Art", label: "Art" }],
  },
];

/**
 * A server that answers the way one of the four does.
 *
 * `state` is the whole of what differs between a FreshRSS with the extensions, a
 * FreshRSS without them, and a service that has no adapter at all.
 */
function installServer(state) {
  const server = { requests: [], state };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    server.requests.push({ method, url });

    if (url.includes("/v1/state")) {
      if (server.state.kind === "missing") {
        return json(404, { ok: false, error: { code: "route_not_found", message: "Unknown route." } });
      }
      return json(200, server.state.body);
    }
    if (url.includes("/v1/positions")) {
      if (server.state.kind === "missing") {
        return json(404, { ok: false, error: { code: "route_not_found", message: "Unknown route." } });
      }
      return json(200, { apiVersion: 1, updatedAt: 0, categories: [], feeds: [] });
    }
    if (url.includes("/subscription/list")) return json(200, { subscriptions: SUBSCRIPTIONS });
    if (url.includes("/tag/list")) return json(200, { tags: [] });
    if (url.includes("/unread-count")) return json(200, { unreadcounts: [] });
    if (url.includes("/stream/contents")) return json(200, { items: [], continuation: null });
    if (url.includes("/user-info")) return json(200, { userId: "u1", userName: "ada" });
    return json(404, { ok: false });
  };
  return server;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The three shapes of `/v1/state` a FreshRSS can answer with. */
const STATE_WITH_EXTENSIONS = {
  kind: "answered",
  body: {
    apiVersion: 1,
    hiddenCategories: {
      available: true,
      mode: "strict",
      view: "hidden",
      effectiveView: "hidden",
      hiddenIds: [],
      locked: false,
      hasPasscode: false,
      categories: [],
    },
    favorites: { available: true, view: "all", ids: [], categories: [] },
    sidebarIndent: { available: true, px: 18 },
    peopleAvailable: false,
  },
};

/**
 * The adapter is on, the two block extensions are off for this account.
 *
 * Not "the extensions are off" — the adapter itself answered, so its own routes
 * (the arrangement, the preferences document) really are there. Only the two
 * block-level features are missing, and only those may fall back to the device.
 */
const STATE_BLOCKS_OFF = {
  kind: "answered",
  body: {
    apiVersion: 1,
    hiddenCategories: { available: false },
    favorites: { available: false },
    sidebarIndent: { available: false },
    peopleAvailable: false,
  },
};

/** No adapter at all — the same `404` a disabled or absent extension gives. */
const STATE_MISSING = { kind: "missing", body: null };

let device = makeStorage();
let ReaderState;

/** One reader on one server, started the way the app starts it. */
async function readerOn(session, { state = STATE_MISSING, storage = device } = {}) {
  globalThis.localStorage = storage;
  const server = installServer(state);
  const reader = new ReaderState();
  await reader.start(session);
  return { reader, server };
}

/** The four extra words, in one readable list for a failure message. */
const extras = (reader) =>
  EXTENDED.map((feature) => `${feature}:${reader.featureAuthority(feature)}`).join(" ");
const allAre = (reader, authority) =>
  EXTENDED.every((feature) => reader.featureAuthority(feature) === authority);

mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(join(GEN_DIR, "reader.mjs"), buildReaderModule());

try {
  ({ ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader.mjs")).href));

  /* -------------------------------------------------------------------------
   * 1. FreshRSS with the extensions: everything is the backend's, free
   * ---------------------------------------------------------------------- */

  {
    device = makeStorage();
    const { reader } = await readerOn(FRESHRSS, { state: STATE_WITH_EXTENSIONS });

    check(
      "a FreshRSS with the extensions keeps every extra itself",
      allAre(reader, "backend"),
      extras(reader),
    );
    check(
      "...including the place, which is the one the ladder used to have no answer for",
      reader.featureAuthority("readingPosition") === "backend",
    );
    check(
      "and the section says buying adds nothing",
      reader.upgradePitch === "nothing",
      reader.upgradePitch,
    );

    // Buying changes no answer: the server already carries all of it, so a paid
    // reader's extras must not move to the cloud behind their back.
    reader.paid = true;
    check("paying moves nothing: the server is still the authority", allAre(reader, "backend"), extras(reader));
    check("and the pitch stays the honest one", reader.upgradePitch === "nothing", reader.upgradePitch);
  }

  /* -------------------------------------------------------------------------
   * 2. The Old Reader and Miniflux: local when free, cloud when paid
   * ---------------------------------------------------------------------- */

  for (const [name, session] of [
    ["The Old Reader", OLD_READER],
    ["Miniflux", MINIFLUX],
  ]) {
    device = makeStorage();
    const { reader } = await readerOn(session, { state: STATE_MISSING });

    check(`${name}: no extra is the backend's on a free account`, allAre(reader, "local"), extras(reader));
    check(`${name}: and buying would move them to the cloud`, (() => {
      reader.paid = true;
      const moved = allAre(reader, "cloud");
      reader.paid = false;
      return moved;
    })(), extras(reader));
    check(`${name}: the section offers the extras, not a mirror`, reader.upgradePitch === "extras", reader.upgradePitch);
  }

  {
    device = makeStorage();
    const { reader, server } = await readerOn(MINIFLUX, { state: STATE_MISSING });

    // The free case has to *work* on that device, not merely resolve. Three of
    // the extras, one press each, and no request anywhere near them.
    const launched = server.requests.length;
    await reader.setCategoryHidden("Technology", true);
    check("free on a service without extensions: a category hides", reader.isCategoryHidden("Technology"));
    check(
      "...which is what the sidebar is filtered by",
      reader.categories.map((group) => group.label).join(",") === "Art",
      reader.categories.map((group) => group.label).join(","),
    );

    await reader.setCategoryPinned("Art", true);
    check("...a category pins", reader.isCategoryPinned("Art"));
    await reader.cyclePinView();
    check("...and the pin view cycles on this device", reader.pinView === "only", reader.pinView);

    check(
      "none of those presses asked the server for anything",
      server.requests.length === launched,
      server.requests.slice(launched).map((entry) => `${entry.method} ${entry.url}`).join(", "),
    );
  }

  {
    // The place: written where the reader was, read back on the next launch,
    // with no server route involved at all.
    device = makeStorage();
    writePlace(device, { serverUrl: MINIFLUX.serverUrl, email: MINIFLUX.email }, {
      streamId: "feed/1",
      streamTitle: "Ars Technica",
      articleId: null,
      expandedFeedId: null,
      articleScroll: 0,
      listScroll: 0,
    });
    const { reader } = await readerOn(MINIFLUX, { state: STATE_MISSING });

    check("free on a service without extensions: the place resumes", reader.activeStream === "feed/1", reader.activeStream);
    check("...on the feed it names", reader.activeTitle === "Ars Technica", reader.activeTitle);
  }

  /* -------------------------------------------------------------------------
   * 3. A library on this device: the backend is the device, and paying mirrors
   * ---------------------------------------------------------------------- */

  {
    device = makeStorage();
    globalThis.localStorage = device;
    const store = new LocalStore(new MemoryDatabase());
    const reader = new ReaderState();
    await reader.start(localProfile(new LocalBackend(store)));

    check("a local library keeps every extra itself", allAre(reader, "backend"), extras(reader));
    check("...and the section offers the mirror, not the extras", reader.upgradePitch === "mirror", reader.upgradePitch);

    reader.paid = true;
    check("paying does not move a single feature off the library", allAre(reader, "backend"), extras(reader));
    check("...it adds the mirror", reader.upgradePitch === "mirror", reader.upgradePitch);
  }

  /* -------------------------------------------------------------------------
   * 4. FreshRSS without the extensions: local/cloud, never backend
   * ---------------------------------------------------------------------- */

  for (const [name, state] of [
    ["absent", STATE_MISSING],
    ["installed but switched off", STATE_MISSING],
  ]) {
    device = makeStorage();
    const { reader } = await readerOn(FRESHRSS, { state });

    check(`FreshRSS with the extensions ${name}: no extra is the backend's`, allAre(reader, "local"), extras(reader));
    check(`...and buying would move them to the cloud`, (() => {
      reader.paid = true;
      const moved = allAre(reader, "cloud");
      reader.paid = false;
      return moved;
    })(), extras(reader));
    check(`...so the section offers the extras`, reader.upgradePitch === "extras", reader.upgradePitch);

    // And the feature still works, on the device, on that server.
    await reader.setCategoryHidden("Technology", true);
    check(`FreshRSS with the extensions ${name}: hiding still works here`, reader.isCategoryHidden("Technology"));
  }

  {
    // The narrowed case, asserted precisely: the adapter answered, so what its own
    // routes carry stays the backend's; only the two missing blocks fall back.
    device = makeStorage();
    const { reader } = await readerOn(FRESHRSS, { state: STATE_BLOCKS_OFF });

    check(
      "an adapter that is on while both block extensions are off keeps its own routes",
      ["categoryOrder", "feedOrder", "preferences", "readingPosition"].every(
        (feature) => reader.featureAuthority(feature) === "backend",
      ),
      extras(reader),
    );
    check(
      "...and hands only the two missing blocks to this device",
      ["hiddenCategories", "pinnedCategories"].every(
        (feature) => reader.featureAuthority(feature) === "local",
      ),
      extras(reader),
    );
  }

  /* -------------------------------------------------------------------------
   * The place: the device's under every authority, and never a second writer
   * ---------------------------------------------------------------------- */

  {
    device = makeStorage();
    const { reader } = await readerOn(FRESHRSS, { state: STATE_WITH_EXTENSIONS });
    const somewhere = {
      streamId: "feed/2",
      streamTitle: "MoMA",
      articleId: null,
      expandedFeedId: null,
      articleScroll: 0,
      listScroll: 0,
    };
    const before = reader.placeDoc().streamId;
    reader.adoptPlace(somewhere);
    check(
      "a place from a document does not overwrite one a server owns",
      reader.placeDoc().streamId === before,
      `${before} -> ${reader.placeDoc().streamId}`,
    );

    // The device's own place, on a service where the place is this device's: the
    // document is exactly how the other device's place arrives.
    device = makeStorage();
    const free = await readerOn(MINIFLUX, { state: STATE_MISSING });
    free.reader.adoptPlace(somewhere);
    check(
      "...while a service that keeps no place takes it from the document",
      free.reader.placeDoc().streamId === "feed/2",
      free.reader.placeDoc().streamId,
    );
  }

  /* -------------------------------------------------------------------------
   * The acceptance: nothing else re-implements the ladder
   * ---------------------------------------------------------------------- */

  {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|svelte)$/.test(entry.name)) continue;
        files.push(path);
      }
    };
    walk("src");

    const callers = files.filter((path) => /resolveAuthority\s*\(/.test(readFileSync(join(ROOT, path), "utf8")));
    check(
      "the ladder is called from the module that defines it and from the reader, nowhere else",
      callers.sort().join(",") === "src/lib/capabilities.ts,src/state/reader.svelte.ts",
      callers.join(","),
    );

    const reader = readFileSync(join(ROOT, "src/state/reader.svelte.ts"), "utf8");
    check("the reader asks it in one place", (reader.match(/resolveAuthority\s*\(/g) ?? []).length === 1);
    check(
      "and that place is `featureAuthority`, which every extra asks",
      /featureAuthority\(feature: Feature\): Authority \{\s*return resolveAuthority\(/.test(reader),
    );
    // `atBackend()` is the same question with the boolean taken off it, so both
    // spellings count as the feature asking the resolver.
    const asks = reader.match(/(?:featureAuthority|atBackend)\("(\w+)"\)/g) ?? [];
    for (const feature of EXTENDED) {
      check(`...including ${feature}`, asks.some((call) => call.includes(`"${feature}"`)));
    }

    // The old hand-made rule is gone from the store: no reader getter derives
    // the hidden authority from the extension's own `available` flag.
    check(
      "the store no longer derives an authority from what a block reports",
      !/authorityOf\(/.test(reader) && !/hiddenAuthority\(\s*this\.hiddenCategories/.test(reader),
    );
  }
} finally {
  if (failures > 0) {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(1);
  }
  console.log(`\n${checks} checks passed`);
}
