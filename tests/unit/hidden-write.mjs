/**
 * Headless checks for optimistic hidden-categories writes.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/hidden-write.mjs
 *
 * Two layers:
 *
 * - `src/state/hidden-write.ts` directly, with fake writes and injected errors;
 * - `ReaderState` end to end, driven through its real API client and transport,
 *   with `globalThis.fetch` replaced by a recorder. Nothing leaves the process:
 *   the server URL points at a closed port and is never dialled.
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
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/scroll-advance"', JSON.stringify(absolute("src/lib/scroll-advance.ts")))
    .replaceAll('"../lib/reading-layout"', JSON.stringify(absolute("src/lib/reading-layout.ts")));
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
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"./reading.svelte"', JSON.stringify(buildReadingModule()))
    .replaceAll('"./theme.svelte"', JSON.stringify(buildThemeModule()))
    .replaceAll('"./floods.svelte"', JSON.stringify(buildFloodsModule()))
    .replaceAll('"../lib/stream-cycle"', JSON.stringify(absolute("src/lib/stream-cycle.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"../lib/sync-progress"', JSON.stringify(absolute("src/lib/sync-progress.ts")))
    .replaceAll('"./hidden-write"', JSON.stringify(absolute("src/state/hidden-write.ts")))
    .replaceAll('"./hidden"', JSON.stringify(absolute("src/state/hidden.ts")))
    .replaceAll('"./favorites"', JSON.stringify(absolute("src/state/favorites.ts")))
    .replaceAll('"./write"', JSON.stringify(absolute("src/state/write.ts")))
    .replaceAll('"./stream-cache"', JSON.stringify(absolute("src/state/stream-cache.ts")))
    .replaceAll('"./pins"', JSON.stringify(absolute("src/state/pins.ts")))
    .replaceAll('"./persist"', JSON.stringify(absolute("src/state/persist.ts")));
}

const { ApiError, parseState } = await import(absolute("src/api/hardlyread.ts"));
const { applyHiddenWrite, withCategoryHidden, withView } = await import(
  absolute("src/state/hidden-write.ts")
);

function state(overrides = {}) {
  return parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [],
    locked: false,
    categories: [
      { id: 12, name: "Technology", hidden: false },
      { id: 7, name: "Art", hidden: false },
    ],
    ...overrides,
  });
}

/* ---------------------------------------------------------------------------
 * Optimistic state
 * ------------------------------------------------------------------------- */

{
  const before = state();
  const after = withCategoryHidden(before, 12, true);
  check("hiding adds the id", after.hiddenIds.join(",") === "12", after.hiddenIds.join(","));
  check("hiding flips the category's own flag", after.categories.find((c) => c.id === 12)?.hidden === true);
  check("the other category is untouched", after.categories.find((c) => c.id === 7)?.hidden === false);
  check("the original state is not mutated", before.hiddenIds.length === 0 && before.categories[0].hidden === false);
}

{
  const before = state({ hiddenIds: [7, 12], categories: [
    { id: 12, name: "Technology", hidden: true },
    { id: 7, name: "Art", hidden: true },
  ] });
  const after = withCategoryHidden(before, 12, false);
  check("showing removes the id", after.hiddenIds.join(",") === "7", after.hiddenIds.join(","));
  check("showing flips the category's own flag", after.categories.find((c) => c.id === 12)?.hidden === false);
}

{
  const before = state({ hiddenIds: [7] });
  const after = withCategoryHidden(before, 12, true);
  check("the hidden list stays sorted", after.hiddenIds.join(",") === "7,12", after.hiddenIds.join(","));
}

{
  const before = state();
  check("an id the server never reported is left alone", withCategoryHidden(before, 999, true) === before);
}

{
  const after = withView(state(), "only");
  check("a view change applies at once", after.view === "only", after.view);
  check("...and to the effective view", after.effectiveView === "only", after.effectiveView);
  check("an unavailable server keeps its state", withView(parseState({ available: false }), "only").available === false);
}

/* ---------------------------------------------------------------------------
 * Write ordering and reconciliation
 * ------------------------------------------------------------------------- */

{
  const current = state();
  const optimistic = withCategoryHidden(current, 12, true);
  const server = state({ hiddenIds: [12], categories: [
    { id: 12, name: "Technology", hidden: true },
    { id: 7, name: "Art", hidden: false },
  ] });
  const commits = [];
  const outcome = await applyHiddenWrite(current, optimistic, (next) => commits.push(next), async () => ({
    changed: true,
    hiddenCategories: server,
  }));

  check("the optimistic state is committed first", commits[0] === optimistic);
  check("exactly one final state follows", commits.length === 2);
  check("the server's state wins", commits[1] === server);
  check("the outcome is applied", outcome.kind === "applied" && outcome.changed === true);
}

{
  const current = state();
  const optimistic = withCategoryHidden(current, 12, true);
  const authoritative = state({ hiddenIds: [], categories: [
    { id: 12, name: "Technology", hidden: false },
    { id: 7, name: "Art", hidden: false },
  ] });
  const commits = [];
  const outcome = await applyHiddenWrite(
    current,
    optimistic,
    (next) => commits.push(next),
    async () => {
      throw new ApiError(409, "convergence_failed", "could not converge", authoritative);
    },
  );

  check("a 409 reconciles instead of rolling back", commits[1] === authoritative);
  check("...and is reported as reconciled", outcome.kind === "reconciled" && outcome.status === 409, outcome.kind);
  check("...carrying the server's own explanation", outcome.code === "convergence_failed" && outcome.message === "could not converge");
}

{
  const current = state();
  const locked = state({ view: "revealed", effectiveView: "hidden", locked: true });
  const commits = [];
  const outcome = await applyHiddenWrite(current, withView(current, "only"), (next) => commits.push(next), async () => {
    throw new ApiError(423, "locked", "locked", locked);
  });

  check("a 423 reconciles as well", outcome.kind === "reconciled" && outcome.status === 423, outcome.kind);
  check("...and the locked state is drawn", commits[1] === locked);
  check("locked really did override the stored view", commits[1].effectiveView === "hidden");
}

{
  const current = state();
  const commits = [];
  const outcome = await applyHiddenWrite(current, withCategoryHidden(current, 12, true), (next) => commits.push(next), async () => {
    throw new Error("network down");
  });

  check("a failure with no state rolls back", commits[1] === current);
  check("...and is reported as failed with the reason", outcome.kind === "failed" && outcome.message === "network down", outcome.kind);
}

{
  const current = state();
  const commits = [];
  const outcome = await applyHiddenWrite(current, withCategoryHidden(current, 12, true), (next) => commits.push(next), async () => {
    throw new ApiError(500, "http_500", "boom", null);
  });

  check("an ApiError with no state still rolls back", commits[1] === current);
  check("...and still counts as failed", outcome.kind === "failed", outcome.kind);
}

/* ---------------------------------------------------------------------------
 * ReaderState, through the real client and transport
 * ------------------------------------------------------------------------- */

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "reader.mjs");
writeFileSync(generated, buildReaderModule());

try {
  const { ReaderState, lockFailure } = await import(pathToFileURL(generated).href);

  /* ---------------------------------------------------------------------------
   * Why a lock failed
   * ------------------------------------------------------------------------- */

  {
    // The server's own words for an old extension are "Unknown route.", which
    // reads as the app being broken. Name the actual problem instead.
    check(
      "an old server is named as the cause, not as an unknown route",
      lockFailure(new ApiError(404, "route_not_found", "Unknown route.")).includes("extension"),
      lockFailure(new ApiError(404, "route_not_found", "Unknown route.")),
    );
    check(
      "a 409 keeps the server's own explanation",
      lockFailure(new ApiError(409, "passcode_required", "Set a passcode before locking")) ===
        "Set a passcode before locking",
    );
    check(
      "an unknown failure does not pretend nothing happened",
      lockFailure(new Error("socket hang up")) === "Could not lock. Nothing was changed.",
    );
  }


  const labels = (groups) => groups.map((group) => group.label).join(",");
  const subscription = (id, title, label) => ({
    id,
    title,
    url: `https://example.invalid/${id}`,
    categories: [{ id: `user/-/label/${label}`, label }],
  });

  const SERVER = "http://127.0.0.1:18080";
  const HIDE_URL = `${SERVER}/api/misc.php/Hardly%20Read/v1/hidden-categories/12`;
  const VIEW_URL = `${SERVER}/api/misc.php/Hardly%20Read/v1/hidden-categories/view`;

  let calls = [];
  let reply = () => ({ status: 200, body: {} });

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body,
      authorization: init?.headers?.Authorization,
    });
    const answer = await reply();
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };

  const fresh = () => {
    const reader = new ReaderState();
    reader.session = { serverUrl: SERVER, token: "test-token" };
    reader.subscriptions = [subscription("feed/1", "Ars Technica", "Technology"), subscription("feed/2", "MoMA", "Art")];
    reader.hiddenCategories = state();
    calls = [];
    reply = () => ({ status: 200, body: {} });
    return reader;
  };

  {
    const reader = fresh();
    reply = () => ({
      status: 200,
      body: {
        changed: true,
        hiddenCategories: {
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
        },
      },
    });

    check("both categories are drawn to begin with", labels(reader.categories) === "Art,Technology", labels(reader.categories));
    const pending = reader.setCategoryHidden("user/-/label/Technology", true);
    check("the row disappears before the write resolves", labels(reader.categories) === "Art", labels(reader.categories));

    const outcome = await pending;
    check("the write succeeds", outcome.kind === "applied", outcome.kind);
    check("the request carries the numeric id, not the label", calls[0].url === HIDE_URL, calls[0].url);
    check("it is a PUT", calls[0].method === "PUT", String(calls[0].method));
    check("it sends explicit state, not a toggle", calls[0].body === '{"hidden":true}', String(calls[0].body));
    check("it is authorised by the GReader token", String(calls[0].authorization ?? "").includes("auth=test-token"), String(calls[0].authorization));
    check("the row stays gone after the server agrees", labels(reader.categories) === "Art", labels(reader.categories));
    check("no banner for a clean write", reader.error === null);
    check("the busy flag is released", reader.hiddenBusy === false);
  }

  {
    const reader = fresh();
    reply = () => ({
      status: 409,
      body: {
        error: { code: "convergence_failed", message: "priority did not converge" },
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "hidden",
          effectiveView: "hidden",
          hiddenIds: [],
          locked: false,
          categories: [
            { id: 12, name: "Technology", hidden: false },
            { id: 7, name: "Art", hidden: false },
          ],
        },
      },
    });

    const pending = reader.setCategoryHidden("Technology", true);
    check("the optimistic hide happens even when the server will refuse", labels(reader.categories) === "Art");
    const outcome = await pending;
    check("a 409 is reported as reconciled", outcome.kind === "reconciled" && outcome.status === 409, outcome.kind);
    check("the row returns because the server said so", labels(reader.categories) === "Art,Technology", labels(reader.categories));
    check("a reconcile is not a banner", reader.error === null, String(reader.error));
    check("the reconciled state is the server's, not the optimistic one", reader.hiddenCategories.hiddenIds.length === 0);
  }

  {
    const reader = fresh();
    reply = () => ({ status: 500, body: { error: { message: "upstream exploded" } } });

    const outcome = await reader.setCategoryHidden("Technology", true);
    check("a stateless 500 rolls the row back", labels(reader.categories) === "Art,Technology", labels(reader.categories));
    check("...and surfaces the reason", reader.error === "upstream exploded", String(reader.error));
    check("...still reported as failed", outcome.kind === "failed", outcome.kind);
  }

  {
    const reader = fresh();
    reply = () => ({
      status: 423,
      body: {
        error: { code: "locked", message: "locked by the extension" },
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "revealed",
          effectiveView: "hidden",
          hiddenIds: [],
          locked: true,
          categories: [
            { id: 12, name: "Technology", hidden: false },
            { id: 7, name: "Art", hidden: false },
          ],
        },
      },
    });

    const outcome = await reader.setHiddenView("only");
    check("a view change goes to the view route", calls[0].url === VIEW_URL, calls[0].url);
    check("...with the chosen view", calls[0].body === '{"view":"only"}', String(calls[0].body));
    check("a locked view reconciles", outcome.kind === "reconciled" && outcome.status === 423, outcome.kind);
    check("the locked state is drawn, not the request", reader.hiddenView === "hidden", reader.hiddenView);
    check("the stored view is not the effective one", reader.hiddenCategories.view === "revealed");
  }

  {
    const reader = fresh();
    reply = () => ({
      status: 200,
      body: {
        changed: true,
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "only",
          effectiveView: "only",
          hiddenIds: [12],
          locked: false,
          categories: [
            { id: 12, name: "Technology", hidden: true },
            { id: 7, name: "Art", hidden: false },
          ],
        },
      },
    });
    reader.hiddenCategories = state({ hiddenIds: [12], categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ] });

    const pending = reader.setHiddenView("only");
    check("a view change filters immediately", labels(reader.categories) === "Technology", labels(reader.categories));
    await pending;
  }

  {
    const reader = fresh();
    reply = () => ({ status: 200, body: { changed: true, hiddenCategories: { available: true, view: "hidden", effectiveView: "hidden", hiddenIds: [12], categories: [] } } });

    reader.openCategoryMenu("Technology", { x: 10, y: 20 });
    check("the menu opens with a model", reader.menuModel !== null && reader.menuModel.toggle.label === "Hide");
    const pending = reader.applyMenuAction({ type: "hidden", hidden: true });
    check("choosing an item closes the menu at once", reader.menu === null);
    await pending;
    check("...and wrote the hide", calls[0].url === HIDE_URL && calls[0].body === '{"hidden":true}');
  }

  {
    const reader = fresh();
    reader.hiddenCategories = parseState({ available: false });
    reader.openCategoryMenu("Technology", { x: 0, y: 0 });
    check("without the extension the menu only offers its mark", reader.menuModel?.toggle === null && reader.menuModel?.favorite?.action.type === "pin");
    check("no write without the extension", (await reader.setCategoryHidden("Technology", true)) === null);
    check("no request was made", calls.length === 0);
  }

  {
    const reader = fresh();
    check("an unknown label writes nothing", (await reader.setCategoryHidden("Uncategorized", true)) === null && calls.length === 0);
  }

  {
    const reader = fresh();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;
    const hiddenState = (ids) => ({
      status: 200,
      body: {
        changed: true,
        hiddenCategories: {
          available: true,
          mode: "strict",
          view: "hidden",
          effectiveView: "hidden",
          hiddenIds: ids,
          locked: false,
          hasPasscode: false,
          categories: [
            { id: 12, name: "Technology", hidden: ids.includes(12) },
            { id: 7, name: "Art", hidden: ids.includes(7) },
          ],
        },
      },
    });
    reply = async () => {
      if (first) {
        first = false;
        await gate;
        return hiddenState([12]);
      }
      return hiddenState([12, 7]);
    };

    const a = reader.setCategoryHidden("Technology", true);
    const b = reader.setCategoryHidden("Art", true);

    // The intent that used to be dropped: a slow first write must not swallow
    // the second click, and the newer intent must own the screen.
    check("a second hide is drawn while the first is in flight", labels(reader.categories) === "");
    // The queue starts on a microtask, so let it reach the transport first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("only one request has gone out so far", calls.length === 1, `${calls.length} request(s)`);

    release();
    await Promise.all([a, b]);

    const hideCalls = calls.filter((call) => call.url.startsWith(`${SERVER}/api/misc.php/Hardly%20Read/v1/hidden-categories/`));
    check("both writes reached the server", hideCalls.length === 2, `${hideCalls.length} request(s)`);
    check("the newest answer settles the screen", reader.hiddenCategories.hiddenIds.join(",") === "12,7", reader.hiddenCategories.hiddenIds.join(","));
  }

  {
    const reader = fresh();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;
    reply = async () => {
      if (first) {
        first = false;
        await gate;
        return { status: 200, body: { changed: true, hiddenCategories: { available: true, mode: "light", view: "revealed", effectiveView: "revealed", hiddenIds: [], locked: false, hasPasscode: false, categories: [] } } };
      }
      return { status: 200, body: { changed: true, hiddenCategories: { available: true, mode: "light", view: "hidden", effectiveView: "hidden", hiddenIds: [], locked: false, hasPasscode: false, categories: [] } } };
    };

    const a = reader.setHiddenView("revealed");
    const b = reader.setHiddenView("hidden");

    check("the newest view is drawn at once", reader.hiddenCategories.view === "hidden", reader.hiddenCategories.view);

    release();
    await Promise.all([a, b]);

    // The reply for "revealed" arrives first and is older than what the user
    // is now looking at: drawing it would flip the eye back for no reason.
    check("a stale view reply is discarded", reader.hiddenCategories.view === "hidden", reader.hiddenCategories.view);
  }

  {
    const reader = fresh();
    reader.openCategoryMenu("Technology", { x: 1, y: 2 });
    reader.stop();
    check("stop() closes the menu and clears the busy flag", reader.menu === null && reader.hiddenBusy === false);
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
