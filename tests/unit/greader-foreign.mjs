/**
 * A whole session against a GReader server that is not FreshRSS.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/greader-foreign.mjs
 *
 * `greader-url.mjs` proves the client *asks the right URL* — a fake transport
 * matched on suffixes. It cannot prove a session works, because nothing in it
 * checks a header or a form field. This suite is the other half: a real HTTP
 * server on 127.0.0.1 that behaves like a live Miniflux, strictly enough to
 * refuse a client that gets it wrong.
 *
 * It is shaped by a live server, not by a README. The README said Miniflux
 * served GReader under `/v1`; the server said `/v1` is its REST API and its
 * guard answers `401` to anything else, which a probe reads as "wrong
 * password". Three more things only the live server said: there is no
 * `stream/contents` route (the reading list is ids, then contents), there is no
 * `unread-count` route, and item categories name the server's own user id
 * (`user/1/state/com.google/read`) rather than Google's `user/-`.
 *
 * So each block below is a claim a foreign server makes for us: the mint, the
 * GET header, the POST form field, the two-step read, the state suffix. The
 * last block proves the stub can fail, because a stub that never refuses
 * anything is not a test.
 */
import http from "node:http";
import {
  AuthError,
  READING_LIST,
  STATE_READ,
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

const USER = "wook-reader";
const PASSWORD = "reader-pass";
const TOKEN = `${USER}/9f86d081884c7d659a2feaa0c55ad015`;

// The server's own id in the state categories: what a live Miniflux emits.
const USER_READ = "user/1/state/com.google/read";

const items = [
  {
    id: "tag:google.com,2005:reader/item/0000000000000001",
    title: "A post from a foreign server",
    published: 1_700_000_000,
    timestampUsec: "1700000000000000",
    canonical: [{ href: "https://example.invalid/one" }],
    summary: { content: "<p>One</p>" },
    origin: { streamId: "feed/1", title: "Example" },
  },
  {
    id: "tag:google.com,2005:reader/item/0000000000000002",
    title: "And a second",
    published: 1_700_000_100,
    timestampUsec: "1700000100000000",
    canonical: [{ href: "https://example.invalid/two" }],
    summary: { content: "<p>Two</p>" },
    origin: { streamId: "feed/1", title: "Example" },
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

const routes = new Set([
  "/accounts/ClientLogin",
  "/reader/api/0/user-info",
  "/reader/api/0/token",
  "/reader/api/0/subscription/list",
  "/reader/api/0/tag/list",
  "/reader/api/0/stream/items/ids",
  "/reader/api/0/stream/items/contents",
  "/reader/api/0/edit-tag",
]);

async function handle(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  const method = request.method ?? "GET";
  const entry = { method, path, headerToken: headerToken(request), form: null };
  log.push(entry);

  // `/v1` is the REST API's prefix, and its guard refuses a GReader exchange
  // with 401 rather than 404. That is the trap the probe has to survive.
  if (path.startsWith("/v1/")) {
    return text(response, 401, "Unauthorized\n");
  }

  // A route this server does not implement is a 404 before it is an auth
  // problem: a server with no such route cannot have an opinion about the
  // credential, and a 401 here would be a lie about the password.
  if (!routes.has(path) && !path.startsWith("/reader/api/0/stream/contents/")) {
    if (path.startsWith("/reader/api/0/")) return json(response, 200, []);
    return text(response, 404, "Not Found\n");
  }

  // ClientLogin is the only route reachable signed out, and the only mint.
  if (method === "POST" && path === "/accounts/ClientLogin") {
    const form = new URLSearchParams(await readBody(request));
    entry.form = Object.fromEntries(form);
    if (form.get("Email") !== USER || form.get("Passwd") !== PASSWORD) {
      return text(response, 401, "Unauthorized\n");
    }
    return text(response, 200, `SID=x\nLSID=x\nAuth=${TOKEN}\n`);
  }

  // Everything else is GET-with-GoogleLogin or POST-with-T: this family of
  // servers does not accept the header on a POST at all. The body is read once
  // and kept on the log entry, because a request body can only be consumed once
  // and a second read would refuse a write the client sent correctly.
  if (method === "POST") {
    entry.raw = await readBody(request);
    entry.form = Object.fromEntries(new URLSearchParams(entry.raw));
    if (entry.form.T !== TOKEN) return text(response, 401, "Unauthorized\n");
  } else if (entry.headerToken !== TOKEN) {
    return text(response, 401, "Unauthorized\n");
  }

  if (path === "/reader/api/0/user-info") {
    return json(response, 200, { userId: "1", userName: USER, userProfileId: "1" });
  }
  if (path === "/reader/api/0/token") {
    return text(response, 200, TOKEN);
  }
  if (path === "/reader/api/0/subscription/list") {
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
  if (path === "/reader/api/0/tag/list") {
    return json(response, 200, { tags: [{ id: "user/-/label/News", type: "folder" }] });
  }

  // Not implemented, and answered the way a live server answers it: `200 []`,
  // which is also exactly what an empty reading list would look like.
  if (path.startsWith("/reader/api/0/stream/contents/")) {
    return json(response, 200, []);
  }

  if (path === "/reader/api/0/stream/items/ids") {
    return json(response, 200, { itemRefs: items.map((item) => ({ id: item.id })) });
  }

  if (path === "/reader/api/0/stream/items/contents") {
    const form = new URLSearchParams(entry.raw ?? "");
    const wanted = new Set(form.getAll("i"));
    const chosen = items.filter((item) => wanted.has(item.id));
    return json(response, 200, {
      id: READING_LIST,
      title: "Reading List",
      items: chosen.map((item) => ({
        ...item,
        categories: read.has(item.id) ? [USER_READ] : [],
      })),
    });
  }

  if (path === "/reader/api/0/edit-tag") {
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
check("...and the prefix that answered is the one stored", session.apiPath === "/reader/api/0", session.apiPath);
check("...and it is the server's own token format", session.token === TOKEN, session.token);
check(
  "...after FreshRSS's prefix 404s first, so the order is unchanged",
  log.findIndex((entry) => entry.path === "/api/greader.php/accounts/ClientLogin") === 0,
  log.map((entry) => `${entry.method} ${entry.path}`).join(", "),
);

const logins = log.filter((entry) => entry.path.endsWith("/accounts/ClientLogin"));
check(
  "...and ClientLogin carried the username and the password in the Google form",
  logins.some((entry) => entry.form?.Email === USER && entry.form?.Passwd === PASSWORD),
);

// A wrong password is the server's answer, and it is reported once every prefix
// has been asked: a path that is merely wrong can refuse with 401 too.
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
  "...only after every prefix was asked",
  log.length - before >= 2,
  `${log.length - before} requests: ${log
    .slice(before)
    .map((entry) => `${entry.method} ${entry.path}`)
    .join(", ")}`,
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

// The reading list, on a server with no `stream/contents` route.
const stream = await getStreamContents(transport, session, READING_LIST);
check("a reading list parses without a stream/contents route", stream.items.length === 2, String(stream.items.length));
check("...with its titles", stream.items[0].title === "A post from a foreign server");
check("...and its ids", stream.items[1].id.endsWith("0002"));
check("...and nothing is read yet", stream.items.every((item) => !isRead(item)));

const idsCall = log.find((entry) => entry.path === "/reader/api/0/stream/items/ids");
check("...by asking for the ids first", idsCall !== undefined);
const contentsCall = log.find((entry) => entry.path === "/reader/api/0/stream/items/contents");
check("...then posting those ids for their contents", contentsCall?.method === "POST");
check("...with a write token in the form", contentsCall?.form?.T === TOKEN);

const counts = await getUnreadCounts(transport, session);
check(
  "a server with no unread-count route reports no counts rather than zeros",
  Array.isArray(counts) && counts.length === 0,
  JSON.stringify(counts),
);

/* ---------------------------------------------------------------------------
 * Writing — the half a prefix probe can never reach
 * ------------------------------------------------------------------------- */

const writeToken = await getWriteToken(transport, session);
check("the write token is the auth token on this server", writeToken === TOKEN);

const beforeWrite = log.length;
await editTag(transport, session, { itemIds: [items[0].id], add: [STATE_READ] });

// `editTag` asks for a write token itself, so the POST is not the next entry in
// the log — the token GET is. Find the write, and check the order around it.
const write = log.slice(beforeWrite).find((entry) => entry.path === "/reader/api/0/edit-tag");
check(
  "the write asks for a token first, then posts",
  log.slice(beforeWrite).findIndex((entry) => entry.path === "/reader/api/0/edit-tag") === 1,
  log
    .slice(beforeWrite)
    .map((entry) => entry.path)
    .join(", "),
);
check("the write is a POST to edit-tag", write?.method === "POST" && write.path === "/reader/api/0/edit-tag");
check("...carrying the token as T in the body", write?.form?.T === TOKEN);
check("...the item id", write?.form?.i === items[0].id);
check("...and the read state", write?.form?.a === STATE_READ);

const reread = await getStreamContents(transport, session, READING_LIST);
check("the write landed: the item reads as read", isRead(reread.items[0]));
check(
  "...matched by the state suffix, not by Google's user id",
  isRead(reread.items[0]) && !isRead({ ...reread.items[0], categories: [] }),
);
check("...while its neighbour does not", !isRead(reread.items[1]));

/* ---------------------------------------------------------------------------
 * The stub can fail — otherwise none of the above is a test
 * ------------------------------------------------------------------------- */

const headerOnly = await fetch(`${BASE}/reader/api/0/edit-tag`, {
  method: "POST",
  headers: {
    Authorization: `GoogleLogin auth=${TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ i: items[1].id, a: STATE_READ }).toString(),
});
check("a POST with the header and no T is refused", headerOnly.status === 401, String(headerOnly.status));

const basicOnly = await fetch(`${BASE}/reader/api/0/user-info`, {
  headers: { Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}` },
});
check("a GET with Basic instead of GoogleLogin is refused", basicOnly.status === 401, String(basicOnly.status));

const unauthenticated = await fetch(`${BASE}/reader/api/0/user-info`);
check("a GET with no token is refused", unauthenticated.status === 401, String(unauthenticated.status));

const wrongToken = await fetch(`${BASE}/reader/api/0/user-info`, {
  headers: { Authorization: `GoogleLogin auth=${USER}/nope` },
});
check("a GET with the wrong token is refused", wrongToken.status === 401, String(wrongToken.status));

const v1 = await fetch(`${BASE}/v1/reader/api/0/user-info`, {
  headers: { Authorization: `GoogleLogin auth=${TOKEN}` },
});
check("...and /v1 refuses a GReader exchange with 401, the trap itself", v1.status === 401, String(v1.status));

server.close();

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
