/**
 * API smoke test against the local FreshRSS harness.
 *
 *   docker compose -f tests/integration/compose.yml up -d
 *   node --experimental-strip-types tests/smoke/api.mjs
 *
 * Exercises the real GReader endpoints rather than mocked responses. The
 * harness is disposable, so writes are safe here — never point this at a live
 * instance.
 */
import {
  AuthError,
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
  clientLogin,
  editTag,
  getStreamContents,
  getUnreadCounts,
  getWriteToken,
  isRead,
  isStarred,
  listSubscriptions,
  listTags,
  userInfo,
} from "../../src/api/freshrss.ts";

const BASE = process.env.HARDLYREAD_SERVER ?? "http://127.0.0.1:18080";
const USER = process.env.HARDLYREAD_USER ?? "itest";
const PASS = process.env.HARDLYREAD_API_PASSWORD ?? "itest-api-password";

const transport = (input, init) => fetch(input, init);

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function unreadFor(counts, id) {
  return counts.find((entry) => entry.id === id)?.count ?? -1;
}

const session = await clientLogin(transport, {
  serverUrl: BASE,
  email: USER,
  apiPassword: PASS,
});
check("ClientLogin issues a token", session.token.includes("/"));

const info = await userInfo(transport, session);
check("user-info matches account", info.userName === USER, info.userName);

// Wrong credentials must not authenticate.
for (const [label, password] of [
  ["wrong API password", "definitely-not-it"],
  ["account password", "itest-password"],
]) {
  let raised = false;
  try {
    await clientLogin(transport, { serverUrl: BASE, email: USER, apiPassword: password });
  } catch (error) {
    raised = error instanceof AuthError;
  }
  check(`${label} rejected`, raised);
}

const subscriptions = await listSubscriptions(transport, session);
check("subscription list is non-empty", subscriptions.length > 0, `${subscriptions.length} feeds`);
check(
  "subscriptions expose numeric feed ids",
  subscriptions.every((feed) => /^feed\/\d+$/.test(feed.id)),
);
check(
  "subscriptions carry a category",
  subscriptions.every((feed) => Array.isArray(feed.categories) && feed.categories.length > 0),
);

const tags = await listTags(transport, session);
check("tag list contains the reading list", tags.some((tag) => tag.id === READING_LIST));
check("tag list contains a label", tags.some((tag) => tag.id.startsWith("user/-/label/")));

const countsBefore = await getUnreadCounts(transport, session);
const unreadBefore = unreadFor(countsBefore, READING_LIST);
check("unread counts include the reading list", unreadBefore >= 0, `unread=${unreadBefore}`);

const stream = await getStreamContents(transport, session, READING_LIST, { count: 10 });
check("stream returns items", stream.items.length > 0, `${stream.items.length} items`);
check(
  "items carry an id and origin feed",
  stream.items.every((item) => typeof item.id === "string" && item.origin?.streamId),
);
check(
  "items carry timestamps",
  stream.items.every((item) => typeof item.timestampUsec === "string"),
);

const writeToken = await getWriteToken(transport, session);
check("write token issued", writeToken.length > 0);

// Round-trip read state on one item and restore it afterwards.
const target = stream.items.find((item) => !isRead(item)) ?? stream.items[0];
const wasRead = isRead(target);

if (!wasRead) {
  await editTag(transport, session, { itemIds: [target.id], add: [STATE_READ] });
  const after = unreadFor(await getUnreadCounts(transport, session), READING_LIST);
  check("marking read decrements unread", after === unreadBefore - 1, `${unreadBefore} -> ${after}`);

  const reread = await getStreamContents(transport, session, READING_LIST, { count: 10 });
  check(
    "marked item reports read state",
    isRead(reread.items.find((item) => item.id === target.id) ?? {}),
  );

  await editTag(transport, session, { itemIds: [target.id], remove: [STATE_READ] });
  const restored = unreadFor(await getUnreadCounts(transport, session), READING_LIST);
  check("unmarking restores unread count", restored === unreadBefore, `${after} -> ${restored}`);
} else {
  console.log("SKIP  read round-trip (no unread item available)");
}

// Star round-trip.
const wasStarred = isStarred(target);
await editTag(transport, session, {
  itemIds: [target.id],
  add: wasStarred ? [] : [STATE_STARRED],
  remove: wasStarred ? [STATE_STARRED] : [],
});
const starred = await getStreamContents(transport, session, STATE_STARRED, { count: 10 });
check("star toggles membership of the starred stream", wasStarred
  ? !starred.items.some((item) => item.id === target.id)
  : starred.items.some((item) => item.id === target.id));
await editTag(transport, session, {
  itemIds: [target.id],
  add: wasStarred ? [STATE_STARRED] : [],
  remove: wasStarred ? [] : [STATE_STARRED],
});

// A bad write token must be rejected.
let tokenRejected = false;
const response = await transport(
  `${BASE}/api/greader.php/reader/api/0/edit-tag`,
  {
    method: "POST",
    headers: {
      Authorization: `GoogleLogin auth=${session.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ i: target.id, a: STATE_READ, T: "bogus" }).toString(),
  },
);
tokenRejected = response.status === 401;
check("stale write token rejected with 401", tokenRejected, `HTTP ${response.status}`);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
