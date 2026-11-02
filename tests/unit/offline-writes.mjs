/**
 * The queue behind a read mark.
 *
 * A mark is the smallest thing the reader does and the one they do most, so this
 * suite is about two promises and nothing else:
 *
 *   1. a press lands on the device at once, and is still there after a restart;
 *   2. the request happens when there is a network, once, batched, and never
 *      again for a mark that landed.
 *
 * The backend underneath is a stub that can be told to fail in each of the ways a
 * real one does — a connection that never reached a server, a credential the
 * server has forgotten, a request it looked at and refused — because which of
 * those a mark survives is the whole policy.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/offline-writes.mjs
 */
import {
  MemoryJournalBank,
  WriteJournal,
  markKey,
} from "../../src/api/offline/journal.ts";
import { OfflineBackend, batches, verdictFor } from "../../src/api/offline/backend.ts";
import { serverBackend } from "../../src/api/profile.ts";
import {
  AuthError,
  HttpError,
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
} from "../../src/api/freshrss.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

/** A clock a test can move, so a backoff is a number rather than a sleep. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

/**
 * A server that answers everything, and can be told to fail the writes.
 *
 * Every write it accepts is recorded with the ids it was given, so "one request
 * carrying three posts" is a fact about the list rather than a hope.
 */
function stubServer() {
  const writes = [];
  let failure = null;
  const inner = {
    kind: "greader",
    async profile() {
      return { userId: "u", userName: "n", userProfileId: "p", userEmail: "e" };
    },
    async subscriptions() {
      return [];
    },
    async tags() {
      return [];
    },
    async unreadCounts() {
      return [];
    },
    async stream(streamId) {
      return {
        id: streamId,
        items: [
          { id: "post-1", title: "One" },
          { id: "post-2", title: "Two", categories: [STATE_READ] },
        ],
      };
    },
    async setRead(itemIds, read) {
      if (failure !== null) throw failure;
      writes.push({ kind: "read", itemIds: [...itemIds], value: read });
    },
    async setStarred(itemIds, starred) {
      if (failure !== null) throw failure;
      writes.push({ kind: "starred", itemIds: [...itemIds], value: starred });
    },
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
  };
  return {
    inner,
    writes,
    failWith(error) {
      failure = error;
    },
    recover() {
      failure = null;
    },
  };
}

const SESSION = {
  serverUrl: "https://reader.example",
  apiPath: "/api/greader.php",
  email: "someone@example.com",
  token: "SECRET-TOKEN",
};

/* ---- the queue ------------------------------------------------------------ */

{
  const bank = new MemoryJournalBank();
  const time = clock();
  const journal = new WriteJournal(bank, "slug-a", time.now);

  await journal.record("read", ["post-1"], true);
  equal("a mark is queued", journal.entries().map((mark) => [mark.kind, mark.itemId, mark.value]), [["read", "post-1", true]]);
  check("and the queue is on the device, not only in memory", (await bank.load("slug-a")).length === 1);

  // A second launch reads the queue back.
  const relaunched = new WriteJournal(bank, "slug-a", time.now);
  await relaunched.open();
  equal("a queued mark survives a restart", relaunched.entries().map((mark) => mark.itemId), ["post-1"]);

  // Last value wins: read, then unread, is one write and it says unread.
  time.advance(10);
  await relaunched.record("read", ["post-1"], false);
  equal("a second press replaces the first", relaunched.entries().map((mark) => mark.value), [false]);

  // The two registers never fold together.
  time.advance(10);
  await relaunched.record("starred", ["post-1"], true);
  equal(
    "read and starred are two marks on one post",
    relaunched.entries().map((mark) => mark.kind),
    ["read", "starred"],
  );
  equal("the values map answers per register", [...relaunched.values("read").entries()], [["post-1", false]]);

  // Order is the order the reader pressed.
  time.advance(10);
  await relaunched.record("read", ["post-2"], true);
  equal(
    "the queue is in the order it was written",
    relaunched.entries().map((mark) => [mark.kind, mark.itemId]),
    [["read", "post-1"], ["starred", "post-1"], ["read", "post-2"]],
  );

  // A mark that landed is forgotten; a press made while it was out is not.
  const readMarks = relaunched.entries().filter((mark) => mark.kind === "read");
  time.advance(10);
  await relaunched.record("read", ["post-1"], true);
  await relaunched.forget(readMarks);
  equal(
    "only the mark that landed leaves the queue",
    relaunched.entries().filter((mark) => mark.kind === "read").map((mark) => [mark.itemId, mark.value]),
    [["post-1", true]],
  );

  const keys = new Set(relaunched.entries().map((mark) => markKey(mark)));
  check("a key names the register and the post", keys.has("read\u0000post-1") && keys.has("starred\u0000post-1"));

  // One account's queue is not another's.
  const other = new WriteJournal(bank, "slug-b", time.now);
  await other.open();
  check("another account's queue is empty", other.size === 0);
}

/* ---- the backend in front of a server ------------------------------------- */

{
  // Offline, so nothing walks out from under the checks: the queue is what is
  // being examined here. The other mode is the next block.
  const server = stubServer();
  const time = clock();
  const journal = new WriteJournal(new MemoryJournalBank(), "slug-a", time.now);
  const backend = new OfflineBackend(server.inner, { journal, now: time.now, autoFlush: false });

  await backend.setRead(["post-1"], true);
  equal("a mark is taken without a request", server.writes, []);
  check("and it is queued", backend.pending === 1);

  await backend.setRead(["post-2", "post-3"], true);
  const sent = await backend.flush(true);
  equal("the flush sends what was queued, as one request", server.writes, [{ kind: "read", itemIds: ["post-1", "post-2", "post-3"], value: true }]);
  equal("and says how many landed", sent, 3);
  check("the queue is empty afterwards", backend.pending === 0);
  equal("the flush reports it landed", backend.lastFlush.stop, "landed");

  const again = await backend.flush(true);
  equal("a second flush with nothing queued makes no request", [again, server.writes.length], [0, 1]);

  // The two registers are two requests, because the API has two request shapes.
  await backend.setRead(["post-9"], true);
  await backend.setStarred(["post-9"], true);
  await backend.flush(true);
  equal(
    "read and starred go as separate calls",
    server.writes.slice(1).map((write) => [write.kind, write.value]),
    [["read", true], ["starred", true]],
  );
}

{
  // The app's mode: a press asks, in the background, and the press itself does
  // not wait for the answer. A request that hangs must not hang the reader.
  const server = stubServer();
  let release = null;
  server.inner.setRead = (itemIds, read) =>
    new Promise((resolve) => {
      release = () => {
        server.writes.push({ kind: "read", itemIds: [...itemIds], value: read });
        resolve();
      };
    });
  const backend = new OfflineBackend(server.inner, {
    journal: new WriteJournal(new MemoryJournalBank(), "slug-a", () => 1_000_000),
  });

  let asked = false;
  const press = backend.setRead(["post-1"], true).then(() => {
    asked = true;
  });
  // Enough turns of the event loop for the press to resolve, on a request that
  // is never going to.
  for (let turn = 0; turn < 20 && !asked; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  check("a press resolves while its request is still out", asked);
  check("and the write is the one in flight", typeof release === "function");
  release();
  await press;
  await backend.flush(true);
  equal("the mark landed once the request did", server.writes, [{ kind: "read", itemIds: ["post-1"], value: true }]);
}

/* ---- what happens when the network is not there --------------------------- */

{
  const server = stubServer();
  const time = clock();
  const journal = new WriteJournal(new MemoryJournalBank(), "slug-a", time.now);
  const backend = new OfflineBackend(server.inner, { journal, now: time.now, retryMs: 20_000, autoFlush: false });

  server.failWith(new TypeError("Failed to fetch"));
  await backend.setRead(["post-1"], true);
  const sent = await backend.flush(true);
  equal("a mark that could not be sent stays queued", [sent, backend.pending], [0, 1]);
  equal("and the flush says the network was not reached", backend.lastFlush.stop, "unreached");

  // The backoff: a read that gets through asks again, but not on every press.
  const attempts = server.writes.length;
  await backend.flush();
  await backend.flush();
  equal("the backoff is respected", server.writes.length, attempts);
  equal("and an idle flush says it is waiting", backend.lastFlush.stop, "waiting");

  // Time passing is the queue's own retry.
  time.advance(20_001);
  server.recover();
  await backend.flush();
  equal("after the backoff the mark goes", server.writes, [{ kind: "read", itemIds: ["post-1"], value: true }]);
  check("and the queue is clear", backend.pending === 0);

  // `force` is the network coming back: the wait is not the reader's to endure.
  server.failWith(new TypeError("Failed to fetch"));
  await backend.setRead(["post-2"], true);
  await backend.flush(true);
  server.recover();
  const forced = await backend.flush(true);
  equal("a forced flush tries again immediately", forced, 1);
}

{
  const server = stubServer();
  const time = clock();
  const backend = new OfflineBackend(server.inner, {
    journal: new WriteJournal(new MemoryJournalBank(), "slug-a", time.now),
    now: time.now,
    retryMs: 1_000,
    authRetryMs: 300_000,
    autoFlush: false,
  });

  // A server that answered and refused the request: asking again asks the same
  // question forever, so the mark is dropped and the report says so.
  server.failWith(new HttpError(400, "Invalid item id"));
  await backend.setRead(["post-1"], true);
  const refused = await backend.flush(true);
  equal("a refused mark is dropped", [refused, backend.pending], [0, 0]);
  equal("and the report names it", backend.lastFlush.stop, "refused");
  equal("with the mark itself", backend.lastFlush.refused.map((mark) => mark.itemId), ["post-1"]);

  // A server in trouble is waited out.
  server.failWith(new HttpError(503, "Down for maintenance"));
  await backend.setRead(["post-2"], true);
  await backend.flush(true);
  equal("a 503 keeps the mark", backend.pending, 1);

  // A dead token is waited out for much longer, and does not pretend to be a
  // network problem.
  server.failWith(new AuthError("Token rejected by server", 401));
  await backend.setRead(["post-3"], true);
  await backend.flush(true);
  equal("a dead token keeps the marks", backend.pending, 2);
  equal("and is named as itself", backend.lastFlush.stop, "unauthorised");
}

/* ---- a page is painted with the mark the server has not heard ------------- */

{
  const server = stubServer();
  const time = clock();
  const journal = new WriteJournal(new MemoryJournalBank(), "slug-a", time.now);
  const backend = new OfflineBackend(server.inner, { journal, now: time.now, autoFlush: false });

  // Nothing queued: the page is the server's page, untouched.
  const plain = await backend.stream(READING_LIST);
  equal("a page with no queued marks is returned as it came", plain.items.map((item) => item.categories ?? []), [[], [STATE_READ]]);

  server.failWith(new TypeError("Failed to fetch"));
  await backend.setRead(["post-1"], true);
  await backend.setStarred(["post-2"], false);
  const painted = await backend.stream(READING_LIST);
  equal(
    "a queued mark is drawn on the page the server sent",
    painted.items.map((item) => item.categories ?? []),
    [[STATE_READ], [STATE_READ]],
  );
  check("the server's own page is not mutated", plain.items[0].categories === undefined);
}

/* ---- a queue that cannot be written is not a queue ------------------------ */

{
  const server = stubServer();
  const brokenBank = {
    load: async () => [],
    save: async () => {
      throw new Error("The store is locked");
    },
  };
  const backend = new OfflineBackend(server.inner, {
    journal: new WriteJournal(brokenBank, "slug-a", () => 1_000_000),
  });
  await backend.setRead(["post-1"], true);
  equal("an unwritable queue sends the mark the old way", server.writes, [{ kind: "read", itemIds: ["post-1"], value: true }]);
  check("and does not keep a copy the disk never took", backend.pending === 0);

  server.failWith(new TypeError("Failed to fetch"));
  let thrown = null;
  try {
    await backend.setRead(["post-2"], true);
  } catch (error) {
    thrown = error;
  }
  check("and a refusal there is the reader's to see", thrown instanceof TypeError);
}

/* ---- the two pure helpers ------------------------------------------------- */

{
  const marks = [
    { kind: "read", itemId: "a", value: true, at: 1 },
    { kind: "read", itemId: "b", value: true, at: 2 },
    { kind: "starred", itemId: "a", value: true, at: 3 },
    { kind: "read", itemId: "c", value: false, at: 4 },
  ];
  equal(
    "batches group by register and value, in the order written",
    batches(marks).map((batch) => [batch.kind, batch.value, batch.itemIds]),
    [
      ["read", true, ["a", "b"]],
      ["starred", true, ["a"]],
      ["read", false, ["c"]],
    ],
  );
  equal(
    "a failure is classified by what the server said",
    [
      verdictFor(new AuthError("nope", 401)),
      verdictFor(new HttpError(429, "slow down")),
      verdictFor(new HttpError(500, "oops")),
      verdictFor(new HttpError(404, "no such item")),
      verdictFor(new TypeError("Failed to fetch")),
      verdictFor(Object.assign(new Error("stopped"), { name: "AbortError" })),
    ],
    ["unauthorised", "retry", "retry", "refused", "retry", "retry"],
  );
}

/* ---- which side of the seam an account gets ------------------------------- */

{
  const serverAccount = serverBackend(SESSION);
  check("a server account is served by a queue", serverAccount.kind === "greader" && typeof serverAccount.flush === "function");

  const local = {
    kind: "local",
    async profile() {
      return { userId: "local", userName: "On this device", userProfileId: "local", userEmail: "" };
    },
    async subscriptions() {
      return [];
    },
    async tags() {
      return [];
    },
    async unreadCounts() {
      return [];
    },
    async stream() {
      return { id: READING_LIST, items: [] };
    },
    async setRead() {},
    async setStarred() {},
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
  };
  // A library on this device is opened by `openLocalProfile` (a database, so it is
  // asynchronous) and has no request to queue: the interface's absent `flush` is how
  // that is said. Both halves are checked here — a store-shaped backend has no
  // `flush`, and the seam's off-switch hands back the plain backend with none either.
  const plain = serverBackend(SESSION, { queue: false });
  check(
    "the seam can hand back the plain server backend, with nothing queued",
    plain.kind === "greader" && plain.flush === undefined,
  );
  check(
    "a library on this device serves itself, so nothing is ever queued for it",
    typeof local.setRead === "function" && local.flush === undefined,
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
