/**
 * A whole session against a GReader server that is not FreshRSS.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/greader-foreign.mjs
 *
 * `greader-url.mjs` proves the client *asks the right URL* — a fake transport
 * matched on suffixes. It cannot prove a session works, because nothing in it
 * checks a header or a form field. This suite is the other half: a real HTTP
 * server on 127.0.0.1 that enforces Miniflux's published contract strictly
 * enough to refuse a client that gets it wrong:
 *
 *   - the auth token is `username/hash`, and only `ClientLogin` mints one;
 *   - `GET` must carry `Authorization: GoogleLogin auth=<token>` — Basic is
 *     refused, which is what Miniflux does (`internal/googlereader/middleware.go`);
 *   - `POST` must carry the token as `T` in the form body — the header is not
 *     enough there, and the stub says 401 when it is all it got.
 *
 * So every check below is a claim about the client that a real foreign server
 * would otherwise make for it, and the last few prove the stub can fail: a
 * request shaped the wrong way is refused rather than quietly accepted.
 *
 * What this still does not prove: a live Miniflux, a live The Old Reader, TLS,
 * or a reverse proxy. It proves the exchange, the headers and the write path.
 */
import http from "node:http";
import {
  AuthError,
  READING_LIST,
  STATE_READ,
  clientLogin,
  editTag,
  getStreamContents,
  getUnreadCounts,
  getWriteToken,
  isRead,
  listSubscriptions,
  listTags,
  probeGreaderSession,
  userInfo,
} from "../../src/api/freshrss.ts";

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

/* ---------------------------------------------------------------------------
 * The server
 *
 * State is deliberately small and mutable: two unread items, a read set the
 * writes change, and a log of every request so the assertions can talk about
 * what the client actually sent rather than what it meant to send.
 * ------------------------------------------------------------------------- */

const USER = "wook";
const PASSWORD = "mf-api-token";
const TOKEN = `${USER}/9f86d081884c7d659a2feaa0c55ad015`;

const items = [
  {
    id: "tag:google.com,2005:reader/item/0000000000000001",
    title: "A post from a foreign server",
    published: 1_700_000_000,
    timestampUsec: "1700000000000000",
    canonical: [{ href: "https://example.invalid/one" }],
    summary: { content: "<p>One</p>" },
    origin: { streamId: "feed/1", title: "Example" },
    categories: [],
  },
  {
    id: "tag:google.com,2005:reader/item/0000000000000002",
    title: "And a second",
    published: 1_700_000_100,
    timestampUsec: "1700000100000000",
    canonical: [{ href: "https://example.invalid/two" }],
    summary: { content: "<p>Two</p>" },
    origin: { streamId: "feed/1", title: "Example" },
    categories: [],
  },
];

const read = new Set();
const log = [];

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function text(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/plain" });
  response.end(body);
}

/** `GoogleLogin auth=<token>`, exactly, or nothing. */
function headerToken(request) {
  const header = request.headers.authorization ?? "";
  const fields = header.split(/\s+/);
  if (fields.length !== 2 || fields[0] !== "GoogleLogin") return null;
  const parts = fields[1].split("=");
  if (parts.length !== 2 || parts[0] !== "auth") return null;
  return parts[1];
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function unreadCounts() {
  return {
    max: 1,
    unreadcounts: [
      { id: READING_LIST, count: items.length - read.size, newestItemTimestampUsec: "1700000100000000" },
      { id: "feed/1", count: items.length - read.size, newestItemTimestampUsec: "1700000100000000" },
    ],
  };
}

async function handle(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  const method = request.method ?? "GET";
  const entry = { method, path, headerToken: headerToken(request), form: null };
  log.push(entry);

  // An unknown path is a 404 before it is an auth problem: a server that does
  // not have the route cannot have an opinion about the credential, and a 401
  // here would end a probe that should have moved on to the next prefix.
  const known = new Set([
    "/v1/accounts/ClientLogin",
    "/v1/reader/api/0/user-info",
    "/v1/reader/api/0/token",
    "/v1/reader/api/0/subscription/list",
    "/v1/reader/api/0/tag/list",
    "/v1/reader/api/0/unread-count",
    "/v1/reader/api/0/edit-tag",
  ]);
  const isStream = path.startsWith("/v1/reader/api/0/stream/contents/");
  if (!known.has(path) && !isStream) {
    return text(response, 404, "Not Found\n");
  }

  // ClientLogin is the only route reachable signed out, and the only mint.
  if (method === "POST" && path === "/v1/accounts/ClientLogin") {
    const form = new URLSearchParams(await readBody(request));
    entry.form = Object.fromEntries(form);
    if (form.get("Email") !== USER || form.get("Passwd") !== PASSWORD) {
      return text(response, 401, "Unauthorized\n");
    }
    return text(response, 200, `SID=x\nLSID=x\nAuth=${TOKEN}\n`);
  }

  // Everything else is GET-with-GoogleLogin or POST-with-T. Miniflux refuses a
  // POST that only carries the header, so the stub does too. The body is read
  // once and kept on the log entry: a request body can only be consumed once,
  // and a second read here would refuse a write the client sent correctly.
  if (method === "POST") {
    entry.raw = await readBody(request);
    entry.form = Object.fromEntries(new URLSearchParams(entry.raw));
    if (entry.form.T !== TOKEN) return text(response, 401, "Unauthorized\n");
  } else if (entry.headerToken !== TOKEN) {
    return text(response, 401, "Unauthorized\n");
  }

  if (path === "/v1/reader/api/0/user-info") {
    return json(response, 200, { userId: "1", userName: USER, userProfileId: "1" });
  }
  if (path === "/v1/reader/api/0/token") {
    return text(response, 200, TOKEN);
  }
  if (path === "/v1/reader/api/0/subscription/list") {
    return json(response, 200, {
      subscriptions: [
        {
          id: "feed/1",
          title: "Example",
          url: "https://example.invalid/rss",
          htmlUrl: "https://example.invalid/",
          categories: [],
        },
      ],
    });
  }
  if (path === "/v1/reader/api/0/tag/list") {
    return json(response, 200, {
      tags: [{ id: "user/-/label/News", type: "folder" }],
    });
  }
  if (path === "/v1/reader/api/0/unread-count") {
    return json(response, 200, unreadCounts());
  }
  if (path.startsWith("/v1/reader/api/0/stream/contents/")) {
    return json(response, 200, {
      id: READING_LIST,
      items: items.map((item) => ({
        ...item,
        categories: read.has(item.id) ? [STATE_READ] : [],
      })),
    });
  }
  if (path === "/v1/reader/api/0/edit-tag") {
    const form = new URLSearchParams(entry.raw ?? "");
    const add = form.getAll("a");
    for (const id of form.getAll("i")) {
      if (add.includes(STATE_READ)) read.add(id);
      if (form.getAll("r").includes(STATE_READ)) read.delete(id);
    }
    return text(response, 200, "OK");
  }

  return text(response, 404, "Not Found\n");
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    response.writeHead(500);
    response.end(String(error));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

/** The app's transport, as the desktop has it: plain fetch. */
const transport = (url, init = {}) => fetch(url, init);

const credentials = { serverUrl: BASE, email: USER, apiPassword: PASSWORD };

/* ---------------------------------------------------------------------------
 * Signing in
 * ------------------------------------------------------------------------- */

const session = await probeGreaderSession(transport, credentials);

check("a bare server URL signs in", session !== null);
check(
  "...and the prefix that answered is the one stored",
  session.apiPath === "/v1/reader/api/0",
  session.apiPath,
);
check(
  "...and it is Miniflux's token, not a second format invented here",
  session.token === TOKEN,
  session.token,
);

const logins = log.filter((entry) => entry.path.endsWith("/accounts/ClientLogin"));
check(
  "...and FreshRSS's own prefix was tried first, so the order is unchanged",
  log.findIndex((entry) => entry.path === "/api/greader.php/accounts/ClientLogin") === 0,
  log.map((entry) => `${entry.method} ${entry.path}`).join(", "),
);
check(
  "...and ClientLogin carried the username and the token in the Google form",
  logins.some((entry) => entry.form?.Email === USER && entry.form?.Passwd === PASSWORD),
);
check(
  "...and every prefix after the first was asked with a form, never with a header",
  logins.every((entry) => entry.method === "POST"),
);

// A wrong password is the server's answer, not a reason to try four more paths.
const before = log.length;
let refused = null;
try {
  await probeGreaderSession(transport, { ...credentials, apiPassword: "wrong" });
} catch (error) {
  refused = error;
}
check("a wrong password raises AuthError", refused instanceof AuthError);
check("...with the server's own status", refused?.status === 401, String(refused?.status));
check(
  "...and the probe stops at the refusal instead of trying every prefix",
  log.length - before === 2,
  `${log.length - before} requests: ${log
    .slice(before)
    .map((entry) => `${entry.method} ${entry.path}`)
    .join(", ")}`,
);
check(
  "...the two being the prefix that is not there, then the one that said no",
  log[before]?.path === "/api/greader.php/accounts/ClientLogin" &&
    log[before + 1]?.path === "/v1/accounts/ClientLogin",
);

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------- */

const me = await userInfo(transport, session);
check("user-info answers the account", me.userName === USER, me.userName);

const subscriptions = await listSubscriptions(transport, session);
check("subscription list parses", subscriptions.length === 1 && subscriptions[0].id === "feed/1");
check("...with its URL intact", subscriptions[0].url === "https://example.invalid/rss");

const tags = await listTags(transport, session);
check("label list parses", tags.length === 1 && tags[0].id === "user/-/label/News");

const stream = await getStreamContents(transport, session, READING_LIST);
check("a stream parses", stream.items.length === 2, String(stream.items.length));
check("...with its titles", stream.items[0].title === "A post from a foreign server");
check("...and its ids", stream.items[1].id.endsWith("0002"));
check("...and nothing is read yet", stream.items.every((item) => !isRead(item)));

const counts = await getUnreadCounts(transport, session);
check("unread counts parse", counts.length === 2);
check("...and agree with the stream", counts[0].count === 2, String(counts[0].count));

/* ---------------------------------------------------------------------------
 * Writing — the half a prefix probe can never reach
 * ------------------------------------------------------------------------- */

const writeToken = await getWriteToken(transport, session);
check("the write token is the auth token on this server", writeToken === TOKEN);

const beforeWrite = log.length;
await editTag(transport, session, { itemIds: [items[0].id], add: [STATE_READ] });

// `editTag` asks for a write token itself, so the POST is not the next entry in
// the log — the token GET is. Find the write, and check the order around it.
const write = log.slice(beforeWrite).find((entry) => entry.path === "/v1/reader/api/0/edit-tag");
check(
  "the write asks for a token first, then posts",
  log.slice(beforeWrite).findIndex((entry) => entry.path === "/v1/reader/api/0/edit-tag") === 1,
  log
    .slice(beforeWrite)
    .map((entry) => entry.path)
    .join(", "),
);
check("the write is a POST to edit-tag", write?.method === "POST" && write.path === "/v1/reader/api/0/edit-tag");
check("...carrying the token as T in the body", write?.form?.T === TOKEN);
check("...the item id", write?.form?.i === items[0].id);
check("...and the read state", write?.form?.a === STATE_READ);

const afterWrite = await getUnreadCounts(transport, session);
check("the write landed: unread is one fewer", afterWrite[0].count === 1, String(afterWrite[0].count));

const reread = await getStreamContents(transport, session, READING_LIST);
check("...and the item now reads as read", isRead(reread.items[0]));
check("...while its neighbour does not", !isRead(reread.items[1]));

/* ---------------------------------------------------------------------------
 * The stub can fail — otherwise none of the above is a test
 * ------------------------------------------------------------------------- */

const headerOnly = await fetch(`${BASE}/v1/reader/api/0/edit-tag`, {
  method: "POST",
  headers: { Authorization: `GoogleLogin auth=${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ i: items[1].id, a: STATE_READ }).toString(),
});
check(
  "a POST with the header and no T is refused, as this server refuses it",
  headerOnly.status === 401,
  String(headerOnly.status),
);

const basicOnly = await fetch(`${BASE}/v1/reader/api/0/user-info`, {
  headers: { Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}` },
});
check("a GET with Basic instead of GoogleLogin is refused", basicOnly.status === 401, String(basicOnly.status));

const unauthenticated = await fetch(`${BASE}/v1/reader/api/0/user-info`);
check("a GET with no token is refused", unauthenticated.status === 401, String(unauthenticated.status));

const wrongToken = await fetch(`${BASE}/v1/reader/api/0/user-info`, {
  headers: { Authorization: `GoogleLogin auth=${USER}/nope` },
});
check("a GET with the wrong token is refused", wrongToken.status === 401, String(wrongToken.status));

/* ---------------------------------------------------------------------------
 * A URL that names its own prefix is believed, not probed
 * ------------------------------------------------------------------------- */

const explicit = await clientLogin(transport, { ...credentials, apiPath: "/v1/reader/api/0" });
check("an explicit prefix signs in on the first request", explicit.apiPath === "/v1/reader/api/0");
const explicitLogin = log.filter((entry) => entry.path.endsWith("/accounts/ClientLogin")).at(-1);
check("...without asking FreshRSS's path", explicitLogin?.path === "/v1/accounts/ClientLogin", explicitLogin?.path);

server.close();

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
