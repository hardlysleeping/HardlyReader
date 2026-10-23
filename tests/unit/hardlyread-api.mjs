/**
 * Unit checks for the HardlyRead v1 client and the sidebar view filter.
 *
 *   node --experimental-strip-types tests/unit/hardlyread-api.mjs
 *
 * No server, no network, no GUI: a fake transport records each request and
 * answers from a canned map, so the wire contract
 * (extensions/xExtension-HardlyRead/lib/HardlyReadApi.php) is exercised
 * request-by-request. Integration against a live FreshRSS is NOT covered here.
 */
import {
  ApiError,
  apiUrl,
  categoryIdForLabel,
  getState,
  isHiddenCategory,
  labelOf,
  parseState,
  lockHidden,
  setCategoryHidden,
  setHiddenPasscode,
  setView,
  unlockHidden,
  unavailableState,
} from "../../src/api/hardlyread.ts";
import { effectiveView, showsCategory, visibleGroups } from "../../src/state/hidden.ts";

const SESSION = {
  serverUrl: "http://127.0.0.1:18080/",
  email: "itest",
  token: "itest/0123456789abcdef",
};

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A transport that records calls and answers with `handler`. */
function recorder(handler) {
  const calls = [];
  const transport = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
    });
    return handler(String(input), init);
  };
  return { transport, calls };
}

function stateBody(overrides = {}) {
  return {
    apiVersion: 1,
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
      ...overrides,
    },
  };
}

async function rejects(name, fn, predicate) {
  try {
    await fn();
    check(name, false, "resolved instead of throwing");
  } catch (error) {
    check(name, predicate(error), String(error?.code ?? error?.name ?? error));
  }
}

/* ------------------------------------------------------------------ URLs */

check(
  "apiUrl points at misc.php keyed by the extension name",
  apiUrl(SESSION.serverUrl, "/state") ===
    "http://127.0.0.1:18080/api/misc.php/Hardly%20Read/v1/state",
  apiUrl(SESSION.serverUrl, "/state"),
);
check(
  "apiUrl tolerates a trailing slash on the server url",
  apiUrl("http://host:8080///", "/state") === "http://host:8080/api/misc.php/Hardly%20Read/v1/state",
);
check("labelOf strips the GReader label prefix", labelOf("user/-/label/Technology") === "Technology");
check("labelOf leaves a bare label alone", labelOf("Technology") === "Technology");

/* ------------------------------------------------------------- GET state */

{
  const { transport, calls } = recorder(() => jsonResponse(200, stateBody()));
  const state = await getState(transport, SESSION);

  check("GET state hits the state route with GET", calls.length === 1 && calls[0].method === "GET");
  check(
    "GET state sends the GoogleLogin credential",
    calls[0].headers.Authorization === `GoogleLogin auth=${SESSION.token}`,
    calls[0].headers.Authorization,
  );
  check("GET state sends no body and no content type",
    calls[0].body === undefined && calls[0].headers["Content-Type"] === undefined);

  check("state is available", state.available === true);
  check("state mode is read", state.mode === "strict");
  check("state hiddenIds are numbers", state.hiddenIds.length === 1 && state.hiddenIds[0] === 12);
  check("state categories keep id/name/hidden", state.categories[1].id === 7 && state.categories[1].name === "Art" && state.categories[1].hidden === false);
  check("locked defaults to false", state.locked === false);
}

{
  // Nothing installed/enabled: the block is `{ available: false }` and nothing else.
  const { transport } = recorder(() => jsonResponse(200, { apiVersion: 1, hiddenCategories: { available: false } }));
  const state = await getState(transport, SESSION);
  check("available:false yields the unavailable state", state.available === false && state.categories.length === 0);
  check("unavailable state still reports a view", state.view === "hidden" && state.effectiveView === "hidden");
}

{
  // 401 carries Google-Bad-Token; the client reports it as ApiError.unauthorized.
  const { transport } = recorder(() =>
    jsonResponse(401, { ok: false, error: { code: "unauthorized", message: "A valid GoogleLogin credential is required." } }),
  );
  await rejects("401 surfaces as an unauthorized ApiError", () => getState(transport, SESSION),
    (error) => error instanceof ApiError && error.status === 401 && error.unauthorized === true && error.code === "unauthorized");
}

{
  // A proxy 502 with an HTML body must still produce a typed error.
  const { transport } = recorder(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await rejects("non-JSON error body still yields an ApiError", () => getState(transport, SESSION),
    (error) => error instanceof ApiError && error.status === 502 && error.code === "http_502" && error.message === "Request failed (HTTP 502)");
}

/* ------------------------------------------------------- PUT hidden state */

{
  const { transport, calls } = recorder(() =>
    jsonResponse(200, { ok: true, changed: true, hiddenCategories: stateBody().hiddenCategories }),
  );
  const result = await setCategoryHidden(transport, SESSION, 12, true);

  check("PUT hidden goes to /v1/hidden-categories/{id}", calls[0].url.endsWith("/v1/hidden-categories/12"), calls[0].url);
  check("PUT hidden uses PUT", calls[0].method === "PUT");
  check("PUT hidden sends JSON", calls[0].headers["Content-Type"] === "application/json");
  check("PUT hidden sends an explicit boolean", calls[0].body === JSON.stringify({ hidden: true }), calls[0].body);
  check("PUT hidden still authenticates", calls[0].headers.Authorization === `GoogleLogin auth=${SESSION.token}`);
  check("changed is reported", result.changed === true);
  check("the response state is parsed", result.hiddenCategories.hiddenIds[0] === 12);
}

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true, changed: false, hiddenCategories: stateBody().hiddenCategories }));
  await setCategoryHidden(transport, SESSION, 7, false);
  check("unhide sends hidden:false, never a toggle", calls[0].body === JSON.stringify({ hidden: false }), calls[0].body);
}

{
  const { transport } = recorder(() => jsonResponse(200, { ok: true, hiddenCategories: stateBody().hiddenCategories }));
  const result = await setCategoryHidden(transport, SESSION, 7, true);
  check("a missing `changed` reads as null, not as true", result.changed === null, String(result.changed));
}

await rejects("a zero id is refused before any request", async () => {
  const { transport, calls } = recorder(() => jsonResponse(200, {}));
  try {
    await setCategoryHidden(transport, SESSION, 0, true);
  } finally {
    check("...no request was sent", calls.length === 0);
  }
}, (error) => error instanceof RangeError);

await rejects("a non-integer id is refused before any request", async () => {
  const { transport, calls } = recorder(() => jsonResponse(200, {}));
  try {
    await setCategoryHidden(transport, SESSION, 1.5, true);
  } finally {
    check("...no request was sent for the fractional id", calls.length === 0);
  }
}, (error) => error instanceof RangeError);

/* ------------------------------------------------------------- PUT view */

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true, hiddenCategories: stateBody({ view: "revealed", effectiveView: "revealed" }).hiddenCategories }));
  await setView(transport, SESSION, "revealed");
  check(
    "PUT view goes to /v1/hidden-categories/view",
    calls[0].url.endsWith("/v1/hidden-categories/view") && calls[0].method === "PUT",
    calls[0].url,
  );
  check("PUT view sends the view name", calls[0].body === JSON.stringify({ view: "revealed" }), calls[0].body);
}

await rejects("an unknown view is refused before any request", async () => {
  const { transport, calls } = recorder(() => jsonResponse(200, {}));
  try {
    await setView(transport, SESSION, "everything");
  } finally {
    check("...no request was sent for the bad view", calls.length === 0);
  }
}, (error) => error instanceof RangeError);

/* ------------------------------------------------------- error contract */

{
  // 409 convergence_failed carries the authoritative state: reconcile, do not roll back.
  const { transport } = recorder(() =>
    jsonResponse(409, {
      ok: false,
      error: { code: "convergence_failed", message: "Category state changed, but some feed visibility updates failed." },
      hiddenCategories: stateBody({ hiddenIds: [12, 7] }).hiddenCategories,
    }),
  );
  await rejects("409 convergence_failed carries state for reconciliation", () => setCategoryHidden(transport, SESSION, 7, true),
    (error) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "convergence_failed" &&
      error.state !== null &&
      error.state.hiddenIds.length === 2,
    "state carried");
}

{
  const { transport } = recorder(() =>
    jsonResponse(409, { ok: false, error: { code: "extension_incompatible", message: "Hidden Categories does not implement setCategoryHidden()." } }),
  );
  await rejects("409 extension_incompatible is preserved as a code", () => setCategoryHidden(transport, SESSION, 7, true),
    (error) => error instanceof ApiError && error.status === 409 && error.code === "extension_incompatible" && error.state === null);
}

{
  const { transport } = recorder(() =>
    jsonResponse(409, { ok: false, error: { code: "hidden_categories_unavailable", message: "Hidden Categories is not enabled for this user." } }),
  );
  await rejects("409 hidden_categories_unavailable is preserved", () => setView(transport, SESSION, "hidden"),
    (error) => error instanceof ApiError && error.code === "hidden_categories_unavailable");
}

{
  const { transport } = recorder(() =>
    jsonResponse(423, {
      ok: false,
      error: { code: "locked", message: "Hidden Categories is locked: unlock it in FreshRSS first." },
      hiddenCategories: stateBody({ locked: true, view: "revealed", effectiveView: "hidden" }).hiddenCategories,
    }),
  );
  await rejects("423 locked carries the locked state", () => setView(transport, SESSION, "only"),
    (error) => error instanceof ApiError && error.status === 423 && error.code === "locked" && error.state?.locked === true &&
      error.state.view === "revealed" && effectiveView(error.state) === "hidden",
    "locked state carried");
}

{
  const { transport } = recorder(() =>
    jsonResponse(404, { ok: false, error: { code: "category_not_found", message: "Category does not exist." } }),
  );
  await rejects("404 category_not_found is preserved", () => setCategoryHidden(transport, SESSION, 99, true),
    (error) => error instanceof ApiError && error.status === 404 && error.code === "category_not_found");
}

/* -------------------------------------------------- parseState tolerance */

check("parseState rejects a non-object", parseState(null).available === false);
check("parseState rejects available:true missing elsewhere", parseState({ available: true }).view === "hidden");
check(
  "parseState drops junk ids and junk categories",
  parseState({
    available: true,
    hiddenIds: [3, 0, -1, "x", 4.5],
    categories: [{ id: 3, name: "A", hidden: true }, { id: 0, name: "B" }, "nope"],
  }).hiddenIds.length === 1,
);
check(
  "parseState keeps only known views",
  parseState({ available: true, view: "everything", effectiveView: "nonsense" }).view === "hidden",
);
check(
  "parseState does not share arrays between calls",
  parseState({ available: false }).categories !== parseState({ available: false }).categories,
);

/* ------------------------------------------------- label -> numeric id */

const state = parseState(stateBody().hiddenCategories);
check("label stream id maps to the numeric id", categoryIdForLabel(state, "user/-/label/Technology") === 12);
check("bare label maps too", categoryIdForLabel(state, "Art") === 7);
check("case-insensitive fallback", categoryIdForLabel(state, "TECHNOLOGY") === 12);
check("unknown label maps to null", categoryIdForLabel(state, "Cooking") === null);
check("Uncategorized maps to null", categoryIdForLabel(state, "user/-/label/Uncategorized") === null);
check("hidden check uses the server's ids", isHiddenCategory(state, "Technology") === true && isHiddenCategory(state, "Art") === false);
check("unavailable state hides nothing", isHiddenCategory(unavailableState(), "Technology") === false);

/* ------------------------------------------------------- view filtering */

const groups = [{ label: "Technology" }, { label: "Art" }, { label: "Cooking" }];
const labels = (list) => list.map((group) => group.label).join(",");

check(
  "view hidden drops hidden categories",
  labels(visibleGroups(groups, parseState(stateBody({ view: "hidden", effectiveView: "hidden" }).hiddenCategories))) === "Art,Cooking",
  labels(visibleGroups(groups, parseState(stateBody({ view: "hidden", effectiveView: "hidden" }).hiddenCategories))),
);
check(
  "view revealed keeps everything",
  labels(visibleGroups(groups, parseState(stateBody({ view: "revealed", effectiveView: "revealed" }).hiddenCategories))) === "Technology,Art,Cooking",
);
check(
  "view only keeps hidden categories",
  labels(visibleGroups(groups, parseState(stateBody({ view: "only", effectiveView: "only" }).hiddenCategories))) === "Technology",
);
check(
  "effectiveView wins over view (locked)",
  labels(visibleGroups(groups, parseState(stateBody({ view: "revealed", effectiveView: "hidden" }).hiddenCategories))) === "Art,Cooking",
  "stored revealed, effective hidden",
);
check(
  "without the extension nothing is filtered",
  labels(visibleGroups(groups, unavailableState())) === "Technology,Art,Cooking",
);
check("showsCategory agrees with visibleGroups", showsCategory(state, "Technology") === false && showsCategory(state, "Art") === true);
check("empty group list stays empty", visibleGroups([], state).length === 0);

/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------- lock/unlock --
 *
 * The lock is the extension's curtain. These pin the wire contract the app
 * depends on: a wrong passcode must not look like a successful unlock, and the
 * passcode must reach the server exactly as typed (leading zeroes and all).
 */

{
  const state = {
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [4],
    locked: true,
    hasPasscode: true,
    categories: [{ id: 4, name: "News", hidden: true }],
  };
  const { calls, transport } = recorder(async () => jsonResponse(200, { changed: true, hiddenCategories: state }));

  const result = await lockHidden(transport, SESSION);

  check("lock posts to /v1/lock", calls[0].method === "POST" && calls[0].url.endsWith("/v1/lock"));
  check("lock returns the authoritative state", result.hiddenCategories.locked === true);
  check("lock sends no body", calls[0].body === undefined);
}

{
  const { calls, transport } = recorder(async () =>
    jsonResponse(200, { changed: true, hiddenCategories: { available: true, locked: false, hasPasscode: true } }),
  );

  const ok = await unlockHidden(transport, SESSION, "001234");

  check("unlock posts to /v1/unlock", calls[0].method === "POST" && calls[0].url.endsWith("/v1/unlock"));
  check(
    "unlock sends the passcode unchanged",
    JSON.parse(calls[0].body).passcode === "001234",
    calls[0].body,
  );
  check("unlock reports the new state", ok.hiddenCategories.locked === false);
}

{
  const { transport } = recorder(async () => jsonResponse(200, { changed: true, hiddenCategories: { available: true } }));
  let threw = false;
  try {
    await unlockHidden(transport, SESSION, "");
  } catch (error) {
    threw = error instanceof RangeError;
  }
  check("an empty passcode never reaches the server", threw);
}

{
  const lockedState = {
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [4],
    locked: true,
    hasPasscode: true,
    categories: [],
  };
  const { transport } = recorder(async () =>
    jsonResponse(403, {
      error: { code: "wrong_passcode", message: "Wrong passcode." },
      hiddenCategories: lockedState,
    }),
  );

  let caught = null;
  try {
    await unlockHidden(transport, SESSION, "9999");
  } catch (error) {
    caught = error;
  }

  check("a wrong passcode is an ApiError", caught instanceof ApiError);
  check("with code wrong_passcode", caught?.code === "wrong_passcode");
  check("and stays locked", caught?.state?.locked === true, "state must not be guessed as unlocked");
}

{
  const { calls, transport } = recorder(async () =>
    jsonResponse(200, { changed: true, hiddenCategories: { available: true, hasPasscode: false } }),
  );

  await setHiddenPasscode(transport, SESSION, "");

  check("clearing uses PUT /v1/passcode", calls[0].method === "PUT" && calls[0].url.endsWith("/v1/passcode"));
  check("an empty passcode is sent, not omitted", JSON.parse(calls[0].body).passcode === "");
}

check("state reports a passcode exists", parseState({ available: true, hasPasscode: true }).hasPasscode === true);
check("state defaults hasPasscode to false", parseState({ available: true }).hasPasscode === false);
check("unavailable state has no passcode", unavailableState().hasPasscode === false);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
