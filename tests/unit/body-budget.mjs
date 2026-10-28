// What a device keeps, and what goes when the space runs out.
//
// The policy only: three answers, one ceiling, and a least-recently-used order
// with one thing it must never do. No store, no network, no clock — so every
// number below is a decision this suite can argue with.
import {
  BODY_BUDGET_CHOICES_MB,
  BODY_BUDGET_DEFAULT,
  BODY_KEEP_DEFAULT,
  BODY_KEEP_LABELS,
  BODY_KEEP_MODES,
  BODY_MAX_POST,
  bodiesOverLimit,
  describeBodies,
  formatBytes,
  isBodyBudget,
  isBodyKeepMode,
  planBodyEviction,
} from "../../src/lib/bodies.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** One kept body, with the two stamps the order reads. */
const body = (itemId, bytes, usedAt, storedAt = usedAt) => ({ itemId, bytes, usedAt, storedAt });

// 1. The three answers, in the order the panel offers them.
check("three answers, in the order they are offered", BODY_KEEP_MODES.join(",") === "off,open,ahead");
check("off is what a fresh install gets", BODY_KEEP_DEFAULT === "off");
check("each answer has its own word", new Set(BODY_KEEP_MODES.map((m) => BODY_KEEP_LABELS[m])).size === 3);
check("a word that is not one of the three is refused", isBodyKeepMode("always") === false && isBodyKeepMode("off") === true);

// 2. The ceiling and the per-post limit.
check("24 MB is the default and it is one of the offered sizes", BODY_BUDGET_DEFAULT === 24 * 1024 * 1024 && BODY_BUDGET_CHOICES_MB.includes(24));
check("nothing below a megabyte is a ceiling", isBodyBudget(0) === false && isBodyBudget(512 * 1024) === false);
check("a stored size is a number of bytes, not a string", isBodyBudget("24 MB") === false);
check("two megabytes is the largest body worth keeping", BODY_MAX_POST === 2 * 1024 * 1024);
check("over the ceiling is over, not at", bodiesOverLimit({ count: 1, bytes: 100 }, 100) === false && bodiesOverLimit({ count: 1, bytes: 101 }, 100) === true);

// 3. Nothing goes while the library fits.
const fits = planBodyEviction([body("a", 40, 10), body("b", 40, 20)], { limitBytes: 100 });
check("a library inside its ceiling loses nothing", fits.drop.length === 0 && fits.overLimit === false);
check("and reports what it is holding", fits.remaining === 80 && fits.freed === 0);

// 4. Over the ceiling, the least recently used body goes first, and only enough
//    of them to get back inside.
const lru = planBodyEviction(
  [body("old", 40, 10), body("middle", 40, 20), body("new", 40, 30)],
  { limitBytes: 90 },
);
check("one body over the ceiling drops exactly one", lru.drop.join(",") === "old", lru.drop.join(","));
check("and the newest two stay", lru.remaining === 80 && lru.freed === 40);
check("a dropped body is the oldest read, not the oldest fetched", planBodyEviction(
  [body("read-recently", 40, 90, 10), body("fetched-recently", 40, 20, 90)],
  { limitBytes: 40 },
).drop.join(",") === "fetched-recently");

// 5. Two bodies read in the same second: the one fetched first goes first, and
//    two fetched in the same second are ordered by id — never by the engine's
//    own row order, which differs between IndexedDB and SQLite.
check("a tie is broken by when it was fetched", planBodyEviction(
  [body("later", 10, 50, 60), body("earlier", 10, 50, 40)],
  { limitBytes: 10 },
).drop.join(",") === "earlier");
check("and then by id, so the order cannot change between runs", planBodyEviction(
  [body("b", 10, 50, 50), body("a", 10, 50, 50)],
  { limitBytes: 10 },
).drop.join(",") === "a");

// 6. What a pane is drawing survives the pass, even when that leaves the library
//    over its ceiling.
const guarded = planBodyEviction(
  [body("on-screen", 40, 10), body("behind", 40, 20)],
  { limitBytes: 30, keep: ["on-screen"] },
);
check("a body a pane is showing is not evicted", guarded.drop.join(",") === "behind", guarded.drop.join(","));
check("and the pass says so when it could not reach the ceiling", guarded.overLimit === true && guarded.remaining === 40);
const walled = planBodyEviction([body("only", 40, 10)], { limitBytes: 0, keep: ["only"] });
check("a library of nothing but visible posts is left alone", walled.drop.length === 0 && walled.overLimit === true);

// 7. An empty body costs nothing and frees nothing: dropping it is a write to
//    the database for no reason.
check("an empty body is never evicted", planBodyEviction([body("empty", 0, 1)], { limitBytes: 0 }).drop.length === 0);

// 8. Words.
check("bytes as a reader says them", formatBytes(0) === "0 B" && formatBytes(1023) === "1023 B");
check("a kilobyte keeps one decimal below ten", formatBytes(1536) === "1.5 KB" && formatBytes(10240) === "10 KB");
check("a megabyte too", formatBytes(1.2 * 1024 * 1024) === "1.2 MB" && formatBytes(24 * 1024 * 1024) === "24 MB");
check("an empty library says so, and what it may hold", describeBodies({ count: 0, bytes: 0 }, 24 * 1024 * 1024) === "No saved text — up to 24 MB can be kept");
check("one article is singular", describeBodies({ count: 1, bytes: 1536 }, 24 * 1024 * 1024) === "1 article, 1.5 KB of 24 MB");
check("more than one is not", describeBodies({ count: 12, bytes: 1.2 * 1024 * 1024 }, 24 * 1024 * 1024) === "12 articles, 1.2 MB of 24 MB");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
