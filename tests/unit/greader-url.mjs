/**
 * Where the GReader API lives: the prefix a session carries, the arithmetic
 * that joins it to an API path, the login probe that finds it, and the gate that
 * keeps FreshRSS-only routes off servers that are not FreshRSS.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/greader-url.mjs
 *
 * Pure where it can be — the join and the pasted-URL split need nothing but the
 * module — and a stub transport where it cannot: the probe is a real
 * `ClientLogin` + `user-info` exchange per prefix, so a fake server answers it
 * request by request and records what was asked.
 *
 * The Miniflux and Tiny Tiny RSS cases are stubs shaped like those servers'
 * published URL layout. Nothing here has ever been run against a live Miniflux,
 * and this suite cannot prove one works — it proves the client asks the right
 * URL with the right order, which is the part that was wrong.
 */
import {
  AuthError,
  DEFAULT_API_PATH,
  GREADER_PREFIXES,
  GreaderProbeError,
  greaderPathFor,
  greaderUrl,
  normalizeApiPath,
  parseServerInput,
  probeGreaderSession,
} from "../../src/api/freshrss.ts";
import { clearSession, loadSession, saveSession } from "../../src/api/session.ts";
import {
  ApiError,
  apiUrl,
  getApiState,
  supportsExtensionRoutes,
} from "../../src/api/hardlyread.ts";

/* ---------------------------------------------------------------------------
 * A storage that behaves like the one the app has, without a browser.
 * ------------------------------------------------------------------------- */

const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});
const SESSION_KEY = "hardlyreader.session";

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

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** A fake server: `handler(url, method)` answers `[status, body]`. */
function fakeServer(handler) {
  const calls = [];
  const transport = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method });
    const [status, body] = handler(url, method) ?? [404, "not found"];
    return new Response(body, { status });
  };
  return { transport, calls };
}

const USER_INFO = JSON.stringify({
  userId: "1",
  userName: "itest",
  userProfileId: "1",
  userEmail: "itest@example.invalid",
});
const AUTH_BODY = "SID=itest/0123456789abcdef\nLSID=itest/0123456789abcdef\nAuth=itest/0123456789abcdef \n";

/** FreshRSS as it really addresses things: everything under greader.php. */
function freshRssServer() {
  return (url) => {
    if (url.endsWith("/api/greader.php/accounts/ClientLogin")) return [200, AUTH_BODY];
    if (url.endsWith("/api/greader.php/reader/api/0/user-info")) return [200, USER_INFO];
    return [404, "not found"];
  };
}

/**
 * Miniflux as its own README describes it: the writer API root is
 * `…/v1/reader/api/0` and `ClientLogin` sits one level up, under `…/v1`.
 */
function minifluxServer() {
  return (url) => {
    if (url.endsWith("/v1/accounts/ClientLogin")) return [200, AUTH_BODY];
    if (url.endsWith("/v1/reader/api/0/user-info")) return [200, USER_INFO];
    return [404, "not found"];
  };
}

function creds(serverUrl) {
  return { serverUrl, email: "itest", apiPassword: "itest-api-password" };
}

/* ---------------------------------------------------------------------------
 * The join: a prefix plus one of the API's own paths
 * ------------------------------------------------------------------------- */

const HOST = "https://a.example";

check(
  "FreshRSS's URL is byte-identical to the hardcoded one",
  greaderUrl(HOST, "/reader/api/0/user-info") === `${HOST}/api/greader.php/reader/api/0/user-info`,
  greaderUrl(HOST, "/reader/api/0/user-info"),
);
check(
  "...and the same when the default is named",
  greaderUrl(HOST, "/reader/api/0/user-info", DEFAULT_API_PATH) ===
    `${HOST}/api/greader.php/reader/api/0/user-info`,
);
check(
  "FreshRSS's ClientLogin is inside greader.php",
  greaderUrl(HOST, "/accounts/ClientLogin") === `${HOST}/api/greader.php/accounts/ClientLogin`,
);
check(
  "a trailing slash on the server adds nothing",
  greaderUrl(`${HOST}///`, "/reader/api/0/user-info") === `${HOST}/api/greader.php/reader/api/0/user-info`,
);
check(
  "a FreshRSS in a subdirectory keeps it in the URL",
  greaderUrl(`${HOST}/freshrss`, "/reader/api/0/user-info") ===
    `${HOST}/freshrss/api/greader.php/reader/api/0/user-info`,
);

check(
  "Miniflux's root is not doubled",
  greaderUrl("https://m.example", "/reader/api/0/user-info", "/v1/reader/api/0") ===
    "https://m.example/v1/reader/api/0/user-info",
  greaderUrl("https://m.example", "/reader/api/0/user-info", "/v1/reader/api/0"),
);
check(
  "Miniflux's ClientLogin is one level up from the reader root",
  greaderUrl("https://m.example", "/accounts/ClientLogin", "/v1/reader/api/0") ===
    "https://m.example/v1/accounts/ClientLogin",
  greaderUrl("https://m.example", "/accounts/ClientLogin", "/v1/reader/api/0"),
);
check(
  "the bare /v1 prefix works too",
  greaderUrl("https://m.example", "/reader/api/0/user-info", "/v1") ===
    "https://m.example/v1/reader/api/0/user-info",
);
check(
  "Miniflux's write token",
  greaderUrl("https://m.example", "/reader/api/0/token", "/v1/reader/api/0") ===
    "https://m.example/v1/reader/api/0/token",
);
check(
  "Miniflux's subscription edit keeps the stream id readable",
  greaderUrl("https://m.example", "/reader/api/0/subscription/edit", "/v1/reader/api/0") ===
    "https://m.example/v1/reader/api/0/subscription/edit",
);

check(
  "The Old Reader's reader root",
  greaderUrl("https://theoldreader.com", "/reader/api/0/user-info", "/reader/api/0") ===
    "https://theoldreader.com/reader/api/0/user-info",
);
check(
  "The Old Reader's ClientLogin is at the host root",
  greaderUrl("https://theoldreader.com", "/accounts/ClientLogin", "/reader/api/0") ===
    "https://theoldreader.com/accounts/ClientLogin",
);

check(
  "Tiny Tiny RSS's plugin root keeps the API path under it",
  greaderUrl("https://t.example", "/reader/api/0/user-info", "/plugins/greader/api") ===
    "https://t.example/plugins/greader/api/reader/api/0/user-info",
);
check(
  "Tiny Tiny RSS's ClientLogin",
  greaderUrl("https://t.example", "/accounts/ClientLogin", "/plugins/greader/api") ===
    "https://t.example/plugins/greader/api/accounts/ClientLogin",
);

check(
  "a prefix with no leading slash is canonicalised",
  greaderUrl(HOST, "/reader/api/0/user-info", "v1/reader/api/0") ===
    "https://a.example/v1/reader/api/0/user-info",
);
check(
  "a prefix with a trailing slash is canonicalised",
  greaderUrl(HOST, "/reader/api/0/user-info", "/v1/reader/api/0/") ===
    "https://a.example/v1/reader/api/0/user-info",
);
check("an empty prefix means FreshRSS", normalizeApiPath("") === DEFAULT_API_PATH);
check("a missing prefix means FreshRSS", normalizeApiPath(undefined) === DEFAULT_API_PATH);
check("a blank prefix means FreshRSS", normalizeApiPath("   ") === DEFAULT_API_PATH);
check(
  "a path that is not reader-relative is appended as-is",
  greaderPathFor("/v1/reader/api/0", "/misc/thing") === "/v1/reader/api/0/misc/thing",
);
check(
  "a stream id containing slashes survives",
  greaderUrl(HOST, "/reader/api/0/stream/contents/feed/https://x.example/rss", "/v1/reader/api/0") ===
    "https://a.example/v1/reader/api/0/stream/contents/feed/https://x.example/rss",
);
check("a URL with no scheme is refused", throws(() => greaderUrl("a.example", "/reader/api/0/x")));

/* ---------------------------------------------------------------------------
 * One field on the login screen: what a pasted URL already told us
 * ------------------------------------------------------------------------- */

const bare = parseServerInput("https://a.example/");
check("a bare server names no prefix", bare.apiPath === "" && bare.serverUrl === "https://a.example");
check(
  "a pasted FreshRSS path is split off",
  same(parseServerInput("https://a.example/api/greader.php"), {
    serverUrl: "https://a.example",
    apiPath: "/api/greader.php",
  }),
);
check(
  "a pasted Miniflux path is split off",
  same(parseServerInput("https://m.example/v1/reader/api/0"), {
    serverUrl: "https://m.example",
    apiPath: "/v1/reader/api/0",
  }),
);
check(
  "...and is not mistaken for the shorter /reader/api/0",
  parseServerInput("https://m.example/v1/reader/api/0").apiPath === "/v1/reader/api/0",
);
check(
  "a pasted Old Reader path is split off",
  same(parseServerInput("https://theoldreader.com/reader/api/0"), {
    serverUrl: "https://theoldreader.com",
    apiPath: "/reader/api/0",
  }),
);
check(
  "a pasted tt-rss plugin path is split off",
  same(parseServerInput("https://t.example/plugins/greader/api"), {
    serverUrl: "https://t.example",
    apiPath: "/plugins/greader/api",
  }),
);
check(
  "a trailing slash after the pasted path",
  parseServerInput("https://a.example/api/greader.php/").apiPath === "/api/greader.php",
);
check(
  "a subdirectory stays part of the server",
  parseServerInput("https://a.example/freshrss/api/greader.php").serverUrl ===
    "https://a.example/freshrss",
);
check(
  "a path that is not an API root stays in the URL",
  same(parseServerInput("https://a.example/reader"), {
    serverUrl: "https://a.example/reader",
    apiPath: "",
  }),
);
check(
  "an unusual greader.php location is still FreshRSS",
  same(parseServerInput("https://a.example/private/greader.php"), {
    serverUrl: "https://a.example/private",
    apiPath: "/greader.php",
  }),
);
check(
  "an uppercase scheme still splits",
  parseServerInput("HTTPS://A.example/api/greader.php").apiPath === "/api/greader.php",
);
check("a URL with no scheme is refused", throws(() => parseServerInput("a.example")));

/* ---------------------------------------------------------------------------
 * The probe, against a stub server
 * ------------------------------------------------------------------------- */

const fresh = fakeServer(freshRssServer());
const freshSession = await probeGreaderSession(fresh.transport, creds(HOST));
check("FreshRSS answers on the first prefix", freshSession.apiPath === DEFAULT_API_PATH);
check("...after one exchange, not four", fresh.calls.length === 2, String(fresh.calls.length));
check(
  "...with ClientLogin first",
  fresh.calls[0].url === `${HOST}/api/greader.php/accounts/ClientLogin` && fresh.calls[0].method === "POST",
  fresh.calls[0]?.url,
);
check(
  "...then user-info with the token",
  fresh.calls[1].url === `${HOST}/api/greader.php/reader/api/0/user-info`,
  fresh.calls[1]?.url,
);
check(
  "the stored session carries no product name",
  same(Object.keys(freshSession).sort(), ["apiPath", "email", "serverUrl", "token"]),
  Object.keys(freshSession).join(","),
);
check("...and the server URL is normalised", freshSession.serverUrl === HOST);

const mini = fakeServer(minifluxServer());
const miniSession = await probeGreaderSession(mini.transport, creds("https://m.example/"));
check("Miniflux is found on the second prefix", miniSession.apiPath === "/v1/reader/api/0", miniSession.apiPath);
check(
  "...only after FreshRSS's first guess 404s",
  mini.calls[0].url === "https://m.example/api/greader.php/accounts/ClientLogin",
  mini.calls[0]?.url,
);
check(
  "...with the login under /v1",
  mini.calls[1].url === "https://m.example/v1/accounts/ClientLogin",
  mini.calls[1]?.url,
);
check(
  "...and user-info under the reader root",
  mini.calls[2].url === "https://m.example/v1/reader/api/0/user-info",
  mini.calls[2]?.url,
);
check("...which is 3 requests in all", mini.calls.length === 3, String(mini.calls.length));

const pasted = fakeServer(minifluxServer());
const pastedSession = await probeGreaderSession(pasted.transport, creds("https://m.example/v1/reader/api/0"));
check("a pasted API path is probed first", pasted.calls.length === 2, String(pasted.calls.length));
check("...so no 404 is spent on a guess", !pasted.calls[0].url.includes("/api/greader.php"));
check("...and the prefix is stored", pastedSession.apiPath === "/v1/reader/api/0");
check("...on the server without the path", pastedSession.serverUrl === "https://m.example");

const oldReader = fakeServer((url) => {
  if (url === "https://theoldreader.com/accounts/ClientLogin") return [200, AUTH_BODY];
  if (url === "https://theoldreader.com/reader/api/0/user-info") return [200, USER_INFO];
  return [404, "not found"];
});
const oldReaderSession = await probeGreaderSession(oldReader.transport, creds("https://theoldreader.com"));
check("The Old Reader is found on the third prefix", oldReaderSession.apiPath === "/reader/api/0");
check(
  "...after /api/greader.php and /v1/reader/api/0 both 404",
  oldReader.calls.length === 4 && oldReader.calls[1].url === "https://theoldreader.com/v1/accounts/ClientLogin",
  String(oldReader.calls.length),
);

const ttrss = fakeServer((url) => {
  if (url === "https://t.example/plugins/greader/api/accounts/ClientLogin") return [200, AUTH_BODY];
  if (url === "https://t.example/plugins/greader/api/reader/api/0/user-info") return [200, USER_INFO];
  return [404, "not found"];
});
const ttrssSession = await probeGreaderSession(ttrss.transport, creds("https://t.example"));
check("Tiny Tiny RSS's plugin prefix is found last", ttrssSession.apiPath === "/plugins/greader/api");

/* Every prefix failing is an answer, not a half-saved session. */

const dead = fakeServer(() => [404, "not found"]);
let deadError = null;
try {
  await probeGreaderSession(dead.transport, creds(HOST));
} catch (error) {
  deadError = error;
}
check("a server with no GReader API raises a probe error", deadError instanceof GreaderProbeError);
check("...naming every prefix it tried", same(deadError?.attempts.map((a) => a.apiPath), [...GREADER_PREFIXES]));
check("...with a reason for each", deadError?.attempts.every((a) => a.reason === "HTTP 404") === true);
check("...in the message, so the reader can act", deadError?.message.includes("/plugins/greader/api") === true);
check("...naming the server", deadError?.message.includes(HOST) === true);
check("...and it is one request per prefix", dead.calls.length === GREADER_PREFIXES.length, String(dead.calls.length));

/* A wrong password is the server's answer, and it ends the search. */

const wrongPassword = fakeServer((url) => (url.endsWith("/accounts/ClientLogin") ? [401, "Error=BadAuthentication"] : [404, ""]));
let authError = null;
try {
  await probeGreaderSession(wrongPassword.transport, creds(HOST));
} catch (error) {
  authError = error;
}
check("a 401 is reported as a credential problem", authError instanceof AuthError);
check("...with its status kept", authError?.status === 401);
check("...and the probe stops there", wrongPassword.calls.length === 1, String(wrongPassword.calls.length));

/* A 200 that is not a token is not an answer either. */

const htmlPage = fakeServer((url) => {
  if (url === "https://a.example/api/greader.php/accounts/ClientLogin") return [200, "<html>sign in</html>"];
  if (url === "https://a.example/v1/accounts/ClientLogin") return [200, AUTH_BODY];
  if (url === "https://a.example/v1/reader/api/0/user-info") return [200, USER_INFO];
  return [404, "not found"];
});
const htmlSession = await probeGreaderSession(htmlPage.transport, creds(HOST));
check("an HTML page where a token belongs is skipped", htmlSession.apiPath === "/v1/reader/api/0", htmlSession.apiPath);

/* A prefix that hands out a token but has no user-info is not the one. */

const halfServer = fakeServer((url) => (url.endsWith("/accounts/ClientLogin") ? [200, AUTH_BODY] : [404, ""]));
let halfError = null;
try {
  await probeGreaderSession(halfServer.transport, creds(HOST));
} catch (error) {
  halfError = error;
}
check("a prefix with no user-info is skipped", halfError instanceof GreaderProbeError);
check(
  "...and asked twice per prefix before giving up",
  halfServer.calls.length === GREADER_PREFIXES.length * 2,
  String(halfServer.calls.length),
);

/* ---------------------------------------------------------------------------
 * A saved session: the old shape loads, the new one round-trips
 * ------------------------------------------------------------------------- */

clearSession();
check("an empty store is no session", loadSession() === null);

localStorage.setItem(
  SESSION_KEY,
  JSON.stringify({ serverUrl: "https://old.example", email: "u", token: "old/token" }),
);
const oldSession = loadSession();
check("a session saved before prefixes existed still loads", oldSession !== null);
check("...meaning FreshRSS's prefix", oldSession?.apiPath === DEFAULT_API_PATH);
check("...keeping its server and token", oldSession?.serverUrl === "https://old.example" && oldSession?.token === "old/token");
check("...and is not thrown away", localStorage.getItem(SESSION_KEY) !== null);

saveSession({ serverUrl: "https://m.example", apiPath: "v1/reader/api/0/", email: "u", token: "t" });
const stored = JSON.parse(localStorage.getItem(SESSION_KEY));
check("a saved session carries the prefix", stored.apiPath === "/v1/reader/api/0", stored.apiPath);
check("...and loads back as the server it is", loadSession()?.apiPath === "/v1/reader/api/0");

localStorage.setItem(
  SESSION_KEY,
  JSON.stringify({ serverUrl: "https://a.example", apiPath: 7, email: "u", token: "t" }),
);
check("an unreadable prefix falls back instead of logging out", loadSession()?.apiPath === DEFAULT_API_PATH);

localStorage.setItem(
  SESSION_KEY,
  JSON.stringify({ serverUrl: "https://a.example", apiPath: "", email: "u", token: "t" }),
);
check("an empty prefix reads as FreshRSS", loadSession()?.apiPath === DEFAULT_API_PATH);

localStorage.setItem(SESSION_KEY, "{not json");
check("a corrupt entry is discarded", loadSession() === null && localStorage.getItem(SESSION_KEY) === null);

saveSession({ serverUrl: HOST, apiPath: DEFAULT_API_PATH, email: "u", token: "t" });
clearSession();
check("signing out removes the entry", loadSession() === null);

/* ---------------------------------------------------------------------------
 * Extension routes: FreshRSS only
 * ------------------------------------------------------------------------- */

const freshAccount = { serverUrl: HOST, apiPath: "/api/greader.php", email: "u", token: "t" };
const miniAccount = { serverUrl: "https://m.example", apiPath: "/v1/reader/api/0", email: "u", token: "t" };

check("FreshRSS carries the adapter", supportsExtensionRoutes(freshAccount) === true);
check("Miniflux does not", supportsExtensionRoutes(miniAccount) === false);
check(
  "The Old Reader does not",
  supportsExtensionRoutes({ ...miniAccount, apiPath: "/reader/api/0" }) === false,
);
check(
  "a session with no prefix is treated as FreshRSS",
  supportsExtensionRoutes({ serverUrl: HOST, email: "u", token: "t" }) === true,
);

const quiet = fakeServer(() => [200, "{}"]);
let gate = null;
try {
  await getApiState(quiet.transport, miniAccount);
} catch (error) {
  gate = error;
}
check("nothing extension-backed is asked of a non-FreshRSS server", quiet.calls.length === 0, String(quiet.calls.length));
check(
  "...and it is the 404 every caller already reads as 'no extension'",
  gate instanceof ApiError && gate.status === 404 && gate.code === "route_not_found",
  gate?.code,
);

const freshApi = fakeServer((url) => (url.includes("/api/misc.php/") ? [200, JSON.stringify({ apiVersion: 1 })] : [404, ""]));
const state = await getApiState(freshApi.transport, freshAccount);
check(
  "FreshRSS still gets the state route",
  freshApi.calls[0]?.url === apiUrl(HOST, "/state"),
  freshApi.calls[0]?.url,
);
check(
  "...addressed through misc.php",
  freshApi.calls[0]?.url === `${HOST}/api/misc.php/Hardly%20Read/v1/state`,
  freshApi.calls[0]?.url,
);
check("...and the answer is parsed", state.apiVersion === 1 && state.hiddenCategories.available === false);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
