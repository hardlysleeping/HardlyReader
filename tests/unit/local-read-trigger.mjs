/**
 * Local mode: a post opened on this device is marked read by the dwell.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/local-read-trigger.mjs
 *
 * `tests/unit/local-backend.mjs` proves the seam — `setRead` on a local library
 * writes the flag and the streams answer it — and `reader-state.mjs` proves the
 * dwell policy against a fake GReader server. Neither one puts the two
 * together, and the pair is where a bug hides: a store that marks nothing, or a
 * mark that never reaches the device's own library, both look like "opening a
 * post leaves it unread".
 *
 * So this suite drives the real `ReaderState` with a real `LocalBackend` over
 * the in-memory engine, and reads the answer back out of the *store* rather
 * than out of the item the store happens to hold.
 *
 * The timer is captured instead of waited out, so the suite proves the delay
 * and the firing without costing the reader three seconds.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { GEN_DIR, buildReaderModule } from "./build-reader.mjs";
import { READING_LIST, STATE_READ, isRead } from "../../src/api/freshrss.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { localProfile } from "../../src/api/profile.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const FEED = "https://fixture.test/feed.xml";
const T = 1_700_000_000;

// The reader is a runes module: compiled to plain ESM under `.gen/`, with its
// reading preferences next to it, so the singleton this suite pokes is the one
// the reader actually reads.
buildReaderModule();
writeFileSync(join(GEN_DIR, "reader.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader.mjs")).href);
const { reading } = await import(pathToFileURL(join(GEN_DIR, "reading.mjs")).href);

/* --------------------------------------------------------------------------
 * A local library with one feed and two posts, as `+ Add feed` and a fetch
 * would leave it.
 * ----------------------------------------------------------------------- */

const store = new LocalStore(new MemoryDatabase());
const backend = new LocalBackend(store, { deviceName: "This laptop" });
await backend.subscribe({ feedUrl: FEED, title: "Fixture feed" });
await store.putEntries([
  { feedUrl: FEED, guid: "one", title: "Fixture one", published: T + 20, content: "<p>First.</p>" },
  { feedUrl: FEED, guid: "two", title: "Fixture two", published: T + 10, content: "<p>Second.</p>" },
]);

const reader = new ReaderState();
reader.profile = localProfile(backend);
reader.backend = backend;
await reader.openStream(READING_LIST, "Reading list");

check("the local library fills the reader's list", reader.items.length === 2, String(reader.items.length));
check("the list is the local store's order", reader.items[0].title === "Fixture one", String(reader.items[0]?.title));

const first = reader.items[0];
const second = reader.items[1];

/* --------------------------------------------------------------------------
 * The dwell, with the timer captured
 * ----------------------------------------------------------------------- */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let armed = null;

globalThis.setTimeout = (fn, ms) => {
  armed = { fn, ms };
  return 1;
};
globalThis.clearTimeout = () => {
  armed = null;
};

const settle = () => new Promise((resolve) => realSetTimeout(resolve, 20));

try {
  // Manual is the default, and it means exactly what it says: opening a post
  // is not reading it.
  reading.setAutoMarkRead(false);
  reader.select(first);
  check("with the preference off, opening a post arms nothing", armed === null, String(armed?.ms));

  // On, and the clock starts for the post that was just opened.
  reading.setAutoMarkRead(true);
  reader.select(first);
  check("opening a post arms the dwell", armed?.ms === 3000, String(armed?.ms));

  // The firing is the whole question: does the mark reach the device's library?
  armed.fn();
  await settle();

  const marked = await store.entry(first.id);
  check("the dwell marks it read in the local store", marked?.read === 1, String(marked?.read));
  check("and the item on screen says so", isRead(first), JSON.stringify(first.categories));
  check("the read tag is the one GReader uses", (first.categories ?? []).includes(STATE_READ));

  const untouched = await store.entry(second.id);
  check("the post that was never opened stays unread", untouched?.read === 0, String(untouched?.read));

  const unread = await backend.stream(READING_LIST, { count: 10, excludeRead: true });
  check(
    "the unread view drops it, so the mark reached the library and not just the row",
    !unread.items.some((item) => item.id === first.id),
    unread.items.map((item) => item.title).join(","),
  );

  // The delay is a setting, and the timer follows it.
  reading.setAutoMarkSeconds(6);
  reader.select(second);
  check("the configured delay is the one used", armed?.ms === 6000, String(armed?.ms));
  reading.setAutoMarkSeconds(3);

  // Leaving the post before the clock runs out must cancel, not mark later.
  reader.closeReader();
  check("closing the post disarms its timer", armed === null, String(armed?.ms));

  // A post already read needs no timer.
  reader.select(first);
  check("a post that is already read arms nothing", armed === null, String(armed?.ms));

  // And with the preference off again, nothing is armed for the second post.
  reading.setAutoMarkRead(false);
  reader.select(second);
  check("turning it off again stops arming", armed === null, String(armed?.ms));
  armed?.fn?.();
  await settle();
  const after = await store.entry(second.id);
  check("and firing nothing marks nothing", after?.read === 0, String(after?.read));
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  await store.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
