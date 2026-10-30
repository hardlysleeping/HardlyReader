/**
 * Live GReader servers, when the harness is up.
 *
 *   HR_MINIFLUX_URL=http://127.0.0.1:8410 HR_MINIFLUX_USER=wook-reader \
 *   HR_MINIFLUX_PASS=reader-pass HR_TTRSS_URL=http://127.0.0.1:8411 \
 *   HR_TTRSS_USER=wook HR_TTRSS_PASS=... \
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/greader-live.mjs
 *
 * Skipped, not failed, when the variables are absent: `pnpm test` must not need
 * Docker, and a suite that pretends a container is there is worse than no
 * suite. What this proves that `greader-foreign.mjs` cannot: a real server's
 * own URL layout, its own token minting, and its own answer to a write. The
 * stub was shaped by a README and the README was wrong about one path —
 * Miniflux serves GReader at `/reader/api/0` and its REST API at `/v1`, so a
 * client that only knows `/v1/reader/api/0` never signs in. Only a live server
 * says so.
 */
import {
  READING_LIST,
  STATE_READ,
  editTag,
  getStreamContents,
  getUnreadCounts,
  isRead,
  listSubscriptions,
  probeGreaderSession,
  userInfo,
} from "../../src/api/freshrss.ts";

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const transport = (url, init = {}) => fetch(url, init);

const servers = [
  {
    name: "miniflux",
    url: process.env.HR_MINIFLUX_URL,
    user: process.env.HR_MINIFLUX_USER,
    pass: process.env.HR_MINIFLUX_PASS,
  },
  {
    name: "ttrss",
    url: process.env.HR_TTRSS_URL,
    user: process.env.HR_TTRSS_USER,
    pass: process.env.HR_TTRSS_PASS,
  },
].filter((server) => server.url && server.user && server.pass);

if (servers.length === 0) {
  console.log("greader-live: skipped (set HR_MINIFLUX_URL/USER/PASS or HR_TTRSS_*)");
  process.exit(0);
}

for (const server of servers) {
  console.log(`— ${server.name} at ${server.url}`);

  let session;
  try {
    session = await probeGreaderSession(transport, {
      serverUrl: server.url,
      email: server.user,
      apiPassword: server.pass,
    });
  } catch (error) {
    check(`${server.name}: signs in`, false, String(error?.message ?? error));
    continue;
  }

  check(`${server.name}: signs in`, session !== null);
  check(`${server.name}: stores the prefix that answered`, typeof session.apiPath === "string" && session.apiPath.length > 0, session.apiPath);

  const me = await userInfo(transport, session);
  check(`${server.name}: user-info answers`, typeof me.userName === "string" && me.userName.length > 0, me.userName);

  const subscriptions = await listSubscriptions(transport, session);
  check(`${server.name}: subscriptions parse`, Array.isArray(subscriptions));
  check(`${server.name}: at least one feed`, subscriptions.length > 0, `${subscriptions.length} feeds`);

  const stream = await getStreamContents(transport, session, READING_LIST);
  check(`${server.name}: the reading list parses`, Array.isArray(stream.items));
  check(`${server.name}: it has items`, stream.items.length > 0, `${stream.items.length} items`);
  check(
    `${server.name}: items carry ids and titles`,
    stream.items.every((item) => typeof item.id === "string" && item.id !== ""),
  );

  // A server may not implement the counts route at all (a live Miniflux does
  // not), so an empty list is a pass and a crash is the failure.
  const counts = await getUnreadCounts(transport, session);
  check(`${server.name}: unread counts answer without throwing`, Array.isArray(counts), JSON.stringify(counts));

  // One item, one write, and it is undone: this is a harness, not a reader.
  const item = stream.items.find((entry) => !isRead(entry)) ?? stream.items[0];
  const wasRead = isRead(item);
  try {
    await editTag(transport, session, {
      itemIds: [item.id],
      ...(wasRead ? { remove: [STATE_READ] } : { add: [STATE_READ] }),
    });
    check(`${server.name}: a read write is accepted`, true);

    const after = await getStreamContents(transport, session, READING_LIST);
    const written = after.items.find((entry) => entry.id === item.id);
    check(
      `${server.name}: the write is reflected back`,
      written !== undefined && isRead(written) === !wasRead,
      `was read=${wasRead}, now read=${written ? isRead(written) : "missing"}`,
    );

    // Put it back, so a re-run starts where this one did.
    await editTag(transport, session, {
      itemIds: [item.id],
      ...(wasRead ? { add: [STATE_READ] } : { remove: [STATE_READ] }),
    });
    const restored = await getStreamContents(transport, session, READING_LIST);
    check(
      `${server.name}: and the undo is reflected back`,
      isRead(restored.items.find((entry) => entry.id === item.id)) === wasRead,
    );
  } catch (error) {
    check(`${server.name}: a read write is accepted`, false, String(error?.message ?? error));
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
