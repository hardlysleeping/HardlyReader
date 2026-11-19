/**
 * The phone's head start: the next feed in the tree is warmed while the reader is
 * still on this one, so the tap that follows is a cache hit.
 *
 * A hover already prefetches on a desktop; a finger has no hover, which is why
 * moving between comic feeds on a phone paid a round trip on every tap. The
 * behaviour lives in `warmNextFeed` on the reader, so this suite reads that
 * method out of the source and holds its guards in place — the arithmetic it
 * uses (`cycleIndex`) is proved in `stream-cycle.mjs`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reader = readFileSync(join(root, "src/state/reader.svelte.ts"), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const start = reader.indexOf("private warmNextFeed(");
const body = start === -1 ? "" : reader.slice(start, start + 1400);
check("warmNextFeed exists on the reader", start !== -1);

// A desktop already prefetches on hover; warming on every platform would double
// the requests a mouse-driven window makes.
check("it runs only for a coarse pointer", /matchMedia\("\(pointer: coarse\)"\)/.test(body));
check("a platform without matchMedia is left alone", body.includes('typeof matchMedia !== "function"'));

// A merged column is composed from every account and is never cached, so warming
// one would file one account's answer as another's page.
check("a merged column is skipped", body.includes("this.mergesStream(this.activeStream)"));
check("the reading list is not a feed", body.includes("this.activeStream === \"\""));

// The tree's own order is the reading order; a category is not a feed.
check("the order is the tree's, falling back to the subscriptions", body.includes("this.feedOrder"));
check("only feeds are candidates", body.includes('id.startsWith("feed/")'));

// The neighbour, wrapping — the same arithmetic continuous reading uses.
check("the neighbour comes from cycleIndex", body.includes("cycleIndex(feeds.length, at, 1)"));
check("a stream that is not in the tree warms nothing", body.includes("if (at < 0) return;"));
check("the current stream is never the one warmed", body.includes("if (id !== this.activeStream)"));

// It has to be called where a switch actually landed, or it never runs: the
// cache-hit path and the painted network path, both.
const cacheHit = reader.indexOf('this.measurePaint("cache");');
const networkPaint = reader.indexOf('this.measurePaint("network");', cacheHit + 1);
check(
  "warmed after a cache hit",
  cacheHit !== -1 && reader.slice(cacheHit, cacheHit + 220).includes("this.warmNextFeed()"),
);
check(
  "warmed after a page is painted",
  networkPaint !== -1 && reader.slice(networkPaint, networkPaint + 220).includes("this.warmNextFeed()"),
);

// The prefetcher it drives is the hover one, so the in-flight cap and the
// abandonment timeout are shared rather than duplicated.
check("it reuses the hover prefetcher", body.includes("this.prefetchStream(id)"));

if (failures > 0) {
  console.log(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`warm-next-feed: ${checks} checks passed`);
