/**
 * Unit checks for the parts of stream switching that make it feel immediate:
 * the cache, the generation guard, the prefetch gate, the scroll memory and the
 * switch timings.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/stream-cache.mjs
 *
 * Pure logic only — no server, no browser, no Svelte. The clock is injected, so
 * expiry is tested by moving time rather than by waiting for it, and the
 * generation cases are tested by starting loads in a deliberate order rather
 * than by racing real requests.
 */
import { StreamCache, sameStreamPage } from "../../src/state/stream-cache.ts";
import { StreamLoads } from "../../src/lib/stream-loads.ts";
import { StreamScroll } from "../../src/lib/stream-scroll.ts";
import { StreamPerf, percentile, summarize } from "../../src/lib/stream-perf.ts";

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

const item = (id) => ({ id, title: `Item ${id}`, published: 0, categories: [], origin: {} });

// A controllable clock: the cache must not depend on wall time to be testable.
let clock = 1_000;
const now = () => clock;

/* -------------------------------------------------------------------------
 * The cache: freshness and eviction.
 * ---------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------
 * Revalidation: only a payload that changed is worth a repaint.
 * ---------------------------------------------------------------------- */

{
  const page = (items, continuation) => ({ items, continuation });
  const plain = [item("a"), item("b")];

  check(
    "a page fetched again compares equal to the one drawn",
    sameStreamPage(page(plain, "c1"), page([item("a"), item("b")], "c1")),
  );
  check("the same array compares equal to itself", sameStreamPage(page(plain), page(plain)));
  check("a different article is a change", !sameStreamPage(page(plain), page([item("a"), item("z")])));
  check("a shorter page is a change", !sameStreamPage(page(plain), page([item("a")])));
  check(
    "a new continuation is a change",
    !sameStreamPage(page(plain, "c1"), page([item("a"), item("b")], "c2")),
  );
  check(
    "no continuation is not a change from none",
    sameStreamPage(page(plain), page([item("a"), item("b")], undefined)),
  );
  check(
    "a read flag moving is a change",
    !sameStreamPage(
      page([item("a")]),
      page([{ ...item("a"), categories: ["user/-/state/com.google/read"] }]),
    ),
  );
  check(
    "an edited title is a change",
    !sameStreamPage(page([item("a")]), page([{ ...item("a"), title: "Renamed" }])),
  );
  check("reordered articles are a change", !sameStreamPage(page(plain), page([item("b"), item("a")])));
}

/* -------------------------------------------------------------------------
 * The generation guard: a stale response can never paint.
 * ---------------------------------------------------------------------- */

{
  const loads = new StreamLoads(2);
  const first = loads.begin("feed/a");
  check("the first load for a stream is current", loads.current(first));
  check("and holds a live controller", !first.controller.signal.aborted);

  const second = loads.begin("feed/a");
  check("a newer load for the same stream becomes current", loads.current(second));
  check("the load it replaced is no longer current", !loads.current(first));
  check("the replaced request is aborted", first.controller.signal.aborted);
  check("the replacement was not aborted", !second.controller.signal.aborted);
  check("only one load is held per stream", loads.loading === 1);

  const other = loads.begin("feed/b");
  check("loading another stream leaves this one current", loads.current(other) && loads.current(second));
  loads.settle(other);
  check("settling a load releases it", loads.inFlight("feed/b") === undefined);
  check("settling one stream leaves the other current", loads.current(second));

  // The stale load's own `finally` runs after it was replaced: it must not
  // clear the newer load's place.
  loads.settle(first);
  check("a superseded load settling cannot clear the newer one", loads.current(second));

  loads.abandonAll();
  check("abandoning everything aborts the live request", second.controller.signal.aborted);
  check("and forgets it", loads.loading === 0 && loads.inFlight("feed/a") === undefined);
}

/* -------------------------------------------------------------------------
 * Prefetch: never more than two in flight.
 * ---------------------------------------------------------------------- */

{
  const loads = new StreamLoads(2);
  const a = loads.startPrefetch("feed/a");
  const b = loads.startPrefetch("feed/b");
  check("two guesses may be on their way", a !== null && b !== null && loads.prefetching === 2);
  check("a third waits its turn", loads.startPrefetch("feed/c") === null);
  check("the same stream is not guessed at twice", loads.startPrefetch("feed/a") === null);

  const live = loads.begin("feed/d");
  check("a stream already being fetched is not guessed at", loads.startPrefetch("feed/d") === null);
  loads.settle(live);

  loads.finishPrefetch("feed/a", a);
  check("a settled guess frees its slot", loads.prefetching === 1);
  const c = loads.startPrefetch("feed/c");
  check("and the waiting stream can start", c !== null && loads.prefetching === 2);

  // Opening a feed the pointer was resting on is the guess paying off, so the
  // load must ride the request rather than abort it and start over.
  loads.begin("feed/b");
  check("opening a hovered feed does not abort its guess", !b.signal.aborted);
  check("and that stream is no longer guessed at", loads.startPrefetch("feed/b") === null);

  loads.finishPrefetch("feed/b", b);
  check("only the starting controller can free a slot", loads.prefetching === 1);

  loads.abandonAll();
  check("abandoning aborts guesses too", c.signal.aborted && loads.prefetching === 0);
  check("and the cap is free again after a session change", loads.startPrefetch("feed/z") !== null);
}

/* -------------------------------------------------------------------------
 * Scroll memory: where each stream was left.
 * ---------------------------------------------------------------------- */

{
  const scroll = new StreamScroll(3);
  check("a stream never shown has no position", scroll.recall("s/1") === undefined);
  scroll.remember("s/1", 400);
  check("a remembered position comes back", scroll.recall("s/1") === 400);
  check("a position is rounded", (() => {
    scroll.remember("s/1", 400.6);
    return scroll.recall("s/1") === 401;
  })());
  check("a negative offset is clamped to the top", (() => {
    scroll.remember("s/1", -30);
    return scroll.recall("s/1") === 0;
  })());
  check("zero is a position, not an absence", scroll.recall("s/1") === 0);

  scroll.remember("s/2", 100);
  scroll.remember("s/3", 200);
  check("fills up to its bound", scroll.size === 3);
  scroll.remember("s/4", 300);
  check("never exceeds its bound", scroll.size === 3);
  check("drops the least recently used", scroll.recall("s/1") === undefined);

  // Reading a stream again makes it recent, so the next eviction takes the one
  // that has now gone longest without being either written or read.
  scroll.recall("s/2");
  scroll.remember("s/5", 500);
  check(
    "recalling keeps an entry",
    scroll.recall("s/3") === undefined && scroll.recall("s/2") === 100,
  );

  scroll.forget("s/2");
  check("forget drops one stream", scroll.recall("s/2") === undefined);
  scroll.clear();
  check("clear forgets them all", scroll.size === 0 && scroll.recall("s/4") === undefined);
}

/* -------------------------------------------------------------------------
 * Switch timings: a p50/p95 that can be checked against a target.
 * ---------------------------------------------------------------------- */

{
  check("p50 of an odd sample is its middle", percentile([5, 1, 3], 50) === 3);
  check("p50 of an even sample is the lower middle", percentile([10, 20, 30, 40], 50) === 20);
  check("p95 of four samples is the top one", percentile([10, 20, 30, 40], 95) === 40);
  check("a percentile of nothing is zero", percentile([], 50) === 0);
  check("summarising nothing reports no samples", summarize([]).n === 0 && summarize([]).p95 === 0);
  const stats = summarize([40, 10, 30, 20]);
  check("the summary counts and ranks the sample", stats.n === 4 && stats.p50 === 20 && stats.p95 === 40);
}

{
  const perf = new StreamPerf(3);
  for (const ms of [1, 2, 3, 4, 5]) perf.record("paint", "cache", ms);
  const bucket = perf.stats("paint", "cache");
  check("the buffer keeps the newest samples", bucket.n === 3 && bucket.p50 === 4 && bucket.p95 === 5);
  check(
    "buckets do not mix sources or phases",
    perf.stats("paint", "network").n === 0 && perf.stats("fetch", "cache").n === 0,
  );
  check(
    "cached and cold are reported apart",
    perf.line().includes("cache paint") && !perf.line().includes("network "),
  );
}

{
  const perf = new StreamPerf();
  check("a fresh profiler is empty", perf.empty && perf.line() === "");
  const end = perf.span("fetch", "network");
  end();
  check("a span records one sample", perf.stats("fetch", "network").n === 1);
  check(
    "a span is on the browser's own timeline",
    performance.getEntriesByName("hardlyreader.stream.network.fetch").length >= 1,
  );
  check(
    "the line names the source, the phase and the counts",
    /network fetch p50 \d+ms p95 \d+ms \(n=1\)/.test(perf.line()),
  );
  // The request layer times the request and the body read, so those arrive as
  // durations rather than spans; they still belong on the browser's timeline.
  perf.record("parse", "network", 4);
  check("a duration timed elsewhere is recorded", perf.stats("parse", "network").n === 1);
  check(
    "and drawn on the timeline as a measure",
    performance.getEntriesByName("hardlyreader.stream.network.parse").length >= 1,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
