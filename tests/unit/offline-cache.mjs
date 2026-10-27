/**
 * The offline cache: the policy, the eviction plan, and both engines.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/offline-cache.mjs
 *
 * Two halves, because the cache has two kinds of answer:
 *
 * 1. **The policy is pure.** Sizes, the limit ladder, pinned feed ids and the
 *    sentence a report becomes are checked directly — no database, no store.
 * 2. **The plan is run for real.** The store is asked to prune and to clear
 *    against the in-memory engine and against Node's own SQLite, running the
 *    same `CREATE TABLE` text the desktop build runs. Both engines must leave
 *    the same rows behind: bodies gone, extraction rows gone, and the reader's
 *    list — subscriptions, titles, summaries, read and star marks — untouched,
 *    because that is the line between a cache and a data loss.
 *
 * The one thing these checks cannot prove is what the settings panel looks
 * like; `settings-panel.mjs` renders it and covers that separately.
 */
import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import {
  CACHE_LIMIT_CHOICES,
  CACHE_POLICY_DEFAULT,
  MB,
  bytesOf,
  describeCache,
  formatBytes,
  formatLimit,
  pinnedFeedUrls,
} from "../../src/api/local/cache.ts";
import {
  TABLES,
  columnNames,
  columnValues,
  createTableSql,
  tableNames,
} from "../../src/api/local/schema.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/* ---------------------------------------------------------------------------
 * Node's own SQLite, driven through the four methods the app's seam needs.
 *
 * Written here rather than under `src/` because it is not part of the app: it is
 * the app's SQL running on an engine the test process can load. A mock of
 * SQLite could not tell you the `CREATE TABLE` text or the upsert were valid.
 * ------------------------------------------------------------------------- */
class NodeSqliteDatabase {
  engine = "sqlite";

  constructor(db) {
    this.db = db;
    for (const table of tableNames()) db.exec(createTableSql(table));
  }

  async all(table) {
    return this.db.prepare(`SELECT * FROM "${table}"`).all();
  }

  async get(table, key) {
    return this.db.prepare(`SELECT * FROM "${table}" WHERE "key" = ?`).all(key)[0] ?? null;
  }

  async getMany(table, keys) {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM "${table}" WHERE "key" IN (${placeholders})`)
      .all(...keys);
  }

  async write(operations) {
    if (operations.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const operation of operations) {
        if (operation.type === "delete") {
          this.db.prepare(`DELETE FROM "${operation.table}" WHERE "key" = ?`).run(operation.key);
          continue;
        }
        const table = operation.table;
        const columns = columnNames(table);
        const placeholders = columns.map(() => "?").join(", ");
        const updates = TABLES[table].columns
          .map((column) => `"${column.name}" = excluded."${column.name}"`)
          .join(", ");
        this.db
          .prepare(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
              `VALUES (${placeholders}) ON CONFLICT("key") DO UPDATE SET ${updates}`,
          )
          .run(operation.row.key, ...columnValues(table, operation.row));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async close() {
    this.db.close();
  }
}

/* ---------------------------------------------------------------------------
 * The policy, which needs no database
 * ------------------------------------------------------------------------- */

function policyChecks() {
  console.log("\npolicy");

  return (async () => {
    await check("sizes read the way a person reads them", () => {
      if (formatBytes(0) !== "0 B") throw new Error(formatBytes(0));
      if (formatBytes(1024) !== "1 KB") throw new Error(formatBytes(1024));
      if (formatBytes(250 * MB) !== "250 MB") throw new Error(formatBytes(250 * MB));
      if (formatBytes(Math.round(1.5 * MB)) !== "1.5 MB") throw new Error(formatBytes(Math.round(1.5 * MB)));
    });

    await check("a ceiling of nothing says so in words", () => {
      if (formatLimit(0) !== "No limit") throw new Error(formatLimit(0));
      if (formatLimit(100 * MB) !== "100 MB") throw new Error(formatLimit(100 * MB));
    });

    await check("the ladder is five answers, smallest first, with no ceiling in it", () => {
      if (CACHE_LIMIT_CHOICES[0] !== 0) throw new Error(CACHE_LIMIT_CHOICES.join(","));
      const sorted = [...CACHE_LIMIT_CHOICES].sort((a, b) => a - b);
      if (sorted.join(",") !== CACHE_LIMIT_CHOICES.join(",")) throw new Error("out of order");
      if (CACHE_LIMIT_CHOICES.length !== 5) throw new Error(String(CACHE_LIMIT_CHOICES.length));
      if (!CACHE_LIMIT_CHOICES.includes(CACHE_POLICY_DEFAULT.limitBytes)) {
        throw new Error("the default is not one of the choices the panel can show");
      }
    });

    await check("a pin's stream id becomes the feed URL the library files under", () => {
      const urls = pinnedFeedUrls([`feed/${FEED_A}`, `feed/${FEED_B}`]);
      if (urls.join(",") !== [FEED_A, FEED_B].join(",")) throw new Error(urls.join(","));
    });

    await check("a percent-encoded pin is read back, and a bare URL is left alone", () => {
      const encoded = pinnedFeedUrls(["feed/https%3A%2F%2Fa.test%2Frss"]);
      if (encoded[0] !== FEED_A) throw new Error(encoded[0]);
      const bare = pinnedFeedUrls([FEED_B]);
      if (bare[0] !== FEED_B) throw new Error(bare[0]);
    });

    await check("bytes are measured as UTF-8, so an accented title costs what it costs", () => {
      if (bytesOf("abc") !== 3) throw new Error(String(bytesOf("abc")));
      if (bytesOf("é") !== 2) throw new Error(String(bytesOf("é")));
      if (bytesOf(null) !== 0 || bytesOf("") !== 0) throw new Error("empty text costs bytes");
    });

    await check("a report becomes one sentence, and an empty one says so", () => {
      const one = describeCache({ bodies: 1, extractions: 2, bytesBefore: 3000, bytesAfter: 1000, overLimit: false });
      if (one !== "Cleared 1 cached article and 2 extracted bodies — 2 KB freed") throw new Error(one);
      const many = describeCache({ bodies: 3, extractions: 0, bytesBefore: 2048, bytesAfter: 0, overLimit: false });
      if (many !== "Cleared 3 cached articles — 2 KB freed") throw new Error(many);
      const none = describeCache({ bodies: 0, extractions: 0, bytesBefore: 0, bytesAfter: 0, overLimit: false });
      if (!/already empty/.test(none)) throw new Error(none);
    });
  })();
}

/* ---------------------------------------------------------------------------
 * The store, once per engine
 * ------------------------------------------------------------------------- */

/**
 * A library with three articles in one feed and one in another.
 *
 * Bodies are 40 bytes of `x` each with a distinct summary, one article is read,
 * one is starred, one has an extracted body twice the size of the feed's copy.
 * Nothing here is random: a size assertion has to be a number this file wrote.
 */
async function seeded(database) {
  const store = new LocalStore(database);
  await store.subscribe(FEED_A, { title: "A feed", folder: "Comics" });
  await store.subscribe(FEED_B, { title: "B feed" });

  const body = (letter) => letter.repeat(40);
  await store.putEntries([
    { feedUrl: FEED_A, guid: "a", title: "Oldest", summary: "first", content: body("a"), published: 100 },
    { feedUrl: FEED_A, guid: "b", title: "Middle", summary: "second", content: body("b"), published: 200 },
    { feedUrl: FEED_B, guid: "c", title: "Newest", summary: "third", content: body("c"), published: 300 },
  ]);

  const ids = (await store.queryEntries({ count: 10 })).entries;
  const byGuid = new Map(ids.map((row) => [row.guid, row.key]));
  const readKey = byGuid.get("a");
  const starredKey = byGuid.get("b");
  await store.setRead([readKey], true);
  await store.setStarred([starredKey], true);
  await store.saveExtraction({ itemId: byGuid.get("c"), html: "y".repeat(80) });
  await store.saveExtraction({ itemId: byGuid.get("a"), html: null, error: "refused by the page" });

  return { store, readKey, starredKey };
}

async function suite(label, makeDatabase) {
  const first = makeDatabase();
  console.log(`\n${label} (${first.engine})`);
  const say = (name) => `${label}: ${name}`;

  /* Usage ------------------------------------------------------------------ */

  {
    const { store } = await seeded(first);
    const usage = await store.cacheUsage();
    await check(say("the readout counts the list and the copies apart"), async () => {
      if (usage.feeds !== 2) throw new Error(`feeds ${usage.feeds}`);
      if (usage.items !== 3) throw new Error(`items ${usage.items}`);
      if (usage.cached !== 3) throw new Error(`cached ${usage.cached}`);
      if (usage.read !== 1) throw new Error(`read ${usage.read}`);
      if (usage.starred !== 1) throw new Error(`starred ${usage.starred}`);
      if (usage.extracted !== 1) throw new Error(`extracted ${usage.extracted}`);
      if (usage.articleBytes !== 120) throw new Error(`articles ${usage.articleBytes}`);
      // One successful body of 80 and one remembered failure of 21 characters.
      if (usage.extractionBytes !== 80 + "refused by the page".length) {
        throw new Error(`extractions ${usage.extractionBytes}`);
      }
      if (usage.libraryBytes <= 0) throw new Error("the list itself costs nothing");
      if (usage.totalBytes !== usage.articleBytes + usage.extractionBytes + usage.libraryBytes) {
        throw new Error("the total is not its parts");
      }
    });

    await check(say("a generous ceiling on the default policy drops nothing"), async () => {
      const before = await store.cacheUsage();
      const report = await store.pruneCache({ ...CACHE_POLICY_DEFAULT, limitBytes: 100 * MB });
      const after = await store.cacheUsage();
      if (report.bodies !== 0 || report.extractions !== 0) throw new Error(JSON.stringify(report));
      if (after.totalBytes !== before.totalBytes) throw new Error("something changed");
      if (report.overLimit) throw new Error("a 100 MB ceiling was reported as exceeded");
    });

    await check(say("dropping the read copy takes its extraction and keeps its flags"), async () => {
      const read = (await store.queryEntries({ count: 10 })).entries.find((row) => row.read === 1);
      const report = await store.pruneCache({ ...CACHE_POLICY_DEFAULT, keepRead: false });
      if (report.bodies !== 1) throw new Error(`dropped ${report.bodies} bodies`);
      // The read article's remembered failure goes with it; the other extraction stays.
      if (report.extractions !== 1) throw new Error(`dropped ${report.extractions} extractions`);

      const row = await store.entry(read.key);
      if (row === null) throw new Error("the article itself was deleted");
      if (row.content !== null) throw new Error("its body was kept");
      if (row.read !== 1) throw new Error("its read mark was lost");
      if (row.summary !== "first") throw new Error(`its summary is ${String(row.summary)}`);
      if ((await store.extraction(read.key)) !== null) throw new Error("its extraction was kept");

      const kept = await store.entry((await store.queryEntries({ count: 10 })).entries.find((r) => r.guid === "c").key);
      if (kept === null || kept.content === null) throw new Error("an unread copy was dropped too");
      if ((await store.extraction(kept.key)) === null) throw new Error("the other extraction was dropped");
    });

    await check(say("the ceiling only counts copies, never the list"), async () => {
      // A ceiling below the library's own size: every body goes, and the plan
      // says the ceiling still was not met rather than deleting the reader's list.
      const report = await store.pruneCache({ ...CACHE_POLICY_DEFAULT, limitBytes: 1 });
      const usage = await store.cacheUsage();
      // One body survives and it is the starred one: protection beats the ceiling.
      if (usage.cached !== 1) throw new Error(`${usage.cached} bodies survived a 1-byte ceiling`);
      const survivor = (await store.queryEntries({ count: 10 })).entries.find((row) => row.content !== null);
      if (survivor === undefined || survivor.starred !== 1) throw new Error("the wrong body survived");
      if (usage.items !== 3) throw new Error(`the list lost articles: ${usage.items}`);
      if (usage.extractionBytes !== 0) throw new Error("extractions survived a 1-byte ceiling");
      if (!report.overLimit) throw new Error("the report claims a 1-byte ceiling was met");
    });
  }

  /* Protection -------------------------------------------------------------- */

  {
    const { store } = await seeded(makeDatabase());
    await check(say("starred and pinned copies are never evicted, whatever the ceiling"), async () => {
      const report = await store.pruneCache(
        { ...CACHE_POLICY_DEFAULT, limitBytes: 1 },
        { pinnedFeeds: [FEED_A] },
      );
      const rows = (await store.queryEntries({ count: 10 })).entries;
      const kept = rows.filter((row) => row.content !== null).map((row) => row.guid).sort();
      // Everything in feed A is pinned; the one starred article is in it too.
      if (kept.join(",") !== "a,b") throw new Error(`kept ${kept.join(",")}`);
      if (report.bodies !== 1) throw new Error(`dropped ${report.bodies} bodies`);
      if (!report.overLimit) throw new Error("everything left is protected, but the report says it fit");
    });

    await check(say("turning the star's protection off lets the limit reach it"), async () => {
      const { store: fresh, starredKey } = await seeded(makeDatabase());
      // A ceiling of 80 bytes fits two of the three 40-byte bodies, so the
      // eviction has to choose: oldest first, and with keepStarred off the
      // starred copy is no longer set aside.
      await fresh.pruneCache({ ...CACHE_POLICY_DEFAULT, keepStarred: false, limitBytes: 80 });
      const rows = (await fresh.queryEntries({ count: 10 })).entries;
      const kept = rows.filter((row) => row.content !== null).map((row) => row.guid).sort();
      // Only the read article survives: the star no longer protects it, and the
      // read mark still does. That is the two protections behaving separately.
      if (kept.join(",") !== "a") throw new Error(`kept ${kept.join(",")}`);
      const star = await fresh.entry(starredKey);
      if (star === null) throw new Error("the starred article was deleted");
      if (star.starred !== 1) throw new Error("its star was lost with its copy");
    });
  }

  /* Clearing --------------------------------------------------------------- */

  {
    const { store, readKey, starredKey } = await seeded(makeDatabase());
    const before = await store.cacheUsage();
    const report = await store.clearCache();
    await check(say("clearing drops every copy and keeps the library"), async () => {
      const usage = await store.cacheUsage();
      if (report.bodies !== 3) throw new Error(`cleared ${report.bodies} bodies`);
      if (report.extractions !== 2) throw new Error(`cleared ${report.extractions} extractions`);
      if (usage.cached !== 0) throw new Error(`${usage.cached} bodies left`);
      if (usage.extractionBytes !== 0) throw new Error("extraction bytes left");
      if (usage.items !== 3) throw new Error(`list lost articles: ${usage.items}`);
      if (usage.feeds !== 2) throw new Error(`subscriptions lost: ${usage.feeds}`);
      if (usage.totalBytes !== usage.libraryBytes) throw new Error("the total is not the library");
      // The report measures copies, not the list: after a clear there are none,
      // so it ends at zero even though the library still occupies bytes.
      if (report.bytesAfter !== 0) throw new Error(`report says ${report.bytesAfter} left`);
      // The report's own measure is copies only: the list was never in the cache.
      if (report.bytesBefore !== before.articleBytes + before.extractionBytes) {
        throw new Error(`before ${report.bytesBefore}`);
      }
      const again = await store.entry(readKey);
      if (again === null) throw new Error("the read article was deleted");
      if (again.read !== 1) throw new Error("its read mark was lost");
      const star = await store.entry(starredKey);
      if (star === null || star.starred !== 1) throw new Error("its star was lost");
      if (star.summary !== "second") throw new Error("its summary was lost");
      if ((await store.queryEntries({ count: 10 })).entries.length !== 3) {
        throw new Error("the list lost a row");
      }
    });

    await check(say("clearing twice is a no-op the second time"), async () => {
      const second = await store.clearCache();
      if (second.bodies !== 0 || second.extractions !== 0) throw new Error(JSON.stringify(second));
      if (!/already empty/.test(describeCache(second))) throw new Error(describeCache(second));
    });
  }

  await first.close();
}

/* ---------------------------------------------------------------------------
 * Run it
 * ------------------------------------------------------------------------- */

await policyChecks();
await suite("memory", () => new MemoryDatabase());

const DatabaseSync = await (async () => {
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch (error) {
    console.log("\nsqlite skipped, out loud: this Node has no node:sqlite");
    console.log(String(error));
    return null;
  }
})();

if (DatabaseSync !== null) {
  await suite("sqlite", () => new NodeSqliteDatabase(new DatabaseSync(":memory:")));
}

console.log(`\n${passed} checks passed`);
