/**
 * Revealing a hidden category draws its rows before anything is awaited.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/instant-reveal.mjs
 *
 * In Strict mode the extension hides a category by dropping every feed in it to
 * priority -10, and the GReader subscription list then omits those feeds
 * entirely: after a "Show" the app holds the flag and no rows, so the sidebar
 * used to stay empty for a 250 ms debounce plus a four-request reload. The fix
 * keeps the last list the server actually sent in memory and fills the hole from
 * it, synchronously, when a reveal asks for it.
 *
 * These checks pin the whole of that rule:
 *
 * - the rows are drawn in the same turn as the click, before any promise;
 * - the server's later answer replaces them wholesale — no duplicate ids, and a
 *   feed deleted elsewhere disappears;
 * - a remembered copy past the age cap, or a locked state, paints nothing;
 * - a second account never sees the first account's rows;
 * - hiding is untouched: same synchronous disappearance, same request, and no
 *   row is ever removed from the sidebar or from the remembered copy.
 *
 * `reader.svelte.ts` is a runes module, so it is compiled the way the app builds
 * it and imported from a throwaway directory inside the project. IndexedDB does
 * not exist in Node and `persist.ts` treats that as "no cache", so the suite
 * installs the same small in-memory stand-in `persist-scope.mjs` uses; the
 * network is a recorder, and the server URL points at a closed port it never
 * dials. No real feed, category or host appears here: the rows are
 * `feed/1`-style ids under "Category A" and "Category B".
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { GEN_DIR, buildReaderModule } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Two logins on one device, plus two more for the age checks. Synthetic hosts. */
const ONE = { serverUrl: "https://one.example", email: "one@one.example" };
const TWO = { serverUrl: "https://two.example", email: "two@two.example" };
const OLD = { serverUrl: "https://old.example", email: "old@old.example" };
const FRESH = { serverUrl: "https://fresh.example", email: "fresh@fresh.example" };

const sessionOf = (account) => ({
  serverUrl: account.serverUrl,
  apiPath: "/api/greader.php",
  email: account.email,
  token: "test-token",
});

// --- a stand-in for IndexedDB ------------------------------------------------
// Only the surface `src/state/persist.ts` uses: open with an upgrade hook, one
// store keyed by "key", and get/put/delete/getAll/getAllKeys delivered
// asynchronously the way the real store delivers them.
const store = new Map();
{
  const storeFor = () => store;
  const request = (work) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = work();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => ({}) }),
    transaction() {
      const map = storeFor();
      return {
        objectStore: () => ({
          get: (key) => request(() => map.get(key)),
          put: (entry) => {
            map.set(entry.key, entry);
            return request(() => entry.key);
          },
          delete: (key) => {
            map.delete(key);
            return request(() => undefined);
          },
          getAll: () => request(() => [...map.values()]),
          getAllKeys: () => request(() => [...map.keys()]),
        }),
      };
    },
  };
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = database;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** localStorage, for the launch snapshot the reader also keeps there. */
{
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

// --- the rows ----------------------------------------------------------------
const CATEGORY_A = "Category A";
const CATEGORY_B = "Category B";
const hiddenId = 12;
const shownId = 7;

const labelFor = (name) => `user/-/label/${name}`;

const feed = (id, title, category) => ({
  id,
  title,
  url: `https://example.invalid/${id}`,
  categories: [{ id: labelFor(category), label: category }],
});

/** Two categories; A is the one hidden in most of these blocks. */
function hiddenState(overrides = {}) {
  return {
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [hiddenId],
    locked: false,
    hasPasscode: false,
    categories: [
      { id: hiddenId, name: CATEGORY_A, hidden: true },
      { id: shownId, name: CATEGORY_B, hidden: false },
    ],
    ...overrides,
  };
}

/** What the server sent last time: both categories, with their counts. */
const REMEMBERED_ROWS = [feed("feed/1", "A one", CATEGORY_A), feed("feed/2", "A two", CATEGORY_A), feed("feed/3", "B one", CATEGORY_B)];
const REMEMBERED_COUNTS = [
  { id: "feed/1", count: 5 },
  { id: "feed/2", count: 4 },
  { id: "feed/3", count: 3 },
];

/** The live list while A is hidden: GReader omits everything in A. */
const HIDDEN_LIVE_ROWS = [feed("feed/3", "B one", CATEGORY_B)];

const labels = (reader) => reader.categories.map((group) => group.label).join(",");
const groupOf = (reader, name) => reader.categories.find((group) => group.label === name) ?? null;
const idsOf = (reader, name) => (groupOf(reader, name)?.feeds ?? []).map((entry) => entry.id).join(",");
const feedIds = (reader) => reader.subscriptions.map((entry) => entry.id);

/** Seeds the account's disk snapshot, the way a previous launch would have. */
function seedSidebar(reader, { rows, counts, at }) {
  const key = reader.diskKey("sidebar");
  store.set(key, {
    key,
    value: { subscriptions: rows, tags: [{ id: "user/-/label/tag", label: "tag" }], counts },
    at,
  });
  return key;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "instant-reveal-reader.mjs");
writeFileSync(generated, buildReaderModule());

try {
  const { ReaderState } = await import(pathToFileURL(generated).href);

  /* --------------------------------------------------------------------------- *
   * The network: a recorder. Every answer is chosen by the block that needs it.
   * --------------------------------------------------------------------------- */
  const SERVER = OLD.serverUrl;
  const STATE_URL = `${SERVER}/api/greader.php/Hardly%20Read/v1/state`;
  let calls = [];
  let reply = () => ({ status: 200, body: {} });

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body });
    const answer = await reply(String(input), init);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };

  /** A state reply body for the hidden-categories routes. */
  const stateReply = (state) => ({
    status: 200,
    body: { changed: true, hiddenCategories: state },
  });

  /** The four reads `loadSidebar` fires, answered with the rows given. */
  const sidebarReply = ({ rows, counts, state }) => (url) => {
    if (url.includes("/subscription/list")) return { status: 200, body: { subscriptions: rows } };
    if (url.includes("/tag/list")) return { status: 200, body: { tags: { tags: [] } } };
    if (url.includes("/unread-count")) return { status: 200, body: { unreadcounts: counts } };
    if (url.includes("/v1/state")) {
      return {
        status: 200,
        body: { apiVersion: 1, hiddenCategories: state, favorites: { available: false }, sidebarIndent: { available: false } },
      };
    }
    return { status: 200, body: {} };
  };

  /**
   * A reader whose live sidebar omits Category A's feeds, with a remembered
   * copy on disk holding them — the state a Strict-mode reveal starts from.
   */
  async function primed(account = ONE, { state = hiddenState(), at = Date.now() } = {}) {
    const reader = new ReaderState();
    reader.session = sessionOf(account);
    reader.hiddenCategories = state;
    reader.subscriptions = HIDDEN_LIVE_ROWS.map((entry) => ({ ...entry }));
    seedSidebar(reader, { rows: REMEMBERED_ROWS, counts: REMEMBERED_COUNTS, at });
    await reader.hydrateSidebar();
    calls = [];
    reply = () => stateReply(hiddenState({ hiddenIds: [] }));
    return reader;
  }

  /* --------------------------------------------------------------------------- *
   * (a) The reveal is drawn in the same turn
   * --------------------------------------------------------------------------- */
  {
    const reader = await primed();
    check("without a reveal, A has no rows to draw", groupOf(reader, CATEGORY_A) === null, labels(reader));

    const pending = reader.setCategoryHidden(CATEGORY_A, false);

    // Nothing has been awaited, and the request has not left yet: everything
    // below is the synchronous draw the click is supposed to produce.
    check("the reveal draws A's rows before any await", idsOf(reader, CATEGORY_A) === "feed/1,feed/2", idsOf(reader, CATEGORY_A));
    check("...and B's rows are still there", idsOf(reader, CATEGORY_B) === "feed/3", idsOf(reader, CATEGORY_B));
    check("...both categories are drawn", labels(reader) === "Category A,Category B", labels(reader));
    check("...the added row carries the remembered count", reader.countFor("feed/1") === 5, String(reader.countFor("feed/1")));
    check("...and no count is invented for a row the server sent", reader.countFor("feed/3") === 0, String(reader.countFor("feed/3")));
    check("...no request has gone out yet", calls.length === 0, `${calls.length} request(s)`);

    await pending;
    check("the write is still the same single request", calls.length === 1, `${calls.length} request(s)`);
    check("...a PUT of explicit state", calls[0]?.method === "PUT" && calls[0]?.body === '{"hidden":false}', String(calls[0]?.body));
    check("...to the category's own route", String(calls[0]?.url).endsWith(`/hidden-categories/${hiddenId}`), String(calls[0]?.url));
    check("the rows survive the reply", idsOf(reader, CATEGORY_A) === "feed/1,feed/2", idsOf(reader, CATEGORY_A));
  }

  /* --------------------------------------------------------------------------- *
   * (b) The server's answer replaces them wholesale
   * --------------------------------------------------------------------------- */
  {
    const reader = await primed();
    await reader.setCategoryHidden(CATEGORY_A, false);
    check("the reveal painted three feeds", feedIds(reader).join(",") === "feed/3,feed/1,feed/2", feedIds(reader).join(","));

    // The server now reports the real list: feed/2 was deleted elsewhere, and
    // feed/4 is new. The reload is what must settle the sidebar.
    reply = sidebarReply({
      rows: [feed("feed/1", "A one", CATEGORY_A), feed("feed/4", "A four", CATEGORY_A), feed("feed/3", "B one", CATEGORY_B)],
      counts: [
        { id: "feed/1", count: 1 },
        { id: "feed/4", count: 9 },
        { id: "feed/3", count: 3 },
      ],
      state: hiddenState({ hiddenIds: [] }),
    });
    const landed = await reader.loadSidebar();

    check("the reload lands", landed === true);
    check("the server's list replaces the merged one", feedIds(reader).join(",") === "feed/1,feed/4,feed/3", feedIds(reader).join(","));
    check("no feed id appears twice", new Set(feedIds(reader)).size === feedIds(reader).length, feedIds(reader).join(","));
    check("a feed the server no longer has is gone", !feedIds(reader).includes("feed/2"), feedIds(reader).join(","));
    check("the new feed is drawn", idsOf(reader, CATEGORY_A) === "feed/4,feed/1", idsOf(reader, CATEGORY_A));
    check("its count came with it", reader.countFor("feed/4") === 9, String(reader.countFor("feed/4")));
    check("the server's count replaced the remembered one", reader.countFor("feed/1") === 1, String(reader.countFor("feed/1")));

    // What the server just sent is what the next reveal may draw from: the
    // deleted feed must not come back from an older memory.
    reader.subscriptions = [feed("feed/3", "B one", CATEGORY_B)];
    reader.hiddenCategories = hiddenState();
    const pending = reader.setCategoryHidden(CATEGORY_A, false);
    check("a later reveal draws the fresh rows, not the deleted one", idsOf(reader, CATEGORY_A) === "feed/4,feed/1", idsOf(reader, CATEGORY_A));
    await pending;
  }

  /* --------------------------------------------------------------------------- *
   * (c) A copy past the age cap paints nothing
   * --------------------------------------------------------------------------- */
  {
    const DAY = 24 * 60 * 60 * 1000;
    const stale = await primed(OLD, { at: Date.now() - 8 * DAY });
    const pending = stale.setCategoryHidden(CATEGORY_A, false);
    check("eight days old: no rows are painted", groupOf(stale, CATEGORY_A) === null, labels(stale));
    check("...and the live list is untouched", feedIds(stale).join(",") === "feed/3", feedIds(stale).join(","));
    await pending;

    const usable = await primed(FRESH, { at: Date.now() - 6 * DAY });
    const pendingFresh = usable.setCategoryHidden(CATEGORY_A, false);
    check("six days old: the rows are still worth drawing", idsOf(usable, CATEGORY_A) === "feed/1,feed/2", idsOf(usable, CATEGORY_A));
    await pendingFresh;

    // A blob with no readable capture time is one nobody can vouch for.
    const untimed = await primed({ serverUrl: "https://untimed.example", email: "untimed@untimed.example" }, { at: Number.NaN });
    const pendingUntimed = untimed.setCategoryHidden(CATEGORY_A, false);
    check("a copy with no capture time paints nothing", groupOf(untimed, CATEGORY_A) === null, labels(untimed));
    await pendingUntimed;
  }

  /* --------------------------------------------------------------------------- *
   * (d) A lock paints nothing
   * --------------------------------------------------------------------------- */
  {
    const locked = await primed({ serverUrl: "https://locked.example", email: "locked@locked.example" }, {
      state: hiddenState({ locked: true }),
    });
    const pending = locked.setCategoryHidden(CATEGORY_A, false);
    check("a locked sidebar draws no remembered rows", groupOf(locked, CATEGORY_A) === null, labels(locked));
    check("...and its live rows are still what the server sent", feedIds(locked).join(",") === "feed/3", feedIds(locked).join(","));
    await pending;

    // The view path refuses outright while locked, and must still do so.
    const refused = await locked.setHiddenView("revealed");
    check("a view change while locked is refused", refused === null && groupOf(locked, CATEGORY_A) === null, labels(locked));
  }

  /* --------------------------------------------------------------------------- *
   * (e) A second account never sees the first account's rows
   * --------------------------------------------------------------------------- */
  {
    const reader = await primed(TWO);
    const pending = reader.setCategoryHidden(CATEGORY_A, false);
    check("the account that owns the rows draws them", idsOf(reader, CATEGORY_A) === "feed/1,feed/2", idsOf(reader, CATEGORY_A));
    await pending;

    // Stopping clears what was remembered, as does starting another account.
    reader.stop();
    reader.session = sessionOf(ONE);
    reader.hiddenCategories = hiddenState();
    reader.subscriptions = HIDDEN_LIVE_ROWS.map((entry) => ({ ...entry }));
    const afterStop = reader.setCategoryHidden(CATEGORY_A, false);
    check("after stop() no remembered rows are drawn", groupOf(reader, CATEGORY_A) === null, labels(reader));
    await afterStop;

    // Even without a stop: a session that changed under the memory is a
    // mismatch, and a mismatch is never drawn.
    const other = new ReaderState();
    other.session = sessionOf(TWO);
    other.hiddenCategories = hiddenState();
    other.subscriptions = HIDDEN_LIVE_ROWS.map((entry) => ({ ...entry }));
    seedSidebar(other, { rows: REMEMBERED_ROWS, counts: REMEMBERED_COUNTS, at: Date.now() });
    await other.hydrateSidebar();
    other.session = sessionOf(ONE);
    const swapped = other.setCategoryHidden(CATEGORY_A, false);
    check("a session swapped under the memory draws nothing", groupOf(other, CATEGORY_A) === null, labels(other));
    await swapped;

    // And the disk path stays scoped: an account that never wrote one finds
    // nothing, however much the others left behind.
    const third = new ReaderState();
    third.session = sessionOf({ serverUrl: "https://third.example", email: "third@third.example" });
    await third.hydrateSidebar();
    check("another account's disk snapshot is still a miss", third.subscriptions.length === 0, feedIds(third).join(","));
  }

  /* --------------------------------------------------------------------------- *
   * (f) Hiding is unchanged
   * --------------------------------------------------------------------------- */
  {
    const reader = await primed({ serverUrl: "https://hide.example", email: "hide@hide.example" });
    const before = reader.subscriptions;
    reply = () => stateReply(hiddenState({ hiddenIds: [hiddenId, shownId] }));

    const pending = reader.setCategoryHidden(CATEGORY_B, true);

    // Both categories are hidden now, so the sidebar is empty — but the hide
    // must do that by flipping the flag and filtering, never by editing rows.
    check("hiding drops the row at once", labels(reader) === "", labels(reader));
    check("...without touching the feed list", reader.subscriptions === before, String(reader.subscriptions === before));
    check("...and without adding anything from the memory", feedIds(reader).join(",") === "feed/3", feedIds(reader).join(","));
    check("...and without a request yet", calls.length === 0, `${calls.length} request(s)`);

    await pending;
    check("the hide is still one PUT", calls.length === 1 && calls[0]?.body === '{"hidden":true}', String(calls[0]?.body));
    check("the memory is not edited by a hide", feedIds(reader).join(",") === "feed/3", feedIds(reader).join(","));

    // Revealing after a hide is the case the fix exists for: the rows come back
    // from the memory, and revealing twice never duplicates them.
    reply = () => stateReply(hiddenState({ hiddenIds: [] }));
    const reveal = reader.setCategoryHidden(CATEGORY_A, false);
    const once = idsOf(reader, CATEGORY_A);
    await reveal;
    const again = reader.setCategoryHidden(CATEGORY_A, false);
    check("a reveal after a hide draws A's rows at once", once === "feed/1,feed/2", once);
    check("a second reveal adds no duplicate", idsOf(reader, CATEGORY_A) === "feed/1,feed/2", idsOf(reader, CATEGORY_A));
    check("...and no feed id repeats in the list", new Set(feedIds(reader)).size === feedIds(reader).length, feedIds(reader).join(","));
    await again;
  }

  /* --------------------------------------------------------------------------- *
   * The view controls: 'revealed' and 'only' fill the same hole
   * --------------------------------------------------------------------------- */
  {
    const reader = await primed({ serverUrl: "https://view.example", email: "view@view.example" });
    reply = () => stateReply(hiddenState({ view: "revealed", effectiveView: "revealed", hiddenIds: [hiddenId] }));

    const pending = reader.setHiddenView("revealed");
    check("'revealed' draws A's rows before any await", idsOf(reader, CATEGORY_A) === "feed/1,feed/2", idsOf(reader, CATEGORY_A));
    check("...with its counts", reader.countFor("feed/2") === 4, String(reader.countFor("feed/2")));
    await pending;
    check("'revealed' still writes the view", calls.length === 1 && calls[0]?.body === '{"view":"revealed"}', String(calls[0]?.body));

    // 'only' is the mirror: A's feeds are the ones on screen, and they are the
    // ones Strict omits, so they have to come from the memory too.
    reply = () => stateReply(hiddenState({ view: "only", effectiveView: "only", hiddenIds: [hiddenId] }));
    const onlyPending = reader.setHiddenView("only");
    check("'only' draws exactly the hidden category's rows", labels(reader) === "Category A" && idsOf(reader, CATEGORY_A) === "feed/1,feed/2", `${labels(reader)} / ${idsOf(reader, CATEGORY_A)}`);
    await onlyPending;

    // A fresh reader for the disk path: 'only' from a hidden launch still fills.
    const fromDisk = new ReaderState();
    fromDisk.session = sessionOf({ serverUrl: "https://only.example", email: "only@only.example" });
    fromDisk.hiddenCategories = hiddenState();
    fromDisk.subscriptions = HIDDEN_LIVE_ROWS.map((entry) => ({ ...entry }));
    seedSidebar(fromDisk, { rows: REMEMBERED_ROWS, counts: REMEMBERED_COUNTS, at: Date.now() });
    await fromDisk.hydrateSidebar();
    const freshOnly = fromDisk.setHiddenView("only");
    check("'only' straight after launch fills from the disk snapshot", idsOf(fromDisk, CATEGORY_A) === "feed/1,feed/2", idsOf(fromDisk, CATEGORY_A));
    await freshOnly;
  }

  await tick();
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
