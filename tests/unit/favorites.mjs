/**
 * Unit checks for v1.1: favorites, the favorites view, the sidebar indent and
 * add/remove feed.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/favorites.mjs
 *
 * Three layers, no server and no GUI:
 *
 * - the `favorites` / `sidebarIndent` parsers in `src/api/hardlyread.ts`;
 * - the pure view cycle and optimistic merge in `src/state/favorites.ts`;
 * - `ReaderState` end to end, with `globalThis.fetch` replaced by a recorder,
 *   so the wire shape of a favorite write and of subscribe/unsubscribe is
 *   checked request by request. The server URL points at a closed port and is
 *   never dialled.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/** ReaderState is a runes module; compile it the way the app's build would. */
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
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")));
}

const api = await import(absolute("src/api/hardlyread.ts"));
const {
  ApiError,
  SIDEBAR_INDENT_FALLBACK_PX,
  SIDEBAR_INDENT_MAX_PX,
  SIDEBAR_INDENT_MIN_PX,
  clampIndentPx,
  favoriteIdForLabel,
  getApiState,
  isFavoriteCategory,
  parseApiState,
  parseFavorites,
  parseSidebarIndent,
  setCategoryFavorite,
  setFavoritesView,
  unavailableFavorites,
} = api;

const {
  FAVORITE_VIEW_CYCLE,
  applyFavoritesWrite,
  nextFavoriteView,
  withCategoryFavorite,
  withFavoritesView,
} = await import(absolute("src/state/favorites.ts"));

const { categoryMenu, feedMenu } = await import(absolute("src/lib/contextmenu.ts"));

const SESSION = {
  serverUrl: "http://127.0.0.1:18080/",
  email: "itest",
  token: "itest/0123456789abcdef",
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recorder(handler) {
  const calls = [];
  const transport = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return handler(String(input), init);
  };
  return { transport, calls };
}

function favoritesBody(overrides = {}) {
  return {
    available: true,
    view: "all",
    ids: [3],
    categories: [
      { id: 3, name: "Comics", favorite: true },
      { id: 7, name: "Art", favorite: false },
    ],
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * favorites parsing
 * ------------------------------------------------------------------------- */

{
  const state = parseFavorites(favoritesBody());
  check("an available block is available", state.available === true);
  check("the stored view is read", state.view === "all", state.view);
  check("ids stay numbers", state.ids.length === 1 && state.ids[0] === 3 && typeof state.ids[0] === "number");
  check(
    "categories keep id/name/favorite",
    state.categories[1].id === 7 && state.categories[1].name === "Art" && state.categories[1].favorite === false,
    JSON.stringify(state.categories[1]),
  );
}

{
  const state = parseFavorites({ available: false });
  check("available:false yields the unavailable state", state.available === false);
  check("...with no ids and no categories", state.ids.length === 0 && state.categories.length === 0);
  check("...and the default view", state.view === "all", state.view);
  check("unavailableFavorites agrees", JSON.stringify(unavailableFavorites()) === JSON.stringify(state));
}

{
  const state = parseFavorites({
    available: true,
    view: "everything",
    ids: [3, 0, -1, "7", 4.5, null],
    categories: [{ id: 3, name: "Comics" }, { id: 0, name: "Zero" }, "nope", { id: 9, name: 12 }],
  });
  check("junk ids are dropped, never coerced", state.ids.join(",") === "3", state.ids.join(","));
  check("an unknown view falls back to all", state.view === "all", state.view);
  check("junk categories are dropped", state.categories.map((c) => c.id).join(",") === "3,9", state.categories.map((c) => c.id).join(","));
  check("a missing favorite flag reads as false", state.categories[0].favorite === false);
  check("a non-string name becomes an empty string", parseFavorites({ available: true, categories: [{ id: 9, name: 12 }] }).categories[0].name === "");
  check("parseFavorites rejects a non-object", parseFavorites(null).available === false);
}

{
  const state = parseFavorites(favoritesBody());
  check("a label maps to the favorites id", favoriteIdForLabel(state, "user/-/label/Comics") === 3);
  check("the case-insensitive fallback works here too", favoriteIdForLabel(state, "COMICS") === 3);
  check("an unknown label has no favorites id", favoriteIdForLabel(state, "Cooking") === null);
  check("isFavoriteCategory reads the ids", isFavoriteCategory(state, "Comics") === true && isFavoriteCategory(state, "Art") === false);
  check("nothing is a favorite without the extension", isFavoriteCategory(unavailableFavorites(), "Comics") === false);
}

/* ---------------------------------------------------------------------------
 * sidebar indent
 * ------------------------------------------------------------------------- */

check("the fallback is 12px", SIDEBAR_INDENT_FALLBACK_PX === 12);
check("a real value is read as-is", parseSidebarIndent({ available: true, px: 18 }).px === 18);
check("...and reports available", parseSidebarIndent({ available: true, px: 18 }).available === true);
check("a value above the maximum is clamped", clampIndentPx(5000) === SIDEBAR_INDENT_MAX_PX, String(clampIndentPx(5000)));
check("a negative value is clamped to the minimum", clampIndentPx(-40) === SIDEBAR_INDENT_MIN_PX, String(clampIndentPx(-40)));
check("a fraction is rounded", clampIndentPx(12.6) === 13, String(clampIndentPx(12.6)));
check("a string is not trusted", clampIndentPx("9") === SIDEBAR_INDENT_FALLBACK_PX, String(clampIndentPx("9")));
check("null falls back", clampIndentPx(null) === SIDEBAR_INDENT_FALLBACK_PX);
check("NaN falls back", clampIndentPx(Number.NaN) === SIDEBAR_INDENT_FALLBACK_PX);
check("an unavailable block reports the fallback", parseSidebarIndent({ available: false }).px === SIDEBAR_INDENT_FALLBACK_PX);
check("...and says it is unavailable", parseSidebarIndent({ available: false }).available === false);
check("a missing block reports the fallback too", parseSidebarIndent(undefined).px === SIDEBAR_INDENT_FALLBACK_PX);
check("an available block with no px falls back", parseSidebarIndent({ available: true }).px === SIDEBAR_INDENT_FALLBACK_PX);

/* ---------------------------------------------------------------------------
 * the whole state read
 * ------------------------------------------------------------------------- */

{
  const { transport, calls } = recorder(() =>
    jsonResponse(200, {
      apiVersion: 1,
      hiddenCategories: { available: false },
      favorites: favoritesBody(),
      sidebarIndent: { available: true, px: 20 },
    }),
  );
  const state = await getApiState(transport, SESSION);

  check("one request reads every block", calls.length === 1 && calls[0].method === "GET", `${calls.length} request(s)`);
  check("it hits /v1/state", calls[0].url.endsWith("/v1/state"), calls[0].url);
  check("favorites arrive with it", state.favorites.available === true && state.favorites.ids[0] === 3);
  check("the indent arrives with it", state.sidebarIndent.px === 20, String(state.sidebarIndent.px));
  check("a missing hidden block is not fatal", state.hiddenCategories.available === false);
}

{
  const state = parseApiState({ apiVersion: 2 });
  check("a body with no extension blocks defaults everything", state.favorites.available === false && state.sidebarIndent.available === false);
  check("the version is kept", state.apiVersion === 2);
}

/* ---------------------------------------------------------------------------
 * view cycle
 * ------------------------------------------------------------------------- */

check("the cycle is all -> only -> without", FAVORITE_VIEW_CYCLE.join(",") === "all,only,without", FAVORITE_VIEW_CYCLE.join(","));
check("all goes to only", nextFavoriteView("all") === "only");
check("only goes to without", nextFavoriteView("only") === "without");
check("without wraps back to all", nextFavoriteView("without") === "all");
check(
  "three clicks are a full turn",
  (() => {
    let view = "all";
    for (let i = 0; i < 3; i++) view = nextFavoriteView(view);
    return view === "all";
  })(),
);
/* ---------------------------------------------------------------------------
 * optimistic state and changed:false
 * ------------------------------------------------------------------------- */

{
  const before = parseFavorites(favoritesBody({ ids: [], categories: [{ id: 3, name: "Comics", favorite: false }] }));
  const after = withCategoryFavorite(before, 3, true);
  check("favoriting adds the id", after.ids.join(",") === "3", after.ids.join(","));
  check("...and flips the category's own flag", after.categories[0].favorite === true);
  check("the original is not mutated", before.ids.length === 0 && before.categories[0].favorite === false);
}

{
  const before = parseFavorites(favoritesBody({ ids: [3, 7] }));
  const after = withCategoryFavorite(before, 3, false);
  check("unfavoriting removes the id", after.ids.join(",") === "7", after.ids.join(","));
}

{
  const before = parseFavorites(favoritesBody({ ids: [7] }));
  const after = withCategoryFavorite(before, 3, true);
  check("the id list stays sorted", after.ids.join(",") === "3,7", after.ids.join(","));
}

{
  const before = parseFavorites(favoritesBody());
  check("an id the server never reported is left alone", withCategoryFavorite(before, 999, true) === before);
}

{
  const after = withFavoritesView(parseFavorites(favoritesBody()), "without");
  check("a view change applies at once", after.view === "without", after.view);
  check("an unavailable server keeps its state", withFavoritesView(unavailableFavorites(), "only").available === false);
}

{
  // The server was already there: 200 with changed:false is a success, not a no-op to retry.
  const current = parseFavorites(favoritesBody({ ids: [], categories: [{ id: 3, name: "Comics", favorite: false }] }));
  const optimistic = withCategoryFavorite(current, 3, true);
  const server = parseFavorites(favoritesBody({ ids: [3], categories: [{ id: 3, name: "Comics", favorite: true }] }));
  const commits = [];
  const outcome = await applyFavoritesWrite(current, optimistic, (next) => commits.push(next), async () => ({
    changed: false,
    favorites: server,
  }));

  check("changed:false is still applied", outcome.kind === "applied", outcome.kind);
  check("...and reports changed:false", outcome.changed === false, String(outcome.changed));
  check("...with the server's state drawn last", commits.length === 2 && commits[1] === server);
  check("...and no rollback in between", commits[0] === optimistic);
}

{
  const current = parseFavorites(favoritesBody());
  const authoritative = parseFavorites(favoritesBody({ ids: [] }));
  const commits = [];
  const outcome = await applyFavoritesWrite(current, withCategoryFavorite(current, 3, false), (next) => commits.push(next), async () => {
    throw new ApiError(409, "convergence_failed", "sweep failed", null, authoritative);
  });

  check("a favorites 409 reconciles", outcome.kind === "reconciled" && outcome.status === 409, outcome.kind);
  check("...drawing the server's state", commits[1] === authoritative);
}

{
  const current = parseFavorites(favoritesBody());
  const commits = [];
  const outcome = await applyFavoritesWrite(current, withCategoryFavorite(current, 3, false), (next) => commits.push(next), async () => {
    throw new ApiError(409, "favorites_unavailable", "not enabled", null, null);
  });

  check("a stateless favorites failure rolls back", commits[1] === current && outcome.kind === "failed", outcome.kind);
}

/* ---------------------------------------------------------------------------
 * wire shape of the favorite writes
 * ------------------------------------------------------------------------- */

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true, changed: true, favorites: favoritesBody() }));
  const result = await setCategoryFavorite(transport, SESSION, 3, true);

  check("PUT favorite goes to /v1/favorites/{id}", calls[0].url.endsWith("/v1/favorites/3"), calls[0].url);
  check("...with PUT", calls[0].method === "PUT");
  check("...sending explicit state", calls[0].body === JSON.stringify({ favorite: true }), calls[0].body);
  check("...as JSON", calls[0].headers["Content-Type"] === "application/json");
  check("...authenticated by the GReader token", calls[0].headers.Authorization === `GoogleLogin auth=${SESSION.token}`);
  check("the response favorites are parsed", result.favorites.ids[0] === 3);
  check("changed is reported", result.changed === true);
}

{
  const { transport } = recorder(() => jsonResponse(200, { ok: true, changed: false, favorites: favoritesBody() }));
  const result = await setCategoryFavorite(transport, SESSION, 3, true);
  check("a missing-or-false changed is not an error", result.changed === false);
}

{
  const { transport } = recorder(() => jsonResponse(200, { ok: true, favorites: favoritesBody() }));
  const result = await setCategoryFavorite(transport, SESSION, 3, true);
  check("an absent changed reads as null", result.changed === null, String(result.changed));
}

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true, favorites: favoritesBody({ view: "only" }) }));
  await setFavoritesView(transport, SESSION, "only");

  check("PUT favorites view goes to /v1/favorites/view", calls[0].url.endsWith("/v1/favorites/view"), calls[0].url);
  check("...sending the view name", calls[0].body === JSON.stringify({ view: "only" }), calls[0].body);
}

{
  const { transport, calls } = recorder(() => jsonResponse(200, {}));
  try {
    await setCategoryFavorite(transport, SESSION, 0, true);
    check("a zero id is refused before any request", false, "resolved instead of throwing");
  } catch (error) {
    check("a zero id is refused before any request", error instanceof RangeError && calls.length === 0, `${calls.length} request(s)`);
  }
  try {
    await setFavoritesView(transport, SESSION, "everything");
    check("an unknown favorites view is refused", false, "resolved instead of throwing");
  } catch (error) {
    check("an unknown favorites view is refused", error instanceof RangeError && calls.length === 0);
  }
}

{
  const { transport } = recorder(() =>
    jsonResponse(409, {
      ok: false,
      error: { code: "convergence_failed", message: "state saved, sweep failed" },
      favorites: favoritesBody({ ids: [7] }),
    }),
  );
  try {
    await setCategoryFavorite(transport, SESSION, 3, true);
    check("409 convergence_failed carries favorites for reconciliation", false, "resolved instead of throwing");
  } catch (error) {
    check(
      "409 convergence_failed carries favorites for reconciliation",
      error instanceof ApiError && error.code === "convergence_failed" && error.favorites !== null && error.favorites.ids[0] === 7,
      String(error?.code),
    );
    check("...and no hidden state is invented for it", error.state === null);
  }
}

/* ---------------------------------------------------------------------------
 * menu models
 * ------------------------------------------------------------------------- */

const hiddenState = api.parseState({
  available: true,
  mode: "strict",
  view: "hidden",
  effectiveView: "hidden",
  hiddenIds: [],
  locked: false,
  categories: [
    { id: 3, name: "Comics", hidden: false },
    { id: 7, name: "Art", hidden: false },
  ],
});

{
  // One mark, one item. With the extension absent the model falls back to the
  // local mark, and the wording still comes from the theme's vocabulary.
  const menu = categoryMenu(hiddenState, "Comics", false);
  check("a category row offers its mark", menu.pin?.label === "Pin", String(menu.pin?.label));
  check("...enabled", menu.pin?.disabled === false);
  check("...and no note", menu.note === null, String(menu.note));
  check("a marked row offers Unpin", categoryMenu(hiddenState, "Comics", true).pin?.label === "Unpin");
  check(
    "the mark is a pin wherever it is kept",
    categoryMenu(hiddenState, "Comics", false).pin?.action.type === "pin",
  );
  // Whether the extension keeps the mark or this device does is the reader's
  // routing decision, not a second menu item and not a second word: the row
  // offers one item, and the signature has nowhere to pass an alternative.
  check("the model has one mark field and no favourite field", !("favorite" in menu) && menu.pin !== null);
  check("there is one word and one glyph for it", menu.pin?.glyph === "📌");
  check(
    "no argument can bring a star or a favourite back",
    categoryMenu(hiddenState, "Comics", false).pin?.label === "Pin" &&
      categoryMenu(hiddenState, "Comics", false).pin?.glyph === "📌" &&
      categoryMenu.length === 3,
  );
}

{
  const asked = feedMenu("Ars Technica", false);
  check("a feed row offers removal", asked.remove?.label === "Remove feed…", String(asked.remove?.label));
  check("...and no confirmation yet", asked.confirm.length === 0);
  check("...and no hide item", asked.toggle === null);
  check("...but it can be pinned", asked.pin?.label === "Pin");
  check("...and no note before asking", asked.note === null, String(asked.note));

  const confirming = feedMenu("Ars Technica", true);
  check("confirming withdraws the first item", confirming.remove === null);
  check("...offering both answers", confirming.confirm.map((item) => item.label).join(",") === "Remove feed,Cancel", confirming.confirm.map((item) => item.label).join(","));
  check("...with the destructive one first", confirming.confirm[0].action.type === "remove-feed");
  check("...and a warning", /removes the feed/.test(confirming.note ?? ""), String(confirming.note));
}

/* ---------------------------------------------------------------------------
 * ReaderState: favorites, add feed, remove feed
 * ------------------------------------------------------------------------- */

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "reader.mjs");
writeFileSync(generated, buildReaderModule());

try {
  const { ReaderState } = await import(pathToFileURL(generated).href);

  const SERVER = "http://127.0.0.1:18080";
  const FAVORITE_URL = `${SERVER}/api/misc.php/Hardly%20Read/v1/favorites/3`;
  const FAVORITES_VIEW_URL = `${SERVER}/api/misc.php/Hardly%20Read/v1/favorites/view`;
  const TOKEN_URL = `${SERVER}/api/greader.php/reader/api/0/token`;
  const EDIT_URL = `${SERVER}/api/greader.php/reader/api/0/subscription/edit`;
  const SUBSCRIPTIONS_URL = `${SERVER}/api/greader.php/reader/api/0/subscription/list`;

  const subscription = (id, title, label) => ({
    id,
    title,
    url: `https://example.invalid/${id}`,
    categories: [{ id: `user/-/label/${label}`, label }],
  });

  let calls = [];
  /** Answers by URL suffix, so one fake serves a whole refresh. */
  let reply = () => ({ status: 200, body: {} });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers ?? {} });
    const answer = await reply(url, init);
    if (answer.text !== undefined) {
      return new Response(answer.text, { status: answer.status });
    }
    return jsonResponse(answer.status ?? 200, answer.body ?? {});
  };

  const fresh = () => {
    const reader = new ReaderState();
    reader.session = { serverUrl: SERVER, token: "test-token" };
    reader.subscriptions = [subscription("feed/1", "Ars Technica", "Technology"), subscription("feed/2", "MoMA", "Art")];
    reader.favorites = parseFavorites(favoritesBody({ ids: [], categories: [{ id: 3, name: "Comics", favorite: false }, { id: 7, name: "Art", favorite: false }] }));
    reader.hiddenCategories = hiddenState;
    reader.sidebarIndent = parseSidebarIndent({ available: true, px: 20 });
    calls = [];
    reply = () => ({ status: 200, body: {} });
    return reader;
  };

  {
    const reader = fresh();
    check("the indent is the server's", reader.sidebarIndent.px === 20, String(reader.sidebarIndent.px));

    reply = () => ({ status: 200, body: { ok: true, changed: true, favorites: favoritesBody({ ids: [3], categories: [{ id: 3, name: "Comics", favorite: true }] }) } });
    const pending = reader.setCategoryFavorite("Comics", true);
    check("the star fills before the write resolves", reader.isFavorite("Comics") === true);
    const outcome = await pending;

    check("the write succeeds", outcome?.kind === "applied", String(outcome?.kind));
    check("the request carries the numeric id", calls[0].url === FAVORITE_URL, calls[0].url);
    check("it sends favorite:true", calls[0].body === '{"favorite":true}', String(calls[0].body));
    check("the star stays filled", reader.isFavorite("Comics") === true);
    check("no banner for a clean write", reader.error === null);
    check("the busy flag is released", reader.favoritesBusy === false);
  }

  {
    const reader = fresh();
    reply = () => ({ status: 200, body: { ok: true, changed: false, favorites: favoritesBody({ ids: [3], categories: [{ id: 3, name: "Comics", favorite: true }] }) } });
    const outcome = await reader.setCategoryFavorite("Comics", true);
    check("changed:false is an applied write", outcome?.kind === "applied" && outcome.changed === false, `${outcome?.kind}/${String(outcome?.changed)}`);
    check("...with no banner", reader.error === null, String(reader.error));
    check("...and the star drawn", reader.isFavorite("Comics") === true);
  }

  {
    const reader = fresh();
    reply = () => ({
      status: 409,
      body: {
        ok: false,
        error: { code: "convergence_failed", message: "favorite saved, sweep failed" },
        favorites: favoritesBody({ ids: [], categories: [{ id: 3, name: "Comics", favorite: false }] }),
      },
    });
    const pending = reader.setCategoryFavorite("Comics", true);
    check("the star fills optimistically even when the server will refuse", reader.isFavorite("Comics") === true);
    const outcome = await pending;
    check("a 409 is reported as reconciled", outcome?.kind === "reconciled", String(outcome?.kind));
    check("the star goes back because the server said so", reader.isFavorite("Comics") === false);
    check("a reconcile is not a banner", reader.error === null, String(reader.error));
  }

  {
    const reader = fresh();
    reply = () => ({ status: 500, body: { error: { message: "upstream exploded" } } });
    const outcome = await reader.setCategoryFavorite("Comics", true);
    check("a stateless 500 rolls the star back", reader.isFavorite("Comics") === false && outcome?.kind === "failed");
    check("...and surfaces the reason", reader.error === "upstream exploded", String(reader.error));
  }

  {
    const reader = fresh();
    reply = () => ({ status: 200, body: { ok: true, favorites: favoritesBody({ view: "only", ids: [3] }) } });
    await reader.cycleFavoritesView();
    check("the header cycle asks for the next view", calls[0].url === FAVORITES_VIEW_URL && calls[0].body === '{"view":"only"}', String(calls[0].body));
    check("the view is applied", reader.favoriteView === "only", reader.favoriteView);
    check("the next click would ask for without", reader.nextFavoriteView === "without", reader.nextFavoriteView);
  }

  {
    const reader = fresh();
    // Hold the first write open, so the second press arrives while it is out.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let viewWrites = 0;
    reply = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url === FAVORITES_VIEW_URL) {
        viewWrites += 1;
        if (viewWrites === 1) await gate;
        return { status: 200, body: { ok: true, favorites: favoritesBody({ view: body.view }) } };
      }
      return { status: 200, body: {} };
    };

    const first = reader.setFavoritesView("only");
    check("a press is drawn before the write resolves", reader.favoriteView === "only", reader.favoriteView);

    const second = reader.setFavoritesView("without");
    check("a press during a write is drawn too", reader.favoriteView === "without");
    check("...and it does not queue behind the first to draw", second instanceof Promise);

    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const viewCalls = calls.filter((call) => call.url === FAVORITES_VIEW_URL);
    check("the press made during the write is sent when it settles", viewCalls.length === 2, String(viewCalls.length));
    check("...and it is the last one asked for", viewCalls.at(-1)?.body === '{"view":"without"}', String(viewCalls.at(-1)?.body));
    check("the server ends on the pressed view", reader.favoriteView === "without", reader.favoriteView);
    check("nothing is left busy", reader.favoritesBusy === false);
  }

  {
    const reader = fresh();
    reader.favorites = unavailableFavorites();
    const outcome = await reader.cycleFavoritesView();
    check("no favorites extension means no view write", outcome === null && calls.length === 0);
    check("...and no star state", reader.isFavorite("Comics") === false);
  }

  {
    const reader = fresh();
    reader.openFeedMenu({ id: "feed/1", title: "Ars Technica" }, { x: 10, y: 20 });
    check("a feed row opens its own menu", reader.menuModel?.kind === "feed" && reader.menuModel.remove !== null);
    check("the removal item only asks", reader.menuModel?.remove?.action.type === "confirm-remove", String(reader.menuModel?.remove?.action.type));

    await reader.applyMenuAction(reader.menuModel.remove.action);
    check("choosing Remove asks first instead of removing", reader.menu?.confirming === true && calls.length === 0, `${calls.length} request(s)`);

    await reader.applyMenuAction(reader.menuModel.confirm[1].action);
    check("Cancel backs out with nothing sent", reader.menu?.confirming === false && calls.length === 0);

    await reader.applyMenuAction(reader.menuModel.remove.action);
    check("the second step is still only a question", reader.menu?.confirming === true && calls.length === 0);
  }

  {
    const reader = fresh();
    const feed = { id: "feed/1", title: "Ars Technica" };
    reply = (url) => {
      if (url === TOKEN_URL) return { status: 200, text: "write-token" };
      if (url === EDIT_URL) return { status: 200, text: "OK" };
      if (url === SUBSCRIPTIONS_URL) {
        return {
          status: 200,
          body: { subscriptions: [subscription("feed/1", "Ars Technica", "Technology"), subscription("feed/2", "MoMA", "Art")] },
        };
      }
      return { status: 200, body: {} };
    };

    reader.openFeedMenu(feed, { x: 1, y: 2 });
    await reader.applyMenuAction({ type: "confirm-remove" });
    const pending = reader.applyMenuAction({ type: "remove-feed" });
    check("the menu closes on the confirmed removal", reader.menu === null);
    await pending;

    const edit = calls.find((call) => call.url === EDIT_URL);
    check("removal asks for a write token first", calls[0].url === TOKEN_URL, calls[0].url);
    check("removal posts to subscription/edit", edit !== undefined && edit.method === "POST");
    const params = new URLSearchParams(edit?.body ?? "");
    check("...with ac=unsubscribe", params.get("ac") === "unsubscribe", String(params.get("ac")));
    check("...naming the feed's stream id", params.get("s") === "feed/1", String(params.get("s")));
    check("...and the write token", params.get("T") === "write-token", String(params.get("T")));
    check("the feed list is refreshed afterwards", calls.some((call) => call.url.startsWith(SUBSCRIPTIONS_URL)));
    check("nothing failed", reader.error === null, String(reader.error));
  }

  {
    const reader = fresh();
    reply = (url) => {
      if (url === TOKEN_URL) return { status: 200, text: "write-token" };
      if (url === EDIT_URL) return { status: 200, text: "OK" };
      if (url === SUBSCRIPTIONS_URL) return { status: 200, body: { subscriptions: [subscription("feed/1", "Ars Technica", "Technology")] } };
      return { status: 200, body: {} };
    };

    const added = await reader.addFeed("  https://example.com/feed.xml  ");

    const edit = calls.find((call) => call.url === EDIT_URL);
    const params = new URLSearchParams(edit?.body ?? "");
    check("adding posts to subscription/edit", edit !== undefined && edit.method === "POST");
    check("...with ac=subscribe", params.get("ac") === "subscribe", String(params.get("ac")));
    check("...and the slash-formed feed id, trimmed", params.get("s") === "feed/https://example.com/feed.xml", String(params.get("s")));
    check("...without inventing a title", params.get("t") === null, String(params.get("t")));
    check("...carrying the write token", params.get("T") === "write-token", String(params.get("T")));
    check("the feed list is refreshed afterwards", calls.some((call) => call.url.startsWith(SUBSCRIPTIONS_URL)));
    check("the add reports success", added === true);
    check("...and clears its error", reader.addFeedError === null, String(reader.addFeedError));
  }

  {
    const reader = fresh();
    reply = (url) => {
      if (url === TOKEN_URL) return { status: 200, text: "write-token" };
      if (url === EDIT_URL) return { status: 400, text: "<p>Cannot add this feed: <b>not a valid feed URL</b></p>" };
      return { status: 200, body: {} };
    };

    const added = await reader.addFeed("https://example.com/nope");
    check("a refused subscribe reports failure", added === false);
    check("...the server's own words are kept", /not a valid feed URL/.test(reader.addFeedError ?? ""), String(reader.addFeedError));
    check("...without the markup", !/<b>/.test(reader.addFeedError ?? ""), String(reader.addFeedError));
    check("...and without taking over the banner", reader.error === null, String(reader.error));
    check("the busy flag is released", reader.feedBusy === false);
  }

  {
    const reader = fresh();
    const added = await reader.addFeed("   ");
    check("an empty url is refused before any request", added === false && calls.length === 0);
    check("...with a local explanation", reader.addFeedError === "Enter a feed URL first.", String(reader.addFeedError));
  }

  {
    // Removing the open stream must not leave the reader pointed at nothing.
    const reader = fresh();
    reader.activeStream = "feed/1";
    reader.items = [{ id: "item-1", title: "Something" }];
    reply = (url) => {
      if (url === TOKEN_URL) return { status: 200, text: "write-token" };
      if (url === EDIT_URL) return { status: 200, text: "OK" };
      if (url === SUBSCRIPTIONS_URL) return { status: 200, body: { subscriptions: [subscription("feed/2", "MoMA", "Art")] } };
      if (url.includes("/stream/contents/")) return { status: 200, body: { id: "user/-/state/com.google/reading-list", items: [] } };
      return { status: 200, body: {} };
    };

    await reader.removeFeed("feed/1");
    check("removing the open feed falls back to the reading list", reader.activeStream === "user/-/state/com.google/reading-list", reader.activeStream);
  }

  {
    // Favorite Categories is installed, so marking a category is one act: it
    // writes the extension's favourite and the sidebar treats that as the mark.
    // Nothing is stored on this device, because there is nothing separate to
    // store — a favourite and a pin are the same fact about a category.
    const reader = fresh();
    reply = () => ({ status: 200, body: { ok: true, changed: true, favorites: favoritesBody({ ids: [7], categories: [{ id: 3, name: "Comics", favorite: false }, { id: 7, name: "Art", favorite: true }] }) } });
    reader.openCategoryMenu("Art", { x: 0, y: 0 });
    check("the menu offers one mark, not two", reader.menuModel?.pin?.label === "Pin");
    check("...and the row never names a favourite", !("favorite" in (reader.menuModel ?? {})));

    await reader.applyMenuAction({ type: "pin", pinned: true });
    check(
      "marking a category writes the favourite on the server",
      calls.length === 1 && calls[0].url.endsWith("/v1/favorites/7") && calls[0].body === '{"favorite":true}',
      calls.map((c) => c.url).join(","),
    );
    check("the category is marked", reader.isCategoryPinned("Art") === true);
    check("...through the server, not a local pin", !reader.localPins.categories.includes("Art"));
    check("...and the extension agrees", reader.isFavorite("Art") === true);
    check("marked categories sort first", reader.categories.map((g) => g.label).join(",") === "Art,Technology", reader.categories.map((g) => g.label).join(","));
    check("the marked count is the favourite count", reader.pinnedCount >= 1, String(reader.pinnedCount));

    reader.openCategoryMenu("Art", { x: 0, y: 0 });
    check("the marked row offers Unpin", reader.menuModel?.pin?.label === "Unpin");
    await reader.applyMenuAction({ type: "pin", pinned: false });
    check("unmarking writes the other direction", calls.length === 2 && calls[1].body === '{"favorite":false}', calls.map((c) => c.body).join(","));
  }

  {
    // Local pins: no extension, no request, the pin still works on this device.
    const reader = fresh();
    reader.favorites = unavailableFavorites();
    reader.openCategoryMenu("Technology", { x: 0, y: 0 });
    check("the category menu opens without the favourites extension", reader.menu !== null && reader.menuModel?.pin?.disabled === false);
    check("...offering the same mark, kept here", reader.menuModel?.pin?.action.type === "pin");
    await reader.applyMenuAction({ type: "pin", pinned: true });
    check("a local mark sends nothing", calls.length === 0, `${calls.length} request(s)`);
    check("Technology is marked locally", reader.isCategoryPinned("Technology") && reader.localPins.categories.includes("Technology"));
    check("pinned categories sort first", reader.categories[0].label === "Technology", reader.categories.map((g) => g.label).join(","));

    await reader.cyclePinView();
    check("the band's pin control filters to pinned only", reader.pinView === "only" && reader.categories.map((g) => g.label).join(",") === "Technology", reader.categories.map((g) => g.label).join(","));
    await reader.cyclePinView();
    check("...then to unpinned only", reader.pinView === "without" && reader.categories.map((g) => g.label).join(",") === "Art", reader.categories.map((g) => g.label).join(","));
    await reader.cyclePinView();
    check("...then back to mixed", reader.pinView === "all" && reader.categories.length === 2);
    check("the view never touched the server", calls.length === 0);

    reader.setFeedPinned("feed/1", true);
    check("a feed pin is local", reader.isFeedPinned("feed/1") && calls.length === 0);
    check("the pinned count covers categories and feeds", reader.pinnedCount === 2, String(reader.pinnedCount));
  }

} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
