/**
 * Hidden categories with no extension anywhere near them.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/hidden-local.mjs
 *
 * The owner's requirement, in one line: hidden categories work fully inside the
 * app on any server, with or without the extension. So this suite is about the
 * two answers there are and the fact that they never meet:
 *
 * - extension absent -> this device's own set decides: the same three views, the
 *   same instant toggle, the same filtering, no request and no error;
 * - extension present -> the extension decides, and the local set is not read,
 *   not merged and not written.
 *
 * Everything runs headless. `ReaderState` is compiled the way the app's build
 * would compile it and driven through its real API client, with `fetch` replaced
 * by a recorder; `localStorage` is a small stub, so "per account" and "survives a
 * reload" are assertions rather than hopes. Nothing leaves the process: the
 * server URL points at a closed port and is never dialled.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = new URL("../../", import.meta.url).pathname;
/** Only this suite's own corner: siblings run in parallel and share `.gen`. */
const GEN_DIR = join(ROOT, "tests/unit/.gen/hidden-local");

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

/**
 * The reader's runes dependencies, compiled to plain ESM and pointed at from an
 * absolute path: a generated `.mjs` sitting in `.gen` has no way to resolve the
 * app's extensionless relative imports on its own.
 */
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
  buildRunesModule("theme.svelte.ts", "theme.mjs", {
    '"../lib/theme"': "src/lib/theme.ts",
  });

const buildFloodsModule = () =>
  buildRunesModule("floods.svelte.ts", "floods.mjs", {
    '"../lib/floods"': "src/lib/floods.ts",
  });

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
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"../lib/stream-loads"', JSON.stringify(absolute("src/lib/stream-loads.ts")))
    .replaceAll('"../lib/stream-perf"', JSON.stringify(absolute("src/lib/stream-perf.ts")))
    .replaceAll('"../lib/stream-scroll"', JSON.stringify(absolute("src/lib/stream-scroll.ts")))
    .replaceAll('\"./reading.svelte\"', JSON.stringify(buildReadingModule()))
    .replaceAll('\"./theme.svelte\"', JSON.stringify(buildThemeModule()))
    .replaceAll('\"./floods.svelte\"', JSON.stringify(buildFloodsModule()))
    .replaceAll('"../lib/stream-cycle"', JSON.stringify(absolute("src/lib/stream-cycle.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"../lib/sync-progress"', JSON.stringify(absolute("src/lib/sync-progress.ts")))
    .replaceAll('"../lib/place"', JSON.stringify(absolute("src/lib/place.ts")))
    .replaceAll('"../lib/sidebar-doc"', JSON.stringify(absolute("src/lib/sidebar-doc.ts")))
    .replaceAll('\"./hidden-write\"', JSON.stringify(absolute("src/state/hidden-write.ts")))
    .replaceAll('\"./hidden\"', JSON.stringify(absolute("src/state/hidden.ts")))
    .replaceAll('\"./favorites\"', JSON.stringify(absolute("src/state/favorites.ts")))
    .replaceAll('\"./write\"', JSON.stringify(absolute("src/state/write.ts")))
    .replaceAll('\"./stream-cache\"', JSON.stringify(absolute("src/state/stream-cache.ts")))
    .replaceAll('\"./pins\"', JSON.stringify(absolute("src/state/pins.ts")))
    .replaceAll('\"./persist\"', JSON.stringify(absolute("src/state/persist.ts")))
    .replaceAll('"../lib/api-snapshot"', JSON.stringify(absolute("src/lib/api-snapshot.ts")))
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")))
    .replaceAll('"../lib/feed-move"', JSON.stringify(absolute("src/lib/feed-move.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")))
    .replaceAll('"../lib/extract-ledger"', JSON.stringify(absolute("src/lib/extract-ledger.ts")))
    .replaceAll('"../lib/full-text"', JSON.stringify(absolute("src/lib/full-text.ts")));
}

const { isHiddenCategory, parseState } = await import(absolute("src/api/hardlyread.ts"));
const { accountSlug } = await import(absolute("src/lib/account-key.ts"));
const { bandFacts, statusFacts } = await import(absolute("src/lib/band.ts"));
const { emptyHidden, isLocallyHidden, parseHidden, resolveHidden, withHidden } = await import(
  absolute("src/state/hidden.ts")
);

/* ---------------------------------------------------------------------------
 * The pure layer: one resolution, two sources, no merge
 * ------------------------------------------------------------------------- */

{
  const server = parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [12],
    categories: [{ id: 12, name: "Technology", hidden: true }],
  });
  const local = { categories: ["Art"], view: "revealed" };
  check("the extension's block is returned as it came", resolveHidden(server, local) === server);
  check("...so a local set cannot change what it hides", !isHiddenCategory(resolveHidden(server, local), "Art"));
}

{
  const local = { categories: ["Technology"], view: "only" };
  const scope = resolveHidden(parseState({ available: false }), local);
  check("without the extension the local set answers", scope.available === true && scope.mode === "local");
  check("...with its own view", scope.effectiveView === "only");
  check("...and its labels as the hidden ones", isHiddenCategory(scope, "Technology"));
  check("...one hidden id per label, for the count", scope.hiddenIds.length === 1);
  check("a label it does not hold is not hidden", !isHiddenCategory(scope, "Art"));
  check("a local set can never be locked", scope.locked === false);
}

{
  check("an empty set hides nothing", withHidden([], "Art", false).length === 0);
  check("hiding adds the label", withHidden([], "Art", true).join(",") === "Art");
  check("hiding twice keeps one entry", withHidden(["Art"], "Art", true).join(",") === "Art");
  check("showing removes it", withHidden(["Art", "Tech"], "Art", false).join(",") === "Tech");
  check("nothing malformed survives a read", parseHidden("nonsense").categories.length === 0);
  check("...and a junk view falls back to Hidden", parseHidden({ categories: ["Art"], view: "nope" }).view === "hidden");
  check("a stored set parses as it was kept", parseHidden({ categories: ["Art"], view: "only" }).view === "only");
  check("an absent set is the empty one", emptyHidden().categories.length === 0 && emptyHidden().view === "hidden");
  check("the set answers for a label", isLocallyHidden({ categories: ["Art"], view: "hidden" }, "Art") === true);
  check("...and only for what it holds", isLocallyHidden({ categories: ["Art"], view: "hidden" }, "Tech") === false);
}

/* ---------------------------------------------------------------------------
 * A device's storage, and a network that is not allowed to be reached
 * ------------------------------------------------------------------------- */

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
    keys: () => [...map.keys()],
  };
}

const SERVER = "http://127.0.0.1:18081";
const PREFS_BASE = "hardlyreader.prefs.v1";

let calls = [];
let reply = () => ({ status: 200, body: {} });
/** The one store this case's device has. Reset per case, so a leaked key fails. */
let device = makeStorage();

globalThis.fetch = async (input, init) => {
  calls.push({
    url: String(input),
    method: init?.method,
    body: init?.body,
    authorization: init?.headers?.get?.("authorization") ?? null,
  });
  const answer = await reply();
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
};

const labels = (groups) => groups.map((group) => group.label).join(",");
const subscription = (id, title, label) => ({
  id,
  title,
  url: `https://example.invalid/${id}`,
  categories: [{ id: `user/-/label/${label}`, label }],
});

/** The extension's own block, for the cases where it answers. */
const extensionState = (overrides = {}) =>
  parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [12],
    locked: false,
    hasPasscode: false,
    categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ],
    ...overrides,
  });

function readerFor({ email = "one@example.test", extensions = false, store = device } = {}) {
  globalThis.localStorage = store;
  const reader = new ReaderState();
  reader.session = { serverUrl: SERVER, token: "test-token", email };
  reader.subscriptions = [
    subscription("feed/1", "Ars Technica", "Technology"),
    subscription("feed/2", "MoMA", "Art"),
  ];
  reader.hiddenCategories = extensions ? extensionState() : parseState({ available: false });
  calls = [];
  reply = () => ({ status: 200, body: {} });
  return reader;
}

const scopedPrefs = (email) => `${PREFS_BASE}:${accountSlug({ serverUrl: SERVER, email })}`;
const storedHidden = (email) => {
  const raw = device.getItem(scopedPrefs(email));
  return raw === null ? null : JSON.parse(raw).hidden;
};

mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(join(GEN_DIR, "reader.mjs"), buildReaderModule());

/** Assigned below, so the helpers above can be written once at module scope. */
let ReaderState;

try {
  ({ ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader.mjs")).href));

  /* -------------------------------------------------------------------------
   * No extension: the set is this device's, and the hide is instant
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "solo@example.test" });

    check("both categories are drawn to begin with", labels(reader.categories) === "Art,Technology", labels(reader.categories));
    check("nothing is hidden, per the device", reader.hiddenCount === 0);
    const emptyStrip = statusFacts({
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      hiddenCount: reader.hiddenCount,
      enforced: reader.hiddenEnforced,
      pinnedCount: reader.pinnedCount,
    });
    // Same answer the extension gives with an empty set: the view is Hidden, so
    // the curtain is "on" and the strip is allowed to read. Nothing is drawn,
    // because the strip's own gate is the count, not the badge.
    check("the strip reads zero rather than going blank", emptyStrip.hiddenCount === 0);
    check("the model enforces, exactly as the extension's does", reader.hiddenEnforced === true);
    check("the eye is on Hidden", reader.hiddenView === "hidden");

    const pending = reader.setCategoryHidden("Technology", true);
    check("the row goes before the call resolves", labels(reader.categories) === "Art", labels(reader.categories));
    const outcome = await pending;

    check("the toggle reports no server outcome, and no failure", outcome === null);
    check("the row stays gone", labels(reader.categories) === "Art", labels(reader.categories));
    check("nothing was sent", calls.length === 0, `${calls.length} request(s)`);
    check("no banner, no busy flag", reader.error === null && reader.hiddenBusy === false);
    check("the device holds the label", reader.localHidden.categories.join(",") === "Technology");
    check("the count the band reads is the local one", reader.hiddenCount === 1);
    check("and it is enforced, because the local view is Hidden", reader.hiddenEnforced === true);
    check("the menu calls this category hidden", reader.isCategoryHidden("Technology") === true);
    check("...and the other one shown", reader.isCategoryHidden("Art") === false);

    const kept = device.getItem(scopedPrefs("solo@example.test"));
    const again = await reader.setCategoryHidden("Technology", true);
    check("a redundant hide is refused, as the extension's would be", again === null && reader.localHidden.categories.length === 1);
    check("...and writes nothing", device.getItem(scopedPrefs("solo@example.test")) === kept);
  }

  /* -------------------------------------------------------------------------
   * Revealing: the rows were never removed, so it is the same frame
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "reveal@example.test" });
    await reader.setCategoryHidden("Technology", true);

    check("a hidden category's feeds stay in the subscribe list", reader.subscriptions.length === 2);
    check("...and in the unfiltered sidebar", reader.allCategories.length === 2);
    check("only the filtered view drops them", labels(reader.categories) === "Art");

    const pending = reader.setCategoryHidden("Technology", false);
    check("a reveal puts the row back at once", labels(reader.categories) === "Art,Technology", labels(reader.categories));
    await pending;
    check("...and stays back", labels(reader.categories) === "Art,Technology");
    check("...with no request for it", calls.length === 0, `${calls.length} request(s)`);
    check("the device's set is empty again", reader.localHidden.categories.length === 0);
  }

  /* -------------------------------------------------------------------------
   * The same three states, in the extension's own words
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "eye@example.test" });
    await reader.setCategoryHidden("Technology", true);

    check("Hidden draws everything but the hidden category", labels(reader.categories) === "Art");
    check("the eye is on Hidden", reader.hiddenView === "hidden");

    await reader.setHiddenView("revealed");
    check("Revealed draws the hidden category too", labels(reader.categories) === "Art,Technology");
    check("the eye says Revealed", reader.hiddenView === "revealed");
    check("the count is still known while revealing", reader.hiddenCount === 1);
    check("but nothing is being enforced", reader.hiddenEnforced === false);

    await reader.setHiddenView("only");
    check("Only draws the hidden category alone", labels(reader.categories) === "Technology", labels(reader.categories));
    check("the eye says Only", reader.hiddenView === "only");
    check("still not enforcing", reader.hiddenEnforced === false);

    await reader.setHiddenView("hidden");
    check("and back to the curtain", labels(reader.categories) === "Art" && reader.hiddenEnforced === true);
    check("the three views cost no requests", calls.length === 0, `${calls.length} request(s)`);
  }

  /* -------------------------------------------------------------------------
   * The band's facts, from the local set
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "band@example.test" });
    await reader.setCategoryHidden("Technology", true);
    reader.setCategoryPinned("Technology", true);

    check(
      "a pinned category that is hidden is still hidden",
      labels(reader.categories) === "Art",
      labels(reader.categories),
    );

    const facts = bandFacts({
      collapsed: false,
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      view: reader.hiddenView,
      pinnedCount: reader.pinnedCount,
      pinView: reader.pinView,
    });
    check("without the extension the eye is not a dead control", facts.hidden?.enabled === true);
    check("...and says the set is this device's", facts.hidden?.authority === "local");
    check("...with the words unchanged", facts.hidden?.label === "Hidden" && facts.hidden?.next === "Revealed");

    const strip = statusFacts({
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      hiddenCount: reader.hiddenCount,
      enforced: reader.hiddenEnforced,
      pinnedCount: reader.pinnedCount,
    });
    check("the strip counts the local set", strip.hiddenCount === 1, String(strip.hiddenCount));
    check("...wears the badge", strip.enforced === true);
    check("...and names this device as the one enforcing", strip.authority === "local");
    check("the pin count is unchanged by any of it", strip.pinnedCount === reader.pinnedCount);
  }

  /* -------------------------------------------------------------------------
   * One device, two accounts, and a reload
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const first = readerFor({ email: "a@example.test" });
    await first.setCategoryHidden("Technology", true);
    await first.setHiddenView("only");

    check("the set is kept in this account's own key", storedHidden("a@example.test")?.categories.join(",") === "Technology");
    check("...with the view it was left on", storedHidden("a@example.test")?.view === "only");
    check("...and no other account's key exists", device.keys().filter((key) => key.startsWith(PREFS_BASE)).length === 1);

    // `loadPrefs` is the first thing a launch does; TypeScript's `private` is a
    // compile-time word, and calling it here is what a reload is without a
    // server to talk to.
    const again = readerFor({ email: "a@example.test" });
    again.loadPrefs();
    check("a reload finds the set again", again.localHidden.categories.join(",") === "Technology");
    check("...and the view", again.localHidden.view === "only");
    check("...and filters the sidebar with it", labels(again.categories) === "Technology", labels(again.categories));

    const stranger = readerFor({ email: "b@example.test" });
    stranger.loadPrefs();
    check("another account on the same device starts empty", stranger.localHidden.categories.length === 0);
    check("...and draws every category", labels(stranger.categories) === "Art,Technology");
    check("...on the view everyone starts on", stranger.localHidden.view === "hidden");
  }

  /* -------------------------------------------------------------------------
   * The extension present: its store, its view, its lock — the device's set
   * is not read, and not written
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "server@example.test", extensions: true });
    // A stale set from a time this server had no extension. Under the
    // composition rule it is not consulted at all: the extension answers.
    reader.localHidden = { categories: ["Art"], view: "revealed" };

    check("the extension is the authority", reader.hiddenAuthority === "extension");
    check("its view is the view", reader.hiddenView === "hidden");
    check("its hidden category is the hidden one", reader.isCategoryHidden("Technology") === true);
    check("the stale local label is not", reader.isCategoryHidden("Art") === false);
    check("so the sidebar shows the extension's answer, not the local set", labels(reader.categories) === "Art", labels(reader.categories));
    check("and the count is the extension's", reader.hiddenCount === 1);

    reply = () => ({
      status: 200,
      body: {
        changed: true,
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "hidden",
          effectiveView: "hidden",
          hiddenIds: [12, 7],
          locked: false,
          categories: [
            { id: 12, name: "Technology", hidden: true },
            { id: 7, name: "Art", hidden: true },
          ],
        },
      },
    });
    const before = reader.localHidden;
    const pending = reader.setCategoryHidden("Art", true);
    check("the toggle is drawn on the extension's own row", labels(reader.categories) === "", labels(reader.categories));
    const outcome = await pending;

    check("the write went to the server", outcome?.kind === "applied", outcome?.kind);
    check("...as one request", calls.length === 1, `${calls.length} request(s)`);
    check("...to the category's numeric id", calls[0]?.url.endsWith("/hidden-categories/7") === true, calls[0]?.url);
    check("the device's set was not touched", reader.localHidden === before && reader.localHidden.categories.join(",") === "Art");
    check("...and not written to storage", storedHidden("server@example.test") === null);

    reply = () => ({
      status: 200,
      body: {
        changed: true,
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "only",
          effectiveView: "only",
          hiddenIds: [12, 7],
          locked: false,
          categories: [],
        },
      },
    });
    await reader.setHiddenView("only");
    check("a view change is a request too", calls.some((call) => call.url.endsWith("/hidden-categories/view")));
    check("...and the local view is left as it was", reader.localHidden.view === "revealed");
  }

  /* -------------------------------------------------------------------------
   * A locked account paints nothing from the local set
   * ----------------------------------------------------------------------- */

  {
    device = makeStorage();
    const reader = readerFor({ email: "locked@example.test", extensions: true });
    reader.localHidden = { categories: ["Technology", "Art"], view: "revealed" };
    reader.hiddenCategories = extensionState({
      view: "revealed",
      effectiveView: "hidden",
      locked: true,
      hasPasscode: true,
    });

    check("a locked extension account is still the extension's", reader.hiddenAuthority === "extension");
    check("the curtain is down", reader.hiddenLocked === true);
    check(
      "the local set paints nothing: the extension's rows are the only ones drawn",
      labels(reader.categories) === "Art",
      labels(reader.categories),
    );

    const facts = bandFacts({
      collapsed: false,
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      view: reader.hiddenView,
      pinnedCount: reader.pinnedCount,
      pinView: reader.pinView,
    });
    check("a locked band has no eye", facts.hidden === null);

    const strip = statusFacts({
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      hiddenCount: reader.hiddenCount,
      enforced: reader.hiddenEnforced,
      pinnedCount: reader.pinnedCount,
    });
    check("a locked strip prints no count, local or otherwise", strip.hiddenCount === null);
    check("...and wears no badge, though the local set says Hidden", strip.enforced === false);

    // Values only: the field names ("hidden", "hiddenCount") are the model's own
    // vocabulary, and a lock is about what is *said*, not about how it is keyed.
    const said = [];
    const collect = (value) => {
      if (typeof value === "string") said.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(facts);
    collect(strip);
    const leaked = said.filter((word) => /hidden|reveal|enforced/i.test(word));
    check("and nothing either model says names hidden content", leaked.length === 0, leaked.join(" | "));
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
