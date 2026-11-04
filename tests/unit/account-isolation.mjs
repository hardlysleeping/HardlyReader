/**
 * The account stays attached to the row.
 *
 * This is the suite the plan called `account-isolation.mjs`, and it is the gate for
 * HR-103/HR-803: a merged column may draw rows from several accounts, but a mark
 * made on one of them can only travel to the account that row came from — never to
 * the account that happens to be focused, and never to both.
 *
 * The failure this prevents is not hypothetical: two accounts subscribed to the same
 * feed receive the *same* GReader item id, because the id is derived from the feed
 * entry and not from the account. Anything that resolved an id to an account with a
 * lookup table filled while drawing would hand a mark to whichever account was drawn
 * last.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-isolation.mjs
 */
import { AccountAggregate, UnknownAccountError, composeId, mergePages, splitId } from "../../src/api/aggregate.ts";
import { AccountRegistry } from "../../src/api/registry.ts";
import { syncProfile } from "../../src/api/profile.ts";

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

/** A backend that records what it was asked and answers the items it was given. */
function backend(items = [], options = {}) {
  const calls = { stream: [], setRead: [], setStarred: [] };
  return {
    kind: "greader",
    calls,
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
      calls.stream.push({ id, opts });
      if (options.streamFails) throw new Error(options.streamFails);
      return { id, items, updated: options.updated };
    },
    async setRead(ids, read) {
      calls.setRead.push({ ids, read });
      if (options.writeFails) throw new Error(options.writeFails);
    },
    async setStarred(ids, starred) {
      calls.setStarred.push({ ids, starred });
      if (options.writeFails) throw new Error(options.writeFails);
    },
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
  };
}

function session(email) {
  return { serverUrl: "https://reader.example", apiPath: "/api/greader.php", email, token: `t-${email}` };
}

function item(id, usec) {
  return { id, published: Math.round(usec / 1_000_000), timestampUsec: String(usec), title: id };
}

/** The same item id in both accounts — the collision the whole design exists for. */
const SHARED = "tag:google.com,2005:reader/item/0000000000000001";

function twoAccounts(backendA = backend(), backendB = backend()) {
  const registry = new AccountRegistry();
  const a = syncProfile(session("a@example.com"), backendA);
  const b = syncProfile(session("b@example.com"), backendB);
  registry.add(a);
  registry.add(b);
  return { registry, a, b, backendA, backendB };
}

// ——— the identity carries the account ———

equal("a composed id is the slug, a slash, and the provider's own id", composeId("a1b2c3d4", SHARED), `hr:a1b2c3d4/${SHARED}`);
equal("it splits back into exactly what it was made from", splitId(`hr:a1b2c3d4/${SHARED}`), { slug: "a1b2c3d4", itemId: SHARED });
check("a bare provider id does not name an account", splitId(SHARED) === null, String(splitId(SHARED)));
// The case that made this prefix necessary: a library on this device spells its own
// ids `local/<feed>/<guid>`, whose first segment is a perfectly good slug.
check("a local library's own id is not mistaken for an account", splitId("local/ZmVlZA/guid-1") === null, String(splitId("local/ZmVlZA/guid-1")));
check("nor is a feed id", splitId("feed/12") === null);
check("an empty id names nothing", splitId("") === null);
check("a slug with nothing after it names nothing", splitId("a1b2c3d4/") === null);
check("a path with no slug in front of it is not addressable", splitId("/tag:google.com,2005:reader/item/1") === null);

// ——— merging ———

{
  const merged = mergePages("user/-/state/com.google/reading-list", [
    {
      slug: "a1b2c3d4",
      label: "work@example.com",
      contents: { id: "x", updated: 100, items: [item("a-old", 1_000_000), item("a-new", 3_000_000)] },
    },
    {
      slug: "ffffffff",
      label: "home@example.com",
      contents: { id: "x", updated: 200, items: [item("b-mid", 2_000_000)] },
    },
  ]);
  equal("three rows from two accounts", merged.items.length, 3);
  equal(
    "grouped by account, so a row's owner is the section it is under",
    merged.items.map((row) => row.id),
    [`hr:a1b2c3d4/a-new`, `hr:a1b2c3d4/a-old`, `hr:ffffffff/b-mid`],
  );
  equal(
    "newest first inside each account",
    merged.sections.map((section) => section.items.map((row) => splitId(row.id)?.itemId)),
    [["a-new", "a-old"], ["b-mid"]],
  );
  equal("one section per account, named", merged.sections.map((section) => section.label), [
    "work@example.com",
    "home@example.com",
  ]);
  equal("sections keep Pane 1's order", merged.sections.map((section) => section.slug), ["a1b2c3d4", "ffffffff"]);
  equal("and the flat list is the sections in order", merged.items.length, 3);
  equal("every row says whose it is", merged.items.map((row) => splitId(row.id)?.slug), ["a1b2c3d4", "a1b2c3d4", "ffffffff"]);
  equal("the merged page is as fresh as the freshest account", merged.updated, 200);
  check("a merged page claims no continuation", merged.continuation === undefined, String(merged.continuation));
  equal("the merged page keeps the stream it was asked for", merged.id, "user/-/state/com.google/reading-list");
}

{
  const merged = mergePages("stream", [
    { slug: "a1b2c3d4", label: "one", contents: { id: "s", items: [item(SHARED, 5)] } },
    { slug: "ffffffff", label: "two", contents: { id: "s", items: [item(SHARED, 5)] } },
  ]);
  equal("the same provider id in two accounts stays two rows", merged.items.length, 2);
  equal(
    "and neither row can be mistaken for the other",
    merged.items.map((row) => row.id),
    [`hr:a1b2c3d4/${SHARED}`, `hr:ffffffff/${SHARED}`],
  );
  check("each lives in its own account's section", merged.sections.map((s) => s.items.length).join(",") === "1,1");
}

{
  const merged = mergePages("stream", [
    { slug: "a1b2c3d4", label: "one", contents: { id: "s", items: [item("one", 2_000_000), item("one", 2_000_000)] } },
  ]);
  equal("the same row twice from one account is drawn once", merged.items.length, 1);
}

// ——— reading ———

{
  const backendA = backend([item("a-row", 2_000_000)]);
  const backendB = backend([item("b-row", 1_000_000)]);
  const { registry, a, b } = twoAccounts(backendA, backendB);
  const aggregate = new AccountAggregate(registry);

  const page = await aggregate.stream("user/-/state/com.google/reading-list", { n: 20 });
  equal("both accounts were asked", [backendA.calls.stream.length, backendB.calls.stream.length], [1, 1]);
  equal("with the same stream and options", [backendA.calls.stream[0].id, backendA.calls.stream[0].opts.n], ["user/-/state/com.google/reading-list", 20]);
  equal("and both rows are drawn", page.items.map((row) => row.id), [`hr:${a.slug}/a-row`, `hr:${b.slug}/b-row`]);
  equal("nothing failed", page.failures, []);
}

{
  const backendA = backend();
  const backendB = backend([], { streamFails: "502 from the server" });
  const { registry, a, b } = twoAccounts(backendA, backendB);
  const aggregate = new AccountAggregate(registry);
  backendA.stream = async () => ({ id: "s", items: [item("a-row", 1_000_000)] });

  const page = await aggregate.stream("s");
  equal("the account that answered is still drawn", page.items.map((row) => row.id), [`hr:${a.slug}/a-row`]);
  equal("and the one that did not is named, by its own slug", page.failures.map((f) => [f.slug, f.message]), [[b.slug, "502 from the server"]]);

  const deadA = backend([], { streamFails: "offline" });
  const deadB = backend([], { streamFails: "offline" });
  const dead = new AccountAggregate(twoAccounts(deadA, deadB).registry);
  let thrown = null;
  try {
    await dead.stream("s");
  } catch (error) {
    thrown = error;
  }
  check("a page where every account failed is an error, not an empty page", thrown instanceof Error, String(thrown));
}

{
  const disabled = twoAccounts(backend([item("a-row", 1)]), backend([item("b-row", 2)]));
  disabled.registry.add({ ...disabled.b, enabled: false });
  const page = await new AccountAggregate(disabled.registry).stream("s");
  equal("an account turned off for the merged view is not read", page.items.map((row) => splitId(row.id).slug), [disabled.a.slug]);
  equal("and its backend was not called", disabled.backendB.calls.stream.length, 0);
}

// ——— writing ———

{
  const backendA = backend();
  const backendB = backend();
  const { registry, a, b } = twoAccounts(backendA, backendB);
  const aggregate = new AccountAggregate(registry);

  const outcome = await aggregate.markRead([`hr:${b.slug}/${SHARED}`], true);
  equal("the mark reached the account the row came from", backendB.calls.setRead, [{ ids: [SHARED], read: true }]);
  equal("and not the other one", backendA.calls.setRead, []);
  equal("the backend never sees the slug prefix", backendB.calls.setRead[0].ids[0], SHARED);
  equal("the outcome names the account it landed on", outcome.sent, [b.slug]);
  equal("with nothing failed", outcome.failed, []);
  check("neither account was touched by broadcast", backendA.calls.setStarred.length === 0);
  check("a row from A is still addressable", (await aggregate.markStarred([`hr:${a.slug}/other`], true)).sent.includes(a.slug));
}

{
  const backendA = backend();
  const backendB = backend();
  const { registry, a, b } = twoAccounts(backendA, backendB);
  const aggregate = new AccountAggregate(registry);

  await aggregate.markRead([`hr:${a.slug}/one`, `hr:${b.slug}/two`, `hr:${a.slug}/three`], false);
  equal("one account receives one call with its own rows", backendA.calls.setRead, [{ ids: ["one", "three"], read: false }]);
  equal("and the other receives its own", backendB.calls.setRead, [{ ids: ["two"], read: false }]);
}

{
  const backendA = backend();
  const backendB = backend();
  const { registry, a } = twoAccounts(backendA, backendB);
  const aggregate = new AccountAggregate(registry);

  let thrown = null;
  try {
    await aggregate.markRead([`hr:${a.slug}/one`, `hr:99999999/two`], true);
  } catch (error) {
    thrown = error;
  }
  check("an id naming an account this window does not have is refused", thrown instanceof UnknownAccountError, String(thrown));
  equal("the refusal names the missing account", thrown?.slug ?? null, "99999999");
  equal("and nothing was sent, not even the id that resolved", backendA.calls.setRead, []);
}

{
  const { registry, a } = twoAccounts(backend(), backend());
  const aggregate = new AccountAggregate(registry);
  let thrown = null;
  try {
    await aggregate.markRead([SHARED], true);
  } catch (error) {
    thrown = error;
  }
  check("a bare provider id cannot be marked, because no account is named", thrown instanceof UnknownAccountError, String(thrown));
  check("and it is not guessed at from whoever is focused", thrown?.itemId === null, String(thrown?.itemId));
}

{
  const backendA = backend();
  const backendB = backend([], { writeFails: "401 from the server" });
  const { registry, a, b } = twoAccounts(backendA, backendB);
  const outcome = await new AccountAggregate(registry).markRead([`hr:${a.slug}/one`, `hr:${b.slug}/two`], true);
  equal("a write that landed on one account is reported as landed", outcome.sent, [a.slug]);
  equal("and the one that did not is named with its reason", outcome.failed.map((f) => [f.slug, f.message]), [[b.slug, "401 from the server"]]);
}

/* ---- paging a merged column, one cursor per account ---------------------- */

{
  // A page that answers with a continuation, and remembers what it was asked.
  function paged(slugItems, cursors) {
    const asked = [];
    return {
      kind: "greader",
      asked,
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
        asked.push(opts?.continuation ?? null);
        const cursor = opts?.continuation;
        const page = slugItems[cursor ?? "first"] ?? { items: [] };
        return { id, items: page.items ?? [], continuation: page.next };
      },
      async setRead() {},
      async setStarred() {},
      async subscribe() {},
      async unsubscribe() {},
      async moveFeed() {},
    };
  }

  const first = syncProfile(
    session("first@example.com"),
    paged({
      first: { items: [item("f1", 3_000_000)], next: "a2" },
      a2: { items: [item("f2", 1_000_000)], next: "a3" },
    }),
  );
  const second = syncProfile(
    session("second@example.com"),
    paged({
      first: { items: [item("s1", 2_000_000)], next: "b2" },
      b2: { items: [item("s2", 500_000)] },
    }),
  );
  const registry = new AccountRegistry();
  registry.add(first);
  registry.add(second);
  const aggregate = new AccountAggregate(registry);

  const page1 = await aggregate.stream("user/-/state/com.google/reading-list");
  equal("each account's own continuation comes back", Object.keys(page1.cursors).length, 2);
  equal("keyed by slug", page1.cursors[first.slug], "a2");
  check("not folded into one stream continuation", page1.continuation === undefined);

  const page2 = await aggregate.stream("user/-/state/com.google/reading-list", { cursors: page1.cursors });
  equal(
    "the next page asks each account from its own cursor",
    [first.backend.asked.at(-1), second.backend.asked.at(-1)],
    ["a2", "b2"],
  );
  equal(
    "and files the rows under their own account",
    page2.sections.map((s) => s.items.map((row) => splitId(row.id).itemId.replace("tag:google.com,2005:reader/item/", ""))),
    [["f2"], ["s2"]],
  );
  equal("one account finishing does not stop the other", Object.keys(page2.cursors), [first.slug]);

  // An account that has run out is not asked again.
  const exhausted = await aggregate.stream("user/-/state/com.google/reading-list", { cursors: { [first.slug]: "a3" } });
  equal("an account with no cursor is not asked", second.backend.asked.at(-1), "b2");
  equal("and the one that is asked is", first.backend.asked.at(-1), "a3");
  check("a page nobody had a cursor for is empty, not an error", exhausted.items.length === 0 && exhausted.failures.length === 0);
  equal("with no cursors left", exhausted.cursors, {});
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
