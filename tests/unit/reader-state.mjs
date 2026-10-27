/**
 * Headless checks for the ReaderState wiring of hidden-categories state.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/reader-state.mjs
 *
 * `reader.svelte.ts` is a runes module, so Node cannot import it directly: it
 * is type-stripped with the project's TypeScript, compiled with Svelte's
 * `compileModule`, and imported from a throwaway directory inside the project
 * (so `svelte/reactivity` still resolves). Nothing here touches a network or a
 * GUI; the API layer is replaced by assigning state directly.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { scopedKey } from "../../src/lib/account-key.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/**
 * Renders the runes module into plain ESM.
 *
 * Relative specifiers are rewritten to absolute file URLs, because the generated
 * file does not sit next to the original. `svelte/reactivity` stays bare and
 * resolves from the project's node_modules.
 */
/**
 * The reading preferences are a runes module too, and the reader imports them,
 * so they need the same treatment: compiled to plain ESM and pointed at from an
 * absolute path.
 */
function buildReadingModule() {
  const source = readFileSync(join(ROOT, "src/state/reading.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "reading.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "reading.svelte.ts" });
  const code = compiled.js.code
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
  const out = join(GEN_DIR, "reading.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

/**
 * The theme is a runes module the reader imports, so it is compiled the same
 * way and pointed at by absolute path from the generated reader.
 */
function buildThemeModule() {
  const source = readFileSync(join(ROOT, "src/state/theme.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "theme.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "theme.svelte.ts" });
  const code = compiled.js.code.replaceAll(
    '"../lib/theme"',
    JSON.stringify(absolute("src/lib/theme.ts")),
  );
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "theme.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

/**
 * The flood store is a runes module the reader imports, so it is compiled the
 * same way and pointed at by absolute path.
 */
function buildFloodsModule() {
  const source = readFileSync(join(ROOT, "src/state/floods.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "floods.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "floods.svelte.ts" });
  const code = compiled.js.code.replaceAll(
    '"../lib/floods"',
    JSON.stringify(absolute("src/lib/floods.ts")),
  );
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "floods.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

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
    .replaceAll('"../lib/stream-loads"', JSON.stringify(absolute("src/lib/stream-loads.ts")))
    .replaceAll('"../lib/stream-perf"', JSON.stringify(absolute("src/lib/stream-perf.ts")))
    .replaceAll('"../lib/stream-scroll"', JSON.stringify(absolute("src/lib/stream-scroll.ts")))
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")))
    .replaceAll('"../lib/extract-ledger"', JSON.stringify(absolute("src/lib/extract-ledger.ts")))
    .replaceAll('"../lib/full-text"', JSON.stringify(absolute("src/lib/full-text.ts")));
}

function subscription(id, title, label) {
  return {
    id,
    title,
    url: `https://example.invalid/${id}`,
    categories: label === null ? [] : [{ id: `user/-/label/${label}`, label }],
  };
}

const { parseState } = await import(absolute("src/api/hardlyread.ts"));

const state = (overrides = {}) =>
  parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [12],
    locked: false,
    categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ],
    ...overrides,
  });

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "reader.mjs");
writeFileSync(generated, buildReaderModule());

try {
  const { ReaderState } = await import(pathToFileURL(generated).href);
  const labels = (groups) => groups.map((group) => group.label).join(",");

  const reader = new ReaderState();
  reader.subscriptions = [
    subscription("feed/1", "Ars Technica", "Technology"),
    subscription("feed/2", "MoMA", "Art"),
    subscription("feed/3", "Untagged", null),
  ];

  check("allCategories lists every group", labels(reader.allCategories) === "Art,Technology,Uncategorized", labels(reader.allCategories));
  check("an install without the extension filters nothing", labels(reader.categories) === "Art,Technology,Uncategorized");
  check("no extension means hiddenAvailable is false", reader.hiddenAvailable === false);
  check("no extension means the default view", reader.hiddenView === "hidden");
  check("a feed without categories lands in Uncategorized", reader.allCategories.some((group) => group.label === "Uncategorized"));

  reader.hiddenCategories = state();
  check("hidden view drops the hidden category", labels(reader.categories) === "Art,Uncategorized", labels(reader.categories));
  check("allCategories still knows about it", reader.allCategories.length === 3);
  check("hiddenAvailable is true once the server says so", reader.hiddenAvailable === true);
  check("categoryId maps a GReader label to the numeric id", reader.categoryId("user/-/label/Technology") === 12);
  check("categoryId maps a bare label", reader.categoryId("Art") === 7);
  check("categoryId is null for Uncategorized", reader.categoryId("user/-/label/Uncategorized") === null);

  reader.hiddenCategories = state({ view: "revealed", effectiveView: "revealed" });
  check("revealed view keeps everything", labels(reader.categories) === "Art,Technology,Uncategorized", labels(reader.categories));

  reader.hiddenCategories = state({ view: "only", effectiveView: "only" });
  check("only view keeps just the hidden category", labels(reader.categories) === "Technology", labels(reader.categories));

  reader.hiddenCategories = state({ view: "revealed", effectiveView: "hidden", locked: true });
  check("locked state uses effectiveView, not the stored view", labels(reader.categories) === "Art,Uncategorized", labels(reader.categories));
  check("hiddenView reports effectiveView", reader.hiddenView === "hidden");

  reader.hiddenCategories = parseState({ available: false });
  check("a server that reports the extension gone filters nothing again", labels(reader.categories) === "Art,Technology,Uncategorized");


  // Stream cache: returning to a stream you just visited must not hit the network.
  // This is the behaviour behind "switching categories feels slow" — it is
  // measured here as a request count, not as a feeling.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [], continuation: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  reader.session = { serverUrl: "https://example.invalid", token: "token", username: "user" };

  await reader.openStream("feed/1", "Ars Technica");
  check("a cold stream costs one request", calls.length === 1, `calls=${calls.length}`);
  await reader.openStream("feed/2", "MoMA");
  check("switching to a different stream costs one more", calls.length === 2, `calls=${calls.length}`);
  await reader.openStream("feed/1", "Ars Technica");
  check("returning to a cached stream costs nothing", calls.length === 2, `calls=${calls.length}`);
  check("and is reported as a cache hit", reader.lastStreamSource === "cache", reader.lastStreamSource);


  // A slow stream must not leave the previous stream's articles on screen: that
  // reads as "the click did nothing".
  let releasePending;
  globalThis.fetch = () => new Promise((resolve) => { releasePending = resolve; });
  const pending = reader.openStream("feed/3", "Untagged");
  check("switching drops the previous stream's items immediately", reader.items.length === 0, `items=${reader.items.length}`);
  check("and says it is loading", reader.loadingList === true);
  // The disk lookup comes first; let it settle so the network request is made.
  for (let i = 0; i < 20 && releasePending === undefined; i += 1) await new Promise((r) => setTimeout(r, 0));
  releasePending(new Response(JSON.stringify({ items: [], continuation: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  await pending;
  check("the pending load settles", reader.loadingList === false);

// --- continuous reading: both directions, wrapping, and stopping ------------
// The rule is "there is no dead end except an empty unread view". That is a
// statement about the reader's own walk, so it is checked here against a fake
// server rather than inferred from the arithmetic in stream-cycle.ts.
{
  const { reading } = await import(buildReadingModule());

  const post = (feed, id) => ({
    id,
    title: id,
    categories: [],
    origin: { streamId: feed, title: feed },
    timestampUsec: "1700000000000000",
    published: 1700000000,
    summary: { content: "" },
  });

  const READING_LIST_ID = "user/-/state/com.google/reading-list";
  const byStream = {
    [READING_LIST_ID]: [post("feed/1", "r1"), post("feed/2", "r2")],
    "feed/1": [post("feed/1", "a1")],
    "feed/2": [post("feed/2", "b1")],
    "feed/3": [post("feed/3", "c1")],
  };

  const seen = [];
  globalThis.fetch = async (url) => {
    const text = decodeURIComponent(String(url));
    seen.push(text);
    if (text.includes("edit-tag")) {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    const key = text.replace(/^.*stream\/contents\//, "").split("?")[0];
    return new Response(JSON.stringify({ id: key, items: byStream[key] ?? [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const r = new ReaderState();
  r.session = { serverUrl: "https://example.invalid", token: "token", username: "user" };
  r.subscriptions = [
    subscription("feed/1", "First", "Tech"),
    subscription("feed/2", "Second", "Tech"),
    subscription("feed/3", "Third", "Tech"),
  ];
  reading.setArticleFilter("all");
  reading.autoMarkRead = false;

  const order = r.traversalStreams.map((stream) => stream.id);
  check("traversal covers the reading list, starred, then the feeds", order.length === 5, order.join(" "));

  // Forwards at the end of a feed: into the next feed, on its first post.
  await r.openStream("feed/1", "First");
  const a1 = r.listItems[0];
  r.select(a1);
  const taggedOnSelect = seen.filter((url) => url.includes("edit-tag")).length;
  await r.advanceArticle(1);
  check("the end of a feed goes to the next feed", r.activeStream === "feed/2", r.activeStream);
  check("and lands on its first post", r.selectedId === "b1", String(r.selectedId));
  check("opening a post does not mark it read while auto-mark is off", taggedOnSelect === 0, `edit-tag calls=${taggedOnSelect}`);

  // Backwards at the start of a feed: into the previous feed, on its last post.
  await r.openStream("feed/2", "Second");
  r.select(r.listItems[0]);
  await r.advanceArticle(-1);
  check("the start of a feed goes back to the previous feed", r.activeStream === "feed/1", r.activeStream);
  check("and lands on its last post", r.selectedId === "a1", String(r.selectedId));
  check("arriving upwards opens the post at its end", r.landingEdge === "bottom", r.landingEdge);
  check("arriving downwards opens it at the top", (r.select(r.listItems[0]), r.landingEdge === "top"));

  // The last post of the last feed wraps to the first stream, not to nothing.
  await r.openStream("feed/3", "Third");
  r.select(r.listItems[0]);
  await r.advanceArticle(1);
  check("the last feed wraps round to the first stream", r.activeStream === READING_LIST_ID, r.activeStream);
  check("and lands on a post there", r.selectedId === "r1", String(r.selectedId));

  // ...and backwards from the very first post wraps to the very last feed.
  await r.advanceArticle(-1);
  check("the first stream wraps back to the last feed", r.activeStream === "feed/3", r.activeStream);
  check("landing on its last post", r.selectedId === "c1", String(r.selectedId));

  // A collapsed category is out of the walk: its feeds are not on screen.
  const categoryId = r.categories[0].id;
  r.collapsedCategories = { [categoryId]: true };
  const collapsedOrder = r.traversalStreams.map((stream) => stream.id);
  check("a folded category leaves the walk", !collapsedOrder.includes("feed/1"), collapsedOrder.join(" "));
  r.collapsedCategories = {};

  // The unread view is the one place the walk can end: nothing anywhere.
  reading.setArticleFilter("unread");
  r.counts = new Map([
    [READING_LIST_ID, 0],
    ["feed/1", 0],
    ["feed/2", 0],
    ["feed/3", 0],
  ]);
  await r.openStream("feed/3", "Third");
  r.select(r.listItems[0]);
  await r.advanceArticle(1);
  check("a cleared unread view stops instead of looping", r.traversalEnded === true, String(r.traversalEnded));
  check("and stays where it was", r.activeStream === "feed/3", r.activeStream);

  // With unread posts elsewhere it keeps going instead of stopping.
  r.traversalEnded = false;
  r.counts = new Map([[READING_LIST_ID, 2]]);
  await r.advanceArticle(1);
  check("an unread post somewhere else keeps the walk going", r.activeStream === READING_LIST_ID, r.activeStream);
  check("and the end flag is cleared", r.traversalEnded === false);

  // Marking read in the unread view drops the post from the list, so the reader
  // must land on the next one rather than on a post it can no longer show.
  await r.openStream(READING_LIST_ID, "Reading list");
  r.select(r.listItems[0]);
  const beforeMark = seen.filter((url) => url.includes("edit-tag")).length;
  await r.markRead(r.listItems[0]);
  check("marking read sends the tag change", seen.filter((url) => url.includes("edit-tag")).length === beforeMark + 1);
  check("the marked post leaves the unread list", !r.listItems.some((entry) => entry.id === "r1"), r.listItems.map((entry) => entry.id).join(","));
  check("the reader moves to the next post", r.selectedId === "r2", String(r.selectedId));

  // Turning the dwell rule on without a post open must not arm anything.
  reading.autoMarkRead = false;
  r.closeReader();
  r.syncDwell();
  check("no post, no timer", r.dwellTimer === null || r.dwellTimer === undefined);


  // --- the dwell itself -----------------------------------------------------
  // Three seconds without moving, and only when asked for. The timer is captured
  // rather than waited out, so the suite stays fast and still proves the delay
  // and the firing.
  {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let armed = null;
    globalThis.setTimeout = (fn, ms) => {
      armed = { fn, ms };
      return 1;
    };
    globalThis.clearTimeout = () => {
      armed = null;
    };
    try {
      await r.openStream(READING_LIST_ID, "Reading list");
      const open = r.listItems[0];
      r.select(open);
      check("with the preference off, nothing is armed", armed === null);

      reading.autoMarkRead = true;
      r.syncDwell();
      check("switching the preference on arms the post already open", armed?.ms === 3000, String(armed?.ms));

      reading.autoMarkRead = false;
      r.syncDwell();
      check("switching it off disarms without marking", armed === null);

      reading.autoMarkRead = true;
      r.select(open);
      check("opening a post arms a three-second timer by default", armed?.ms === 3000, String(armed?.ms));

      reading.setAutoMarkSeconds(9);
      r.select(open);
      check("the configured delay is the one used", armed?.ms === 9000, String(armed?.ms));
      check("the preference is remembered", reading.autoMarkSeconds === 9, String(reading.autoMarkSeconds));
      reading.setAutoMarkSeconds(45);
      check("a delay beyond the slider is kept", reading.autoMarkSeconds === 45, String(reading.autoMarkSeconds));
      reading.setAutoMarkSeconds(9999);
      check("an absurd delay is clamped", reading.autoMarkSeconds === 600, String(reading.autoMarkSeconds));
      reading.setAutoMarkSeconds(3);
      r.select(open);
      const before = seen.filter((url) => url.includes("edit-tag")).length;
      armed.fn();
      await new Promise((resolve) => realSetTimeout(resolve, 20));
      const after = seen.filter((url) => url.includes("edit-tag")).length;
      check("the post is marked read when the timer fires", after === before + 1, `${before}->${after}`);

      // Moving on before it fires must cancel, not mark the old post later.
      const later = r.listItems.find((entry) => !["r1", "r2"].includes(entry.id)) ?? r.listItems[0];
      r.select(later);
      const armedForLater = armed;
      r.closeReader();
      check("leaving the post cancels its timer", armed === null, String(armedForLater?.ms));

      {
    // A pasted list: each distinct URL is sent once, in order, and the sidebar is
    // reloaded once at the end rather than once per feed.
    const edits = [];
    let listCalls = 0;
    globalThis.fetch = async (url, init) => {
      const text = decodeURIComponent(String(url));
      if (text.includes("/subscription/list")) {
        listCalls += 1;
        return new Response(JSON.stringify({ subscriptions: [subscription("feed/1", "First", "Tech")] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (text.includes("/subscription/edit")) {
        const body = decodeURIComponent(String(init?.body ?? ""));
        edits.push(body);
        if (body.includes("broken.example")) {
          return new Response("Could not reach the feed.", { status: 400 });
        }
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("write-token", { status: 200, headers: { "Content-Type": "text/plain" } });
    };

    const r = new ReaderState();
    r.session = { serverUrl: "https://example.invalid", token: "token", username: "user" };
    const result = await r.addFeeds(
      "https://a.example/1\nhttps://b.example/2\nhttps://broken.example/3\nhttps://A.example/1\n",
    );

    check("a pasted list adds every feed that works", result.added.length === 2, result.added.join(" "));
    check("...reports the one that did not", result.failed.length === 1, result.failed[0]?.url ?? "");
    check("...does not send the duplicate twice", edits.length === 3, `${edits.length} requests`);
    check("...keeps the pasted order", /a\.example/.test(edits[0]) && /broken\.example/.test(edits[2]));
    check("...reloads the sidebar once, not once per feed", listCalls === 1, `${listCalls} list calls`);
    check("...releases the busy flag", r.feedBusy === false);
    check("...clears the progress readout", r.feedProgress === null);
    check(
      "...names the failure in the server's words",
      /Added 2, 1 feed failed — https:\/\/broken\.example\/3: .*Could not reach the feed\./.test(r.addFeedError ?? ""),
      r.addFeedError ?? "(none)",
    );
}

} finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      reading.autoMarkRead = false;
    }
  }

  reading.setArticleFilter("all");
}

// --- collapsed categories roundtrip ----------------------------------------
// "It should stay collapsed" is a promise about a *new* instance, not about the
// one that was clicked, so this checks the stored preference after a relaunch.
{
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const session = { serverUrl: "https://reader.test", email: "u@reader.test" };
    const first = new ReaderState();
    first.session = session;
    first.toggleCategory("category/1");
    const key = scopedKey("hardlyreader.prefs.v1", session);
    const written = JSON.parse(store.get(key) ?? "null");
    check("collapsing a category writes the preference", written?.collapsed?.["category/1"] === true);

    const second = new ReaderState();
    second.session = session;
    second.loadPrefs();
    check("a new instance starts with the category still collapsed", second.isCategoryCollapsed("category/1") === true);

    first.toggleCategory("category/1");
    const third = new ReaderState();
    third.session = session;
    third.loadPrefs();
    check("expanding persists as well", third.isCategoryCollapsed("category/1") === false);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
}

// --- how read state is decided --------------------------------------------
// Manual is what a fresh install gets, and the old bare `autoMarkRead` boolean
// is not honoured: it was one icon beside the star, and it sat on
// without being meant to. Only an explicit mode counts.
{
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const KEY = "hardlyreader.reading.v1";
  const { reading: prefs } = await import(buildReadingModule());
  const before = prefs.autoMarkRead;
  try {
    prefs.autoMarkRead = false;
    store.clear();
    prefs.load();
    check("with nothing saved, posts stay unread until you say so", prefs.autoMarkRead === false);

    store.set(KEY, JSON.stringify({ autoMarkRead: true }));
    prefs.load();
    check("a leftover auto-marking toggle is not read as a choice", prefs.autoMarkRead === false);

    store.set(KEY, JSON.stringify({ markReadMode: "auto" }));
    prefs.load();
    check("a chosen mode of auto is honoured", prefs.autoMarkRead === true);

    store.set(KEY, JSON.stringify({ markReadMode: "manual" }));
    prefs.load();
    check("a chosen mode of manual is honoured", prefs.autoMarkRead === false);

    store.set(KEY, JSON.stringify({ markReadMode: "sometimes" }));
    prefs.load();
    check("nonsense falls back to manual", prefs.autoMarkRead === false);

    prefs.setAutoMarkRead(true);
    const written = JSON.parse(store.get(KEY) ?? "null");
    check("choosing auto is written as a mode, not a loose flag", written?.markReadMode === "auto", String(written?.markReadMode));
    check("...and no stale flag rides along", !("autoMarkRead" in (written ?? {})), JSON.stringify(written?.autoMarkRead));
  } finally {
    prefs.autoMarkRead = before;
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
}

  // Action feedback: the burst of light starts where the click was, and only for
  // actions that actually change something.
  const { floods } = await import(buildFloodsModule());
  floods.clear();
  reader.menu = { x: 141, y: 322, target: { kind: "category", label: "Technology" }, confirming: false };
  try {
    await reader.applyMenuAction({ type: "hidden", hidden: true });
  } catch {
    // the write wants a transport; the flood is emitted before it is attempted
  }
  check(
    floods.floods.length === 1 &&
      floods.floods[0].kind === "hidden" &&
      floods.floods[0].x === 141 &&
      floods.floods[0].y === 322,
    `hiding a category flashes from the click point (${JSON.stringify(floods.floods)})`,
  );

  floods.clear();
  reader.menu = { x: 90, y: 210, target: { kind: "feed", id: "feed/2" }, confirming: false };
  await reader.applyMenuAction({ type: "pin", pinned: true });
  check(floods.floods[0]?.kind === "pin", "pinning a feed flashes too");

  floods.clear();
  reader.menu = { x: 90, y: 210, target: { kind: "feed", id: "feed/2" }, confirming: false };
  await reader.applyMenuAction({ type: "confirm-remove" });
  check(floods.floods.length === 0, "a menu step that changes nothing flashes nothing");
  reader.menu = null;
  floods.clear();

  reader.stop();
  check("stop() resets hidden state", reader.hiddenAvailable === false && reader.hiddenError === null);

  // FreshRSS answers unread-count per label and per feed, and leaves the starred
  // stream out. A row that prints `countFor` there prints a zero nobody said.
  {
    const counts = new ReaderState();
    counts.setCounts([
      { id: "user/-/state/com.google/reading-list", count: 20 },
      { id: "user/-/label/Uncategorized", count: 20 },
    ]);
    check("a reported count is the count", counts.countFor("user/-/state/com.google/reading-list") === 20);
    check(
      "the starred count is not reported, so it is null and not zero",
      counts.countIfKnown("user/-/state/com.google/starred") === null,
    );
    check("a reported count is known", counts.countIfKnown("user/-/label/Uncategorized") === 20);
  }

  // Where a feed's text comes from: the reader owns the answer, so the pane and
  // the menu cannot each keep their own copy of it.
  {
    const feeds = new ReaderState();
    const id = "feed/https://example.invalid/summary-only";
    check("a feed starts on Auto", feeds.feedExtract(id) === "auto");
    check("and Auto has seen nothing yet", feeds.feedTruncated(id) === false);
    check("a post with no feed is Auto, not a crash", feeds.feedExtract(null) === "auto" && feeds.feedExtract(undefined) === "auto");

    const before = feeds.feedExtractVersion;
    feeds.setFeedExtract(id, "article");
    check("Full webpage is remembered against the feed", feeds.feedExtract(id) === "article");
    check("writing an answer is what invalidates the panes", feeds.feedExtractVersion === before + 1);
    feeds.setFeedExtract(id, "feed");
    check("Feed is remembered too", feeds.feedExtract(id) === "feed");
    feeds.setFeedExtract(id, "auto");
    check("Auto comes back without a stored answer", feeds.feedExtract(id) === "auto");

    // Auto's own verdict does not bump the counter: the post that produced it is
    // the one being fetched, and re-running that fetch would be a second request.
    const settled = feeds.feedExtractVersion;
    feeds.noteFeedTruncated(id);
    check("Auto's verdict lands against the feed", feeds.feedTruncated(id));
    check("...and changes nothing that is drawn", feeds.feedExtractVersion === settled);
    check("a feed the reader has not touched has no verdict", feeds.feedTruncated("feed/https://example.invalid/whole") === false);
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
