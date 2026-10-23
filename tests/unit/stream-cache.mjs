/**
 * Unit checks for the stream cache: the part that makes switching categories and
 * feeds feel instant.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/stream-cache.mjs
 *
 * Pure logic only — no server, no browser, no Svelte. The clock is injected, so
 * expiry is tested by moving time rather than by waiting for it.
 */
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === "" ? "" : `  (${detail})`}`);
  }
}

const { StreamCache } = await import(new URL("../../src/state/stream-cache.ts", import.meta.url).href);

const item = (id) => ({ id, title: `Item ${id}`, published: 0, categories: [], origin: {} });

// A controllable clock: the cache must not depend on wall time to be testable.
let clock = 1_000;
const now = () => clock;

{
  const cache = new StreamCache(60_000, 20, now);
  cache.set("feed/a", [item("a1")], "cont-1");

  const fresh = cache.fresh("feed/a");
  check("a just-written stream is fresh", fresh !== undefined);
  check("its items are the ones stored", fresh?.items.length === 1 && fresh.items[0].id === "a1");
  check("its continuation survives", fresh?.continuation === "cont-1");
  check("an unknown stream is not fresh", cache.fresh("feed/unknown") === undefined);
  check("but peeking an unknown stream yields nothing either", cache.peek("feed/unknown") === undefined);
}

{
  const cache = new StreamCache(60_000, 20, now);
  cache.set("feed/b", [item("b1")]);
  clock += 59_999;
  check("still fresh one millisecond before the TTL", cache.fresh("feed/b") !== undefined);
  clock += 2;
  check("stale once the TTL has passed", cache.fresh("feed/b") === undefined);
  check("a stale entry can still be painted first", cache.peek("feed/b") !== undefined);
}

{
  const cache = new StreamCache(60_000, 3, now);
  cache.set("s/1", [item("1")]);
  cache.set("s/2", [item("2")]);
  cache.set("s/3", [item("3")]);
  check("fills up to its bound", cache.size === 3);
  cache.set("s/4", [item("4")]);
  check("never exceeds its bound", cache.size === 3);
  check("evicts the least recently written", cache.peek("s/1") === undefined);
  check("keeps the newest", cache.peek("s/4") !== undefined);
}

{
  const cache = new StreamCache(60_000, 3, now);
  cache.set("s/1", [item("1")]);
  cache.set("s/2", [item("2")]);
  cache.set("s/3", [item("3")]);
  // Rewriting an entry makes it the most recent, so s/2 should now go first.
  cache.set("s/1", [item("1b")]);
  cache.set("s/4", [item("4")]);
  check("rewriting an entry refreshes its recency", cache.peek("s/1") !== undefined);
  check("so the next-oldest is evicted instead", cache.peek("s/2") === undefined);
  check("a rewritten entry holds the new items", cache.peek("s/1")?.items[0].id === "1b");
}

{
  const cache = new StreamCache(60_000, 20, now);
  cache.set("s/x", [item("x")]);
  cache.delete("s/x");
  check("delete removes the entry", cache.peek("s/x") === undefined);
  check("delete of an absent stream is harmless", (() => {
    cache.delete("s/never-there");
    return cache.size === 0;
  })());
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
