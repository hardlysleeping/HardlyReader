/**
 * Where the adapter's routes point when the page is served by a proxy.
 *
 * The PWA on the tailnet cannot reach `misc.php` cross-origin at all (that route
 * sends no `access-control-allow-origin`), so the host serving the page
 * advertises itself with `GET /__proxy` and forwards
 * `/through/<server origin>/<path>`. This suite pins the URL arithmetic and the
 * parse that rides on it:
 *
 *   - no proxy → the absolute server URL, exactly as before the proxy existed
 *   - a proxy + a server elsewhere → `/through/<encoded origin><path>`
 *   - a server that already *is* this origin → still absolute (a hop for nothing)
 *   - a server URL `new URL` cannot read → absolute, never a broken through-URL
 *   - the probe itself, against a stubbed fetch
 *   - `hasPasscode` survives the parse, and a non-200 never becomes `available`
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/proxy-url.mjs
 *
 * `location` does not exist in Node, so the browser-only branches are driven by
 * defining it — the same thing the module's own `typeof location` guard checks —
 * and each suite runs in its own process, so nothing here leaks into another.
 */
import {
  ApiError,
  apiUrl,
  detectProxy,
  getApiState,
  parseApiState,
  setProxyOrigin,
} from "../../src/api/hardlyread.ts";

/* ---------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A page origin, as a browser would expose it. `undefined` means "no location". */
function setLocation(value) {
  if (value === undefined) {
    delete globalThis.location;
    return;
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value });
}

/** A fake transport: `handler(url, init)` answers `[status, body]`. */
function fakeServer(handler) {
  const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    const [status, body] = handler(url, init) ?? [404, ""];
    return new Response(body, { status });
  };
  return { transport, calls };
}

const SERVER = "https://freshrss.example";
const PAGE = "https://pwa.example:8457";
const PREFIX = "/api/misc.php/Hardly%20Read/v1";
const FRESH_ACCOUNT = { serverUrl: SERVER, apiPath: "/api/greader.php", email: "u", token: "t" };

/** What a through-URL for one route looks like, built the way the host reads it. */
function through(origin, path, server = SERVER) {
  const target = new URL(`${server}${PREFIX}${path}`);
  return `${origin}/through/${encodeURIComponent(target.origin)}${target.pathname}${target.search}`;
}

/* ---------------------------------------------------------------------------
 * 1. No proxy: the URL is the server's own, unchanged
 * ------------------------------------------------------------------------- */

setLocation(undefined);
setProxyOrigin(null);

check(
  "no proxy reads as the absolute server URL",
  apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`,
  apiUrl(SERVER, "/state"),
);
check(
  "...with the extension name encoded once",
  apiUrl(SERVER, "/state") === `${SERVER}/api/misc.php/Hardly%20Read/v1/state`,
);
check(
  "...and a query string stays on the route",
  apiUrl(SERVER, "/people?q=a%20b") === `${SERVER}${PREFIX}/people?q=a%20b`,
  apiUrl(SERVER, "/people?q=a%20b"),
);
check(
  "...and a trailing slash on the server is not doubled",
  apiUrl(`${SERVER}///`, "/state") === `${SERVER}${PREFIX}/state`,
  apiUrl(`${SERVER}///`, "/state"),
);
check(
  "...and a subdirectory the server lives in is kept",
  apiUrl(`${SERVER}/freshrss`, "/state") === `${SERVER}/freshrss${PREFIX}/state`,
  apiUrl(`${SERVER}/freshrss`, "/state"),
);

/* ---------------------------------------------------------------------------
 * 2. A proxy, and a server somewhere else: every route goes through it
 * ------------------------------------------------------------------------- */

setLocation({ origin: PAGE, protocol: "https:", host: PAGE.slice("https://".length) });
setProxyOrigin(PAGE);

check(
  "a proxied read goes through the page's host",
  apiUrl(SERVER, "/state") === `${PAGE}/through/https%3A%2F%2Ffreshrss.example${PREFIX}/state`,
  apiUrl(SERVER, "/state"),
);
check(
  "...matching the origin-encoded shape the forwarder parses",
  apiUrl(SERVER, "/state") === through(PAGE, "/state"),
  apiUrl(SERVER, "/state"),
);
check(
  "...the port of the server survives the encoding",
  apiUrl("https://freshrss.example:8449", "/state") ===
    `${PAGE}/through/${encodeURIComponent("https://freshrss.example:8449")}${PREFIX}/state`,
  apiUrl("https://freshrss.example:8449", "/state"),
);
check(
  "...and a subdirectory stays in the forwarded path",
  apiUrl(`${SERVER}/freshrss`, "/state") ===
    `${PAGE}/through/${encodeURIComponent(SERVER)}/freshrss${PREFIX}/state`,
  apiUrl(`${SERVER}/freshrss`, "/state"),
);
check(
  "...with the query string carried, space and all",
  apiUrl(SERVER, "/people?q=a b") === through(PAGE, "/people?q=a%20b"),
  apiUrl(SERVER, "/people?q=a b"),
);
check(
  "...and every route of the surface takes the same road",
  ["/state", "/revision", "/positions", "/preferences", "/lock", "/unlock", "/people/status"].every(
    (route) => apiUrl(SERVER, route).startsWith(`${PAGE}/through/`) && apiUrl(SERVER, route).endsWith(route),
  ),
);
check(
  "...including the view and passcode writes",
  apiUrl(SERVER, "/hidden-categories/view").startsWith(`${PAGE}/through/`) &&
    apiUrl(SERVER, "/passcode").startsWith(`${PAGE}/through/`),
);
check(
  "...while the page's own /__proxy probe is never routed through itself",
  apiUrl(SERVER, "/state").includes("/__proxy") === false,
);

/* ---------------------------------------------------------------------------
 * 3. The server is this very origin: a hop for nothing, so no hop
 * ------------------------------------------------------------------------- */

setProxyOrigin(PAGE);

check(
  "a same-origin server stays absolute",
  apiUrl(PAGE, "/state") === `${PAGE}${PREFIX}/state`,
  apiUrl(PAGE, "/state"),
);
check(
  "...even with a subdirectory",
  apiUrl(`${PAGE}/freshrss`, "/state") === `${PAGE}/freshrss${PREFIX}/state`,
  apiUrl(`${PAGE}/freshrss`, "/state"),
);
check(
  "...and a different port is a different origin, so that one is proxied",
  apiUrl("https://pwa.example:8458", "/state").startsWith(`${PAGE}/through/`),
  apiUrl("https://pwa.example:8458", "/state"),
);
check(
  "...and a different scheme is too",
  apiUrl("http://pwa.example:8457", "/state").startsWith(`${PAGE}/through/`),
  apiUrl("http://pwa.example:8457", "/state"),
);

/* ---------------------------------------------------------------------------
 * 4. A server URL that cannot be read: absolute, never a broken through-URL
 * ------------------------------------------------------------------------- */

setProxyOrigin(PAGE);

const malformed = "https://freshrss.example:99999";
check(
  "a server URL new URL cannot read falls back to absolute",
  apiUrl(malformed, "/state") === `${malformed}${PREFIX}/state`,
  apiUrl(malformed, "/state"),
);
check(
  "...not to a through-URL with a half-parsed origin",
  apiUrl(malformed, "/state").includes("/through/") === false,
);
check(
  "...and a server with no scheme still throws, as it always did",
  (() => {
    try {
      apiUrl("freshrss.example", "/state");
      return false;
    } catch {
      return true;
    }
  })(),
);

/* ---------------------------------------------------------------------------
 * 5. The probe: one same-origin request, and only `{"proxy": true}` counts
 * ------------------------------------------------------------------------- */

/** A `fetch` that answers `/__proxy` with whatever the case under test needs. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, method: init.method ?? "GET" });
    return handler(url, init);
  };
  return calls;
}

const realFetch = globalThis.fetch;

setLocation({ origin: PAGE, protocol: "https:" });
setProxyOrigin(null);
const probeCalls = stubFetch(() => new Response(JSON.stringify({ proxy: true }), { status: 200 }));
await detectProxy();
check("the probe asks the page's own /__proxy", probeCalls[0]?.url === `${PAGE}/__proxy`, probeCalls[0]?.url);
check("...once, with a GET", probeCalls.length === 1 && probeCalls[0].method === "GET");
check(
  "...and a yes turns every adapter URL into a through-URL",
  apiUrl(SERVER, "/state").startsWith(`${PAGE}/through/`),
  apiUrl(SERVER, "/state"),
);

// A WebView without `AbortSignal.timeout` must still find the proxy: a probe
// that threw there would mean "no proxy" on exactly the phone this is for.
const realTimeout = AbortSignal.timeout;
setProxyOrigin(null);
const noTimeoutCalls = stubFetch(() => new Response(JSON.stringify({ proxy: true }), { status: 200 }));
delete AbortSignal.timeout;
let withoutTimeoutThrew = false;
try {
  await detectProxy();
} catch {
  withoutTimeoutThrew = true;
} finally {
  AbortSignal.timeout = realTimeout;
}
check("a runtime without AbortSignal.timeout still probes", withoutTimeoutThrew === false && noTimeoutCalls.length === 1);
check(
  "...and still finds the proxy",
  apiUrl(SERVER, "/state").startsWith(`${PAGE}/through/`),
  apiUrl(SERVER, "/state"),
);

// A host that answers, but not as a proxy. The body is the only thing believed.
setProxyOrigin(null);
stubFetch(() => new Response(JSON.stringify({ proxy: "true" }), { status: 200 }));
await detectProxy();
check("a stringified yes is not a yes", apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`);

// A host with no such route: 404 is "not a proxy", not a failure.
setProxyOrigin(null);
stubFetch(() => new Response("not found", { status: 404 }));
await detectProxy();
check("a 404 at /__proxy leaves the URLs absolute", apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`);

// A host that answers HTML where JSON belongs is also "not a proxy".
setProxyOrigin(null);
stubFetch(() => new Response("<html>hi</html>", { status: 200 }));
await detectProxy();
check("an HTML answer is not a proxy", apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`);

// A refused connection is silence, not a crash.
setProxyOrigin(null);
stubFetch(() => {
  throw new TypeError("Failed to fetch");
});
let probeThrew = false;
try {
  await detectProxy();
} catch {
  probeThrew = true;
}
check("a refused probe does not throw", probeThrew === false);
check("...and leaves the URLs absolute", apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`);

// The desktop app: no http(s) page at all, so no probe is spent.
globalThis.fetch = realFetch;
setLocation({ origin: "tauri://localhost", protocol: "tauri:" });
setProxyOrigin(null);
const desktopCalls = stubFetch(() => new Response(JSON.stringify({ proxy: true }), { status: 200 }));
await detectProxy();
check("a non-http page spends no probe", desktopCalls.length === 0, String(desktopCalls.length));
check("...and stays absolute", apiUrl(SERVER, "/state") === `${SERVER}${PREFIX}/state`);
globalThis.fetch = realFetch;

/* ---------------------------------------------------------------------------
 * 6. What a 200 carries, and what a 401 never does
 * ------------------------------------------------------------------------- */

const REAL_STATE = {
  apiVersion: 1,
  hiddenCategories: {
    available: true,
    mode: "",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [3, 9],
    locked: true,
    hasPasscode: true,
    categories: [{ id: 3, name: "one", hidden: true }],
  },
  favorites: { available: true, view: "all", ids: [4], categories: [] },
  sidebarIndent: { available: true, px: 14, max: 24 },
  peopleAvailable: true,
};

const parsed = parseApiState(REAL_STATE);
check("hasPasscode survives the parse", parsed.hiddenCategories.hasPasscode === true);
check("...beside the rest of the block", parsed.hiddenCategories.available === true &&
  parsed.hiddenCategories.locked === true &&
  same(parsed.hiddenCategories.hiddenIds, [3, 9]) &&
  parsed.hiddenCategories.categories.length === 1);
check("...the pins come through", same(parsed.favorites.ids, [4]));
check("...and the indent", parsed.sidebarIndent.available === true && parsed.sidebarIndent.px === 14);
check("...and the people capability", parsed.peopleAvailable === true);

const noPasscodeKey = parseApiState({
  ...REAL_STATE,
  hiddenCategories: { ...REAL_STATE.hiddenCategories, hasPasscode: undefined },
});
check(
  "a server that never sends hasPasscode reads as false, not as a guess",
  noPasscodeKey.hiddenCategories.hasPasscode === false,
);

const notAvailable = parseApiState({
  ...REAL_STATE,
  hiddenCategories: { ...REAL_STATE.hiddenCategories, available: false },
});
check(
  "a block that says it is not available is not available, passcode and all",
  notAvailable.hiddenCategories.available === false && notAvailable.hiddenCategories.hasPasscode === false,
);

/* The 401 the proxy really answers with: an error, never a parsed state. */

setLocation({ origin: PAGE, protocol: "https:" });
setProxyOrigin(PAGE);

const unauthorised = fakeServer(() => [401, JSON.stringify({ error: { code: "auth_required", message: "Sign in" } })]);
let authError = null;
let authState = null;
try {
  authState = await getApiState(unauthorised.transport, FRESH_ACCOUNT);
} catch (error) {
  authError = error;
}
check("a 401 through the proxy is an error, not a state", authError instanceof ApiError && authError.status === 401);
check("...carrying no hidden block", authError?.state === null && authState === null);
check(
  "...and the request went through the proxy, token and all",
  unauthorised.calls[0]?.url === through(PAGE, "/state") &&
    unauthorised.calls[0]?.headers?.Authorization === "GoogleLogin auth=t",
  JSON.stringify(unauthorised.calls[0]?.headers),
);

/* A 200 that is not the extension's 200: absent blocks stay unavailable. */

const empty = fakeServer(() => [200, JSON.stringify({})]);
const emptyState = await getApiState(empty.transport, FRESH_ACCOUNT);
check(
  "a 200 with no blocks is unavailable, not a blank extension",
  emptyState.hiddenCategories.available === false &&
    emptyState.hiddenCategories.hasPasscode === false &&
    emptyState.favorites.available === false &&
    emptyState.sidebarIndent.available === false,
);

/* And the real shape, read through the proxy end to end. */

const served = fakeServer(() => [200, JSON.stringify(REAL_STATE)]);
const servedState = await getApiState(served.transport, FRESH_ACCOUNT);
check("a real 200 through the proxy parses whole", servedState.hiddenCategories.hasPasscode === true &&
  servedState.hiddenCategories.available === true);
check(
  "...from the through-URL the host forwards",
  served.calls[0]?.url === through(PAGE, "/state"),
  served.calls[0]?.url,
);

setProxyOrigin(null);
setLocation(undefined);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
