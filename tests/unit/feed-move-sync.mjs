/**
 * The category-move wire contract.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feed-move-sync.mjs
 *
 * A drag between categories is the one sidebar gesture that changes something
 * on the account, so what leaves the client is pinned here request-by-request
 * against a fake transport: no server, no network. `moveFeed` reaches the wire
 * through exactly two requests — `GET …/reader/api/0/token` for the write token
 * and the `POST …/subscription/edit` that carries the move — and every check
 * below reads the recorded `POST` body rather than the app's own idea of it.
 *
 * The rules being locked:
 *   into a category   ac=edit, s=feed/<url>, a=…/<new>, r=…/<old>
 *   to Uncategorized  the old label is removed and nothing is added
 *   from Uncategorized only the new label is added
 *   nowhere to go     no request at all
 *
 * The last block re-runs the feed-order suite and reads the drag handler, so a
 * change here cannot quietly take the arrangement path with it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthError, HttpError, feedStreamId, moveFeed } from "../../src/api/freshrss.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${detail})`}`);
  }
}

const FEED_URL = "https://example.com/feed.xml";
const STREAM_ID = feedStreamId(FEED_URL);
const WRITE_TOKEN = "write-token-abc123";

const SESSION = {
  serverUrl: "https://reader.example",
  apiPath: "/api/greader.php",
  email: "tester",
  token: "tester/0123456789abcdef",
};

const TOKEN_URL = "https://reader.example/api/greader.php/reader/api/0/token";
const EDIT_URL = "https://reader.example/api/greader.php/reader/api/0/subscription/edit";

/**
 * A transport that answers the write-token request and records everything.
 *
 * `writeStatus` is the status of the `subscription/edit` POST, so the failure
 * paths `arrangeFeed` rolls back on can be exercised without a server.
 */
function recorder(writeStatus = 200) {
  const calls = [];
  const transport = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ?? null,
      headers: init.headers ?? {},
    });
    if (url === TOKEN_URL) return new Response(WRITE_TOKEN, { status: 200 });
    return new Response("OK", { status: writeStatus, headers: { "Content-Type": "text/plain" } });
  };
  const posts = () => calls.filter((call) => call.method === "POST");
  return { calls, posts, transport };
}

/** The POST body as the server reads it. */
const bodyOf = (call) => new URLSearchParams(call.body ?? "");

// ---- 1. into a category: add the new label, remove the old one ----
{
  const rec = recorder();
  await moveFeed(rec.transport, SESSION, STREAM_ID, "Tech", "Design");

  const posts = rec.posts();
  check("a category move is exactly one POST", posts.length === 1, `${posts.length}`);
  const [post] = posts;
  check(
    "it is posted to the session's API root, as subscription/edit",
    post?.url === EDIT_URL,
    post?.url,
  );
  check("it carries the write token it was just issued", bodyOf(post).get("T") === WRITE_TOKEN, bodyOf(post).get("T"));
  check(
    "the body is form-encoded, not JSON",
    (post?.headers["Content-Type"] ?? "") === "application/x-www-form-urlencoded" && !String(post?.body).startsWith("{"),
    post?.headers["Content-Type"],
  );
  check(
    "the move is sent for the signed-in account",
    (post?.headers.Authorization ?? "") === `GoogleLogin auth=${SESSION.token}`,
    post?.headers.Authorization,
  );

  const params = bodyOf(post);
  check("ac=edit is what makes it a subscription change", params.get("ac") === "edit", params.get("ac"));
  check("s names the feed being moved", params.get("s") === STREAM_ID, params.get("s"));
  check("s is the feed's URL stream id, as Feedbin/GReader spell it", params.get("s") === `feed/${FEED_URL}`);
  check("a adds the category it lands in", params.get("a") === "user/-/label/Tech", params.get("a"));
  check("r removes the category it left", params.get("r") === "user/-/label/Design", params.get("r"));
  check(
    "the feed URL is not quietly re-encoded away",
    String(post?.body).includes(`s=${encodeURIComponent(STREAM_ID)}`),
    post?.body,
  );
}

// ---- 2. to Uncategorized: no label to add ----
{
  const rec = recorder();
  await moveFeed(rec.transport, SESSION, STREAM_ID, null, "Design");

  const posts = rec.posts();
  check("Uncategorized is still one POST", posts.length === 1, `${posts.length}`);
  const params = bodyOf(posts[0]);
  check("Uncategorized sends no add param", params.has("a") === false, params.get("a"));
  check("Uncategorized is never a label on the wire", !String(posts[0]?.body).includes("Uncategorized"));
  check("Uncategorized is expressed by removing the old label", params.get("r") === "user/-/label/Design", params.get("r"));
  check("and it is still an edit of that feed", params.get("ac") === "edit" && params.get("s") === STREAM_ID);
}

// ---- 3. from Uncategorized: no old label to remove ----
{
  const rec = recorder();
  await moveFeed(rec.transport, SESSION, STREAM_ID, "Tech", null);

  const posts = rec.posts();
  check("filing an uncategorized feed is one POST", posts.length === 1, `${posts.length}`);
  const params = bodyOf(posts[0]);
  check("it sends the add param", params.get("a") === "user/-/label/Tech", params.get("a"));
  check("it sends no remove param", params.has("r") === false, params.get("r"));
  check("Uncategorized is not removed as a label either", !String(posts[0]?.body).includes("r=user/-/label/Uncategorized"));
}

// ---- 4. nowhere to go: no request at all ----
{
  const rec = recorder();
  let threw = null;
  try {
    await moveFeed(rec.transport, SESSION, STREAM_ID, null, null);
  } catch (error) {
    threw = error;
  }
  check("a move with neither side resolves", threw === null, threw?.message);
  check("a move with neither side sends nothing at all", rec.calls.length === 0, `${rec.calls.length} call(s)`);
  check("not even a write token is fetched", rec.calls.every((call) => call.url !== TOKEN_URL));
  check("so no subscription edit is posted", rec.posts().length === 0, `${rec.posts().length}`);
}

{
  // Empty strings are how the caller from the sidebar says the same thing.
  const rec = recorder();
  await moveFeed(rec.transport, SESSION, STREAM_ID, "", "");
  check("empty labels are the same absence", rec.calls.length === 0, `${rec.calls.length} call(s)`);
}

{
  // The label it already has is not a move out of it: remove nothing, add it.
  const rec = recorder();
  await moveFeed(rec.transport, SESSION, STREAM_ID, "Tech", "Tech");
  const posts = rec.posts();
  check("a label is never removed and added in the same request", bodyOf(posts[0]).get("r") === null);
  check("but the add is still sent", bodyOf(posts[0]).get("a") === "user/-/label/Tech", bodyOf(posts[0]).get("a"));
}

// ---- failures have to reject, so arrangeFeed can put the feed back ----
{
  const rec = recorder(500);
  let error = null;
  try {
    await moveFeed(rec.transport, SESSION, STREAM_ID, "Tech", "Design");
  } catch (caught) {
    error = caught;
  }
  check("a refused move rejects", error !== null);
  check("with an HttpError carrying the server's status", error instanceof HttpError && error.status === 500, `${error?.name} ${error?.status}`);
  check("naming the action in its message", /Move failed \(HTTP 500\)/.test(error?.message ?? ""), error?.message);
}

{
  const calls = [];
  const transport = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET" });
    if (url === TOKEN_URL) return new Response(WRITE_TOKEN, { status: 200 });
    return new Response("nope", { status: 401 });
  };
  let error = null;
  try {
    await moveFeed(transport, SESSION, STREAM_ID, "Tech", "Design");
  } catch (caught) {
    error = caught;
  }
  check("a rejected write token is an AuthError", error instanceof AuthError && error.status === 401, `${error?.name} ${error?.status}`);
}

// ---- 5. the arrangement path this sits under is untouched ----
{
  const here = dirname(fileURLToPath(import.meta.url));
  const orderSuite = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./register-ts.mjs", "feed-order.mjs"],
    { cwd: here, encoding: "utf8" },
  );
  const orderOutput = `${orderSuite.stdout ?? ""}${orderSuite.stderr ?? ""}`;
  check("the feed-order suite still passes", orderSuite.status === 0, `exit ${orderSuite.status}`);
  check(
    "and it still reports no failures",
    /checks, 0 failure\(s\)/.test(orderOutput),
    orderOutput.trim().split("\n").filter(Boolean).pop(),
  );

  const state = readFileSync(new URL("../../src/state/reader.svelte.ts", import.meta.url), "utf8");
  const flat = state.replace(/\s+/g, " ");
  const api = readFileSync(new URL("../../src/api/freshrss.ts", import.meta.url), "utf8").replace(/\s+/g, " ");

  check(
    "arrangeFeed hands the move the same to/from it always did",
    /await backend\.moveFeed\(\{ streamId, to: targetLabel, from: currentLabel \}\)/.test(flat),
  );
  check(
    "the move is made once, from one place",
    state.match(/\.moveFeed\(/g)?.length === 1,
    `${state.match(/\.moveFeed\(/g)?.length}`,
  );
  check(
    "a failed move still restores the categories the feed had",
    /catch \(error\) \{ feed\.categories = previousCategories; this\.feedOrder = previousOrder;/.test(flat),
  );
  check(
    "and the order with them",
    /feed\.categories = previousCategories; this\.feedOrder = previousOrder; this\.savePrefs\(\); this\.error = message\(error\); return false;/.test(flat),
  );
  check(
    "a drag inside one category never becomes a server move",
    /if \(sameCategory\) \{ this\.sendPositions\(\); return true; \}/.test(flat),
  );
  check(
    "the wire contract itself still names ac=edit on subscription/edit",
    /new URLSearchParams\(\{ ac: "edit", s: streamId \}\)/.test(api) && /subscription\/edit/.test(api),
    api.includes('ac: "edit"') ? "" : "ac=edit not found in freshrss.ts",
  );
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
