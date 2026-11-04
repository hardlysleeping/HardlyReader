/**
 * Several accounts in one window: the reader's half.
 *
 * `account-registry.mjs` proves the set (slug identity, removal, `enabled`). This is
 * about the reader holding that set while still reading exactly one account — the
 * pointer and the set are different things, and the three ways they could drift are
 * the three things checked here:
 *
 *   1. turning an account off for merged views must not change who is being read;
 *   2. signing an account out must not be able to sign out the one on screen;
 *   3. `start()` must file the account before it hydrates, or a launch that fails
 *      halfway leaves Pane 1 with nothing to draw.
 *
 * The network paths are not exercised: `focus()` and `start()` hydrate streams, so
 * they are asserted against the source and left to the live pass.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/multi-account.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localProfile, syncProfile } from "../../src/api/profile.ts";
import { buildReaderModule, GEN_DIR } from "./build-reader.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const readerFile = readFileSync(new URL("../../src/state/reader.svelte.ts", import.meta.url), "utf8");

// A runes module cannot be imported by Node: it is compiled to plain ESM first,
// with every relative import rewritten (see `build-reader.mjs`).
mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(join(GEN_DIR, "reader-accounts.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader-accounts.mjs")).href);

/** A backend that answers nothing: the registry and the reader never read through it. */
function backend(kind = "greader") {
  return { kind };
}

/**
 * A backend that can actually be synced: one that answers empty lists and records
 * the crawls it was asked for. `refresh()` reaches `loadSidebar` and `reloadStream`,
 * so a bare `{ kind }` is not enough once a check drives it.
 */
function syncable(log, name) {
  return {
    kind: "greader",
    async profile() {
      return { userId: "0", userName: name };
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
    async stream(id) {
      return { id, items: [] };
    },
    async setRead() {},
    async setStarred() {},
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
    async fetchNew(options) {
      log.push(`${name}:${options?.wake}`);
    },
  };
}

function session(email) {
  return { serverUrl: "https://reader.example", apiPath: "/api/greader.php", email, token: `t-${email}` };
}

const a = syncProfile(session("a@example.com"), backend());
const b = syncProfile(session("b@example.com"), backend());
const local = localProfile(backend("local"), "On this device");

function readerWith(list) {
  const reader = new ReaderState();
  reader.adoptAccounts(list);
  return reader;
}

// ---------------------------------------------------------------------------
// The set, and the pointer.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([a, b]);
  equal("the reader knows both accounts", reader.accountList.map((p) => p.slug), [a.slug, b.slug]);
  equal("and both are part of a merged view by default", reader.mergedAccounts.length, 2);

  check("turning one off for merged views succeeds", reader.enableAccount(b.slug, false) === true);
  equal("it leaves the merged view", reader.mergedAccounts.map((p) => p.slug), [a.slug]);
  equal("but stays signed in, in the full list", reader.accountList.length, 2);
  check("and is still marked as such", reader.accountList.find((p) => p.slug === b.slug)?.enabled === false);
  check("turning it back on puts it back", reader.enableAccount(b.slug, true) === true && reader.mergedAccounts.length === 2);
  check("an account that is not there cannot be turned on", reader.enableAccount("nope", true) === false);
}

// ---------------------------------------------------------------------------
// Signing out, and the account that must not be signed out.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([a, b]);
  // What `start()` would have done, without the hydration.
  reader.profile = b;
  reader.backend = b.backend;
  check("the account being read refuses to be removed", reader.removeAccount(b.slug) === false);
  equal("so it is still there", reader.accountList.length, 2);
  check("another one goes", reader.removeAccount(a.slug) === true);
  equal("and only the account in use is left", reader.accountList.map((p) => p.slug), [b.slug]);
  check("removing it again says there was nothing to remove", reader.removeAccount(a.slug) === false);
}

// ---------------------------------------------------------------------------
// A local library is one of the accounts, not a mode.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([local, a, b]);
  equal("three accounts, one of them on this device", reader.accountList.length, 3);
  // A library with feeds in it is an account like any other; this one is empty, so it
  // is not part of a merged view — an account that holds nothing is not one of the
  // accounts a column is drawn from.
  equal("an empty library is not merged", reader.mergedAccounts.map((p) => p.slug), [a.slug, b.slug]);
  reader.accountSidebars = {
    [local.slug]: {
      slug: local.slug,
      label: local.label,
      kind: "local",
      categories: [
        {
          id: "c1",
          label: "Mine",
          feeds: [{ id: "feed/9", title: "Mine", url: "https://example.com/mine", categories: [] }],
        },
      ],
      counts: new Map(),
      error: null,
    },
  };
  check(
    "the local library merges alongside the servers once it holds a feed",
    reader.mergedAccounts.some((p) => p.kind === "local") && reader.mergedAccounts.length === 3,
  );
  reader.enableAccount(local.slug, false);
  equal("and can be left out of a merged view on its own", reader.mergedAccounts.length, 2);
}

// ---------------------------------------------------------------------------
// A pane opened from an account inherits the set.
// ---------------------------------------------------------------------------

{
  const parent = readerWith([a, b]);
  parent.profile = a;
  parent.backend = a.backend;
  const pane = new ReaderState({ pane: true });
  pane.seedFrom(parent);
  equal("a pane sees the same accounts", pane.accountList.map((p) => p.slug), [a.slug, b.slug]);
  // By slug, not identity: `profile` and `backend` are runes, so Svelte hands back a
  // proxy and `pane.profile === a` is false for the same account.
  check("...and reads the same account", pane.profile !== null && pane.profile.slug === a.slug);
}

// ---------------------------------------------------------------------------
// Syncing the set: the other accounts first, the focused one through refresh().
// ---------------------------------------------------------------------------

{
  const calls = [];
  const first = syncProfile(session("first@example.com"), syncable(calls, "first@example.com"));
  const second = syncProfile(session("second@example.com"), syncable(calls, "second@example.com"));
  const reader = new ReaderState();
  reader.adoptAccounts([first, second]);
  // The account being read, as `start()` would have left it.
  reader.profile = second;
  reader.backend = second.backend;

  let thrown = null;
  try {
    await reader.refreshAll("manual");
  } catch (error) {
    thrown = error;
  }
  check("a fan-out refresh finishes without throwing", thrown === null, String(thrown));
  equal(
    "the account that is not on screen is fetched by the fan-out",
    calls.filter((entry) => entry.startsWith("first@example.com")),
    ["first@example.com:manual"],
  );
  equal(
    "and the focused account is fetched exactly once, by its own path",
    calls.filter((entry) => entry.startsWith("second@example.com")).length,
    1,
  );
  check("no account is left in the error list", reader.accountErrors.length === 0, JSON.stringify(reader.accountErrors));
  check("the guard is released afterwards", reader.refreshingEveryAccount === false);
}

{
  const reader = new ReaderState();
  const failing = syncProfile(session("down@example.com"), {
    ...syncable([], "down"),
    fetchNew: async () => {
      throw new Error("503 from the server");
    },
  });
  reader.adoptAccounts([failing]);
  const focused = syncProfile(session("focused@example.com"), syncable([], "focused"));
  reader.profile = focused;
  reader.backend = focused.backend;
  await reader.refreshAll("background");
  equal("an account that could not be reached is reported by name", reader.accountErrors.map((e) => e.message), ["503 from the server"]);
  equal("and the account it belongs to", reader.accountErrors.map((e) => e.slug), [failing.slug]);
}

// ---------------------------------------------------------------------------
// The wiring that cannot be driven without a network.
// ---------------------------------------------------------------------------

check(
  "start() files the account before it hydrates anything",
  /this\.fileAccount\(profile\);\s*this\.resetForAccount\(\);/.test(readerFile),
);
check(
  "…and filing an account is what puts it in the list",
  /private fileAccount\(profile: ReaderProfile\): void \{[\s\S]{0,2000}?this\.accounts\.add\(settled\);\s*[\s\S]{0,900}?this\.publishAccounts\(\);/.test(readerFile),
);
check(
  "starting on an account already being read is not a second round trip",
  /if \(this\.profile !== null && profileSlug\(this\.profile\) === slug\) return true;/.test(readerFile),
);
check(
  "focus() reads an account from the set, never builds one",
  /async focus\(slug: string\): Promise<boolean> \{[\s\S]{0,400}?const profile = this\.accounts\.get\(slug\);/.test(readerFile) &&
    !/focus\([\s\S]{0,400}?syncProfile\(/.test(readerFile),
);
check(
  "only publishAccounts() writes the rune",
  (readerFile.match(/this\.accountList = /g) ?? []).length === 1,
);

// ---------------------------------------------------------------------------
// Paging a merged column: each account's cursor, its own rows, its own end.
// ---------------------------------------------------------------------------

{
  /** A backend that pages: `continuation` names the next page. */
  function paged(pages, asked) {
    return {
      kind: "greader",
      async profile() {
        return { userId: "0", userName: "someone" };
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
      async stream(id, opts) {
        const cursor = opts?.continuation ?? "first";
        asked.push(cursor);
        const page = pages[cursor] ?? { items: [] };
        return { id, items: page.items ?? [], continuation: page.next };
      },
      async setRead() {},
      async setStarred() {},
      async subscribe() {},
      async unsubscribe() {},
      async moveFeed() {},
    };
  }

  const post = (id, usec) => ({ id, timestampUsec: String(usec), published: Math.round(usec / 1_000_000), title: id });
  const askedFirst = [];
  const askedSecond = [];
  const first = syncProfile(
    session("first@example.com"),
    paged(
      { first: { items: [post("f1", 3_000_000)], next: "a2" }, a2: { items: [post("f2", 1_000_000)] } },
      askedFirst,
    ),
  );
  const second = syncProfile(
    session("second@example.com"),
    paged(
      { first: { items: [post("s1", 2_000_000)], next: "b2" }, b2: { items: [post("s2", 500_000)], next: "b3" } },
      askedSecond,
    ),
  );

  const reader = new ReaderState();
  reader.adoptAccounts([first, second]);
  await reader.start(first);
  equal("both accounts are in the merged view", reader.mergedAccounts.length, 2);
  check("so the stream is merged", reader.mergesStream(reader.activeStream) === true);
  equal("the first page asked each account once", [askedFirst.length, askedSecond.length], [1, 1]);
  equal("one section per account", reader.mergedSections.map((s) => s.key), [first.slug, second.slug]);
  equal("with a cursor for each", Object.keys(reader.mergedCursors).length, 2);

  await reader.loadMore();
  equal("more asks each account from its own cursor", [askedFirst.at(-1), askedSecond.at(-1)], ["a2", "b2"]);
  equal("and the new rows join their own account's section", reader.mergedSections.map((s) => s.items.length), [2, 2]);
  equal("the flat list has all four", reader.items.length, 4);
  equal("only the account that had more keeps a cursor", Object.keys(reader.mergedCursors), [second.slug]);
  check("and the column says there is more to fetch", reader.hasMore === true);

  await reader.loadMore();
  equal("the account that ran out is not asked again", askedFirst.length, 2);
  equal("the one that had more is", askedSecond.at(-1), "b3");
  equal("and the column ends when nobody has a cursor", Object.keys(reader.mergedCursors).length, 0);
  check("with nothing left, the column stops offering more", reader.hasMore === false);
  const before = reader.items.length;
  await reader.loadMore();
  equal("with nothing left, more does nothing", reader.items.length, before);

  // Switching to a single account's own view drops every trace of the merged page.
  const alone = new ReaderState();
  alone.adoptAccounts([first]);
  await alone.start(first);
  check("one account's column carries no sections", alone.mergedSections.length === 0);
  check("a single account's column pages off its own continuation", alone.hasMore === alone.continuation !== undefined);
  equal("and no cursors", alone.mergedCursors, {});
}

// Device display choice: exercise real reads and forbid every mutation.
{
  const reads = [];
  let writes = 0;
  let delayed = null;
  let slowCombined = null;
  const make = (name) => syncProfile(session(`${name}@example.com`), {
    ...syncable([], name),
    async stream(id, opts) {
      reads.push(`${name}:${id}:${opts?.continuation ?? "first"}`);
      if (slowCombined) await slowCombined;
      if (opts?.continuation && delayed) return delayed;
      return { id, items: [{ id: `${name}-post`, title: name, published: 1 }], continuation: "next" };
    },
    async setRead() { writes++; },
    async setStarred() { writes++; },
    async subscribe() { writes++; },
    async unsubscribe() { writes++; },
  });
  const first = make("toggle-first");
  const second = make("toggle-second");
  const reader = readerWith([first, second]);
  await reader.start(first);
  for (const stream of ["user/-/state/com.google/reading-list", "user/-/state/com.google/starred"]) {
    await reader.openStream(stream, "Test");
    equal("default keeps grouped combined posts", reader.mergedSections.length, 2);
    const before = reads.length;
    const off = reader.setMultiAccount(false);
    equal("off removes headings synchronously", reader.mergedSections, []);
    equal("off clears composite rows before reading", reader.items, []);
    await off;
    equal("off reads only focused backend", reads.slice(before), [`toggle-first:${stream}:first`]);
    equal("off draws provider ids, not composite ids", reader.items.map((i) => i.id), ["toggle-first-post"]);
    check("off preserves single-account paging", reader.hasMore && reader.continuation === "next");
    equal("off keeps all signed-in accounts", reader.accountList.length, 2);
    check("off keeps account navigation bands", reader.hasAccountGroups);
    check("off keeps account enablement", reader.mergedAccounts.length === 2);
    const pane = new ReaderState({ pane: true });
    pane.seedFrom(reader);
    check("split readers inherit off", !pane.multiAccount);
    await reader.setMultiAccount(true);
    equal("on reloads both account sections", reader.mergedSections.map((s) => s.key), [first.slug, second.slug]);
    check("on restores composite identity", reader.items.every((i) => i.id.startsWith("hr:")));
    const count = reads.length;
    await reader.setMultiAccount(true);
    equal("same choice does not reload", reads.length, count);
  }
  let release;
  delayed = new Promise((resolve) => { release = resolve; });
  const pending = reader.loadMore();
  await reader.setMultiAccount(false);
  release({ items: [{ id: "late", title: "late" }] });
  await pending;
  equal("late merged page cannot restore headings after off", reader.mergedSections, []);
  equal("late merged page cannot pollute focused rows", reader.items.map((i) => i.id), ["toggle-first-post"]);
  delayed = null;
  let rejectCombined;
  slowCombined = new Promise((_, reject) => { rejectCombined = reject; });
  const oldCombined = reader.setMultiAccount(true);
  slowCombined = null;
  await reader.setMultiAccount(false);
  rejectCombined(new Error("old combined request failed"));
  await oldCombined;
  equal("a stale failed combined request cannot blank focused posts", reader.items.map((i) => i.id), ["toggle-first-post"]);
  check("a stale failed combined request cannot show a banner", reader.error === null);
  let releaseSingle;
  delayed = new Promise((resolve) => { releaseSingle = resolve; });
  const oldSinglePage = reader.loadMore();
  await reader.setMultiAccount(true);
  releaseSingle({ items: [{ id: "single-late", title: "late" }] });
  await oldSinglePage;
  check("a stale single-account page cannot pollute combined rows", reader.items.every((i) => i.id.startsWith("hr:")));
  delayed = null;
  await reader.setMultiAccount(false);
  const before = reads.length;
  await reader.openStream("feed/one", "One feed");
  const afterFeed = reads.length;
  await reader.setMultiAccount(true);
  equal("toggle leaves a feed's stream alone", reads.length, afterFeed);
  check("feed was read exactly once", afterFeed === before + 1);
  equal("no data mutations from the switch", writes, 0);
  const single = readerWith([first, local]);
  check("one server and empty local library has no control", !single.hasAccountGroups);
  check("one server and empty local library never merges", !single.mergesStream("user/-/state/com.google/reading-list"));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
