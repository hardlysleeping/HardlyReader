/**
 * The desktop store: the driver that actually ships, run against real SQLite.
 *
 * `local-backend.mjs` proves the store's queries through an adapter written in
 * the test, which is the right way to prove the schema and the queries — but it
 * proves them through a *copy* of the desktop driver's SQL, not through
 * `SqliteDatabase` itself. This suite closes that gap: it opens the real
 * `SqliteDatabase` over a stand-in for the Tauri plugin that executes the
 * statements the driver emits into Node's own SQLite, so the `CREATE TABLE`
 * text, the `ALTER TABLE` migration, the `$n` binding order, the upsert, the
 * batched `IN (…)` and the `BEGIN`/`ROLLBACK` around a write are the ones the
 * app runs — not a re-implementation of them.
 *
 * What is still not covered here, and cannot be without launching the app: the
 * IPC hop into Rust. Everything on this side of it is.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-sqlite-driver.mjs
 */
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import {
  LOCAL_DATABASE_FILE,
  SqliteDatabase,
  ensureColumns,
} from "../../src/api/local/sqlite-db.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { tableNames, TABLES } from "../../src/api/local/schema.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function refused(work) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

let sqliteModule = null;
try {
  sqliteModule = await import("node:sqlite");
} catch {
  console.log("\ndesktop driver (skipped: this Node has no node:sqlite)");
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}

const { DatabaseSync } = sqliteModule;

/**
 * The Tauri SQL plugin's three methods, over Node's SQLite.
 *
 * It is deliberately a translator with no opinions: every statement is recorded
 * before it is run, so a check can assert on what the driver asked for, and the
 * `$1`-style placeholders the plugin (sqlx) requires are turned into `?` in the
 * order they appear — refusing any numbering the driver could not have bound,
 * which is the one way a wrong placeholder would otherwise pass silently.
 */
class FakePlugin {
  constructor(db) {
    this.db = db;
    this.statements = [];
  }

  /** Records what ran, so a check can read the sequence rather than guess it. */
  get log() {
    return this.statements.map((statement) => statement.query.replace(/\s+/g, " ").trim());
  }

  count(prefix) {
    return this.log.filter((query) => query.startsWith(prefix)).length;
  }

  #prepare(query, values) {
    const bound = values ?? [];
    let expected = 1;
    const positional = query.replace(/\$(\d+)/g, (whole, number) => {
      if (Number(number) !== expected) {
        fail(`$${number} came after $${expected - 1}, so the values would bind in the wrong order`);
      }
      expected += 1;
      return "?";
    });
    if (expected - 1 !== bound.length) {
      fail(`${expected - 1} placeholders were given ${bound.length} values: ${query}`);
    }
    return positional;
  }

  async execute(query, values) {
    this.statements.push({ query, values });
    this.db.prepare(this.#prepare(query, values)).run(...(values ?? []));
    return [];
  }

  async select(query, values) {
    this.statements.push({ query, values });
    return this.db.prepare(this.#prepare(query, values)).all(...(values ?? []));
  }

  async close() {
    this.db.close();
    return true;
  }
}

/** A library with this driver in front of it, and the plugin it talks to. */
async function opened() {
  const plugin = new FakePlugin(new DatabaseSync(":memory:"));
  const db = await SqliteDatabase.open(LOCAL_DATABASE_FILE, async () => plugin);
  return { db, plugin };
}

const T = 1_700_000_000;
const FEED = "https://a.test/rss";

/* -------------------------------------------------------------------------- */

console.log("\ndesktop driver: opening");

await check("opening creates every table the schema declares", async () => {
  const { db, plugin } = await opened();
  const names = plugin.log
    .filter((query) => query.startsWith("CREATE TABLE IF NOT EXISTS"))
    .map((query) => query.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/)[1]);
  equal(names.join(","), tableNames().join(","), "tables created");
  for (const table of tableNames()) {
    const rows = await plugin.select(`SELECT name FROM pragma_table_info('${table}')`);
    const stored = rows.map((row) => row.name);
    const declared = ["key", ...TABLES[table].columns.map((column) => column.name)];
    equal(stored.sort().join(","), declared.sort().join(","), `${table} columns`);
  }
  await db.close();
});

await check("a library from before a column existed is brought forward", async () => {
  const plugin = new FakePlugin(new DatabaseSync(":memory:"));
  // The shape `entries` had before `stored_at` and the feed poll columns were
  // added: same table, fewer columns, one row already in it.
  plugin.db.exec(
    `CREATE TABLE "entries" ("key" TEXT PRIMARY KEY NOT NULL, "feed" TEXT, "guid" TEXT, "title" TEXT)`,
  );
  plugin.db.prepare(`INSERT INTO "entries" ("key", "feed", "guid", "title") VALUES (?, ?, ?, ?)`).run(
    "old",
    FEED,
    "old",
    "A post from before",
  );

  const db = await SqliteDatabase.open(LOCAL_DATABASE_FILE, async () => plugin);
  const rows = await plugin.select(`SELECT * FROM "entries"`);
  equal(rows.length, 1, "the row that was already there");
  const row = await db.get("entries", "old");
  equal(row.stored_at, null, "the new column exists, null on the old row");
  equal(row.title, "A post from before", "and the old columns kept their values");
  await db.close();
});

await check("ensureColumns adds nothing to a table that is already whole", async () => {
  const { db, plugin } = await opened();
  const added = await ensureColumns(plugin, "feeds");
  equal(added.length, 0, "columns added");
  await db.close();
});

await check("a write with nothing in it touches the database not at all", async () => {
  const { db, plugin } = await opened();
  const before = plugin.log.length;
  await db.write([]);
  equal(plugin.log.length, before, "statements run");
  await db.close();
});

console.log("\ndesktop driver: the library through the store");

await check("a feed, its articles, the flags and the reading position round-trip", async () => {
  const { db, plugin } = await opened();
  const store = new LocalStore(db);

  await store.subscribe(FEED, { title: "A", folder: "Comics" });
  await store.putEntries([
    { feedUrl: FEED, guid: "one", title: "First", published: T },
    { feedUrl: FEED, guid: "two", title: "Second", published: T + 60 },
  ]);
  const itemId = localItemId(FEED, "one");
  await store.setRead([itemId], true);
  await store.setStarred([itemId], true);
  await store.saveExtraction({ itemId, html: "<p>Readable</p>" });
  await store.savePosition(`feed/${FEED}`, { itemId, offset: 0.5 });

  // A second run over the same file, to prove it is the database answering.
  const again = new LocalStore(db);
  const page = await again.queryEntries({ feeds: [FEED] });
  equal(page.entries.length, 2, "articles stored");
  const one = page.entries.find((entry) => entry.key === itemId);
  equal(one.read, 1, "read");
  equal(one.starred, 1, "starred");
  equal((await again.extraction(itemId)).html, "<p>Readable</p>", "extraction");
  equal((await again.position(`feed/${FEED}`)).offset, 0.5, "reading position");
  equal((await again.folders()).map((folder) => folder.key).join(","), "Comics", "folder");

  // And the writes were transactions, not a statement at a time.
  equal(plugin.count("BEGIN"), plugin.count("COMMIT"), "every transaction committed");
  await db.close();
});

await check("a page of more than 400 articles is read in more than one statement", async () => {
  const { db, plugin } = await opened();
  const store = new LocalStore(db);
  await store.subscribe(FEED, { title: "A" });
  await store.putEntries(
    Array.from({ length: 450 }, (_, index) => ({
      feedUrl: FEED,
      guid: `g${index}`,
      title: `Post ${index}`,
      published: T + index,
    })),
  );

  const ids = Array.from({ length: 450 }, (_, index) => localItemId(FEED, `g${index}`));
  const start = plugin.log.length;
  const rows = await db.getMany("entries", ids);
  equal(rows.length, 450, "rows found");
  const selects = plugin.log.slice(start).filter((query) => query.includes('FROM "entries"'));
  equal(selects.length, 2, "SELECTs for 450 keys");
  await db.close();
});

console.log("\ndesktop driver: two writes at once");

await check("concurrent writes take turns, so no two transactions overlap", async () => {
  const { db, plugin } = await opened();
  const store = new LocalStore(db);
  await store.subscribe(FEED, { title: "A" });
  const start = plugin.log.length;

  const first = store.putEntries([{ feedUrl: FEED, guid: "a", title: "A", published: T }]);
  const second = store.putEntries([{ feedUrl: FEED, guid: "b", title: "B", published: T + 1 }]);
  await Promise.all([first, second]);

  const transactions = plugin.log.slice(start).filter((query) => query === "BEGIN" || query === "COMMIT");
  equal(transactions.join(","), "BEGIN,COMMIT,BEGIN,COMMIT", "no interleaving");
  equal((await store.queryEntries({ feeds: [FEED] })).entries.length, 2, "both writes landed");
  await db.close();
});

await check("a write that fails is rolled back, and leaves the library as it was", async () => {
  const { db, plugin } = await opened();
  const store = new LocalStore(db);
  await store.subscribe(FEED, { title: "A" });
  await store.putEntries([{ feedUrl: FEED, guid: "one", title: "First", published: T }]);
  const itemId = localItemId(FEED, "one");

  const start = plugin.log.length;
  const before = await db.get("entries", itemId);
  const error = await refused(() =>
    db.write([
      { type: "put", table: "entries", row: { ...before, read: 1 } },
      // `key` is the primary key and NOT NULL: SQLite refuses this, halfway
      // through a transaction that has already marked the first article read.
      { type: "put", table: "entries", row: { ...before, key: null } },
    ]),
  );
  equal(error === null, false, "the write was refused");
  const rolled = plugin.log.slice(start);
  equal(rolled.includes("ROLLBACK"), true, "the transaction was rolled back");
  equal(rolled.includes("COMMIT"), false, "and not committed");
  equal((await db.get("entries", itemId)).read, 0, "the first article is still unread");

  // A failed write must not leave the queue poisoned.
  await store.setRead([itemId], true);
  equal((await db.get("entries", itemId)).read, 1, "the next write still works");
  await db.close();
});

await check("a removed feed takes its articles, extraction and position with it", async () => {
  const { db } = await opened();
  const store = new LocalStore(db);
  await store.subscribe(FEED, { title: "A" });
  await store.putEntries([{ feedUrl: FEED, guid: "one", title: "First", published: T }]);
  const itemId = localItemId(FEED, "one");
  await store.saveExtraction({ itemId, html: "<p>Readable</p>" });
  await store.savePosition(`feed/${FEED}`, { itemId, offset: 0.25 });
  equal((await db.all("entries")).length, 1, "the article is there to begin with");

  await store.unsubscribe(FEED);
  equal((await db.all("entries")).length, 0, "articles deleted");
  equal((await db.all("extractions")).length, 0, "extraction deleted");
  equal((await db.all("positions")).length, 0, "position deleted");
  equal((await db.all("feeds")).length, 0, "feed deleted");
  await db.close();
});

console.log("\ndesktop driver: the same library as the browser");

await check("a local library read through this driver matches the in-memory one", async () => {
  const { db } = await opened();
  equal(db.engine, "sqlite", "the driver says which engine it is");

  const shape = async (store) => {
    await store.subscribe(FEED, { title: "A", folder: "Comics" });
    await store.putEntries([
      { feedUrl: FEED, guid: "one", title: "First", published: T },
      { feedUrl: FEED, guid: "two", title: "Second", published: T + 60 },
    ]);
    await store.setStarred([localItemId(FEED, "two")], true);
    const page = await store.queryEntries({ feeds: [FEED], starred: true });
    const counts = await store.counts();
    return {
      keys: page.entries.map((entry) => entry.key),
      starred: page.entries.map((entry) => entry.starred),
      counts: counts.map(({ feedUrl, count }) => ({ feedUrl, count })),
    };
  };

  const desktop = await shape(new LocalStore(db));
  const memory = await shape(new LocalStore(new MemoryDatabase()));
  equal(JSON.stringify(desktop), JSON.stringify(memory), "same rows either way");
  await db.close();
});

console.log(`\n${passed} checks passed`);
