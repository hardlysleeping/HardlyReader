/**
 * Local mode: the store and the backend behind the seam.
 *
 * Node cannot load the Tauri SQL plugin — it is an IPC call into a Rust process
 * — so the driver interface is exercised twice here: once against the in-memory
 * store, and once against a real SQLite engine through `node:sqlite`, running
 * the exact `CREATE TABLE` text the desktop build runs. Every check below is
 * therefore run twice, and the pair of results is the proof that the two engines
 * are the same library: same rows, same pages, same refusals.
 *
 * The second engine is skipped, out loud, on a Node that has no `node:sqlite`;
 * what it always proves is the memory engine, which is the same code path.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-backend.mjs
 */
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStorageError } from "../../src/api/local/driver.ts";
import {
  columnNames,
  columnValues,
  createTableSql,
  tableNames,
  TABLES,
} from "../../src/api/local/schema.ts";
import {
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
  isRead,
  isStarred,
} from "../../src/api/freshrss.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

/** Runs something that is expected to be refused, and hands back the refusal. */
async function refused(work) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

const T = 1_700_000_000;
const FEED_A = "https://a.test/rss";
const FEED_B = "https://b.test/feed.xml";

/* ---------------------------------------------------------------------------
 * A third driver, built out of Node's own SQLite.
 *
 * It is deliberately written here rather than under `src/api/local/`: it is not
 * part of the app, it is the app's SQL run on an engine the test process can
 * load. It is also the only honest way to prove that the schema text, the
 * `$n`-less parameter binding and the upsert in the desktop driver are valid
 * SQL — a mock of SQLite could not tell you that a `CREATE TABLE` was malformed.
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
    const rows = this.db.prepare(`SELECT * FROM "${table}" WHERE "key" = ?`).all(key);
    return rows[0] ?? null;
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
 * The suite, run once per engine
 * ------------------------------------------------------------------------- */

async function suite(label, database) {
  console.log(`\n${label} (${database.engine})`);

  const store = new LocalStore(database);
  const backend = new LocalBackend(store, { deviceName: "This laptop" });
  const say = (name) => `${label}: ${name}`;

  /* Subscriptions ---------------------------------------------------------- */

  await backend.subscribe({ feedUrl: FEED_A, title: "A feed", category: "Comics" });
  await backend.subscribe({ feedUrl: FEED_B, category: "News" });

  const subscriptions = await backend.subscriptions();
  await check(say("a subscription is a feed/<url> stream with one label"), () => {
    const feed = subscriptions.find((entry) => entry.url === FEED_A);
    if (feed === undefined) throw new Error(JSON.stringify(subscriptions));
    if (feed.id !== `feed/${FEED_A}`) throw new Error(feed.id);
    if (feed.title !== "A feed") throw new Error(feed.title);
    if (feed.categories.length !== 1) throw new Error(JSON.stringify(feed.categories));
    if (feed.categories[0].id !== "user/-/label/Comics") throw new Error(feed.categories[0].id);
    if (feed.categories[0].label !== "Comics") throw new Error(feed.categories[0].label);
  });

  await check(say("a feed subscribed without a title is named after its host"), () => {
    const feed = subscriptions.find((entry) => entry.url === FEED_B);
    if (feed.title !== "b.test") throw new Error(feed.title);
  });

  await check(say("a folder subscribed into becomes a label tag"), async () => {
    const tags = await backend.tags();
    const ids = tags.map((tag) => tag.id).sort();
    if (ids.join(",") !== "user/-/label/Comics,user/-/label/News") throw new Error(ids.join(","));
    if (tags[0].type !== "folder") throw new Error(String(tags[0].type));
  });

  const twice = await refused(() => backend.subscribe({ feedUrl: FEED_A }));
  await check(say("subscribing to the same feed twice is refused"), () => {
    if (!(twice instanceof LocalStorageError)) throw new Error(String(twice));
    if (!/already subscribed/.test(twice.message)) throw new Error(twice.message);
  });

  const notAUrl = await refused(() => backend.subscribe({ feedUrl: "a.test/rss" }));
  await check(say("a feed address that is not a web address is refused"), () => {
    if (!(notAUrl instanceof LocalStorageError)) throw new Error(String(notAUrl));
  });

  const profile = await backend.profile();
  await check(say("the profile says it is a local account, not a server's"), () => {
    if (profile.userId !== "local") throw new Error(profile.userId);
    if (profile.userName !== "This laptop") throw new Error(profile.userName);
    if (profile.userEmail !== "") throw new Error(profile.userEmail);
  });

  await check(say("the backend announces itself as local"), () => {
    if (backend.kind !== "local") throw new Error(backend.kind);
  });

  /* Entries ---------------------------------------------------------------- */

  await store.putEntries([
    { feedUrl: FEED_A, guid: "a1", title: "A one", published: T + 10, link: "https://a.test/1" },
    { feedUrl: FEED_A, guid: "a2", title: "A two", published: T + 20 },
    { feedUrl: FEED_A, guid: "a3", title: "A three", published: T + 30 },
    { feedUrl: FEED_B, guid: "b1", title: "B one", published: T + 40 },
    { feedUrl: FEED_B, guid: "b2", title: "B two", published: T + 5 },
  ]);

  const list = await backend.stream(READING_LIST, { count: 10 });
  await check(say("the reading list is newest first, across feeds"), () => {
    const titles = list.items.map((item) => item.title).join(",");
    if (titles !== "B one,A three,A two,A one,B two") throw new Error(titles);
  });

  await check(say("an item carries its id, its timestamp and the feed it came from"), () => {
    const item = list.items[0];
    if (item.id !== localItemId(FEED_B, "b1")) throw new Error(item.id);
    if (item.published !== T + 40) throw new Error(String(item.published));
    if (item.timestampUsec !== `${T + 40}000000`) throw new Error(String(item.timestampUsec));
    if (item.origin.streamId !== `feed/${FEED_B}`) throw new Error(item.origin.streamId);
    if (item.origin.title !== "b.test") throw new Error(String(item.origin.title));
    if (item.categories.length !== 0) throw new Error(JSON.stringify(item.categories));
    // Nothing was stored for a body or a summary, so nothing is claimed.
    if (item.content !== undefined) throw new Error("invented a body");
    if (item.summary !== undefined) throw new Error("invented a summary");
  });

  await check(say("a stored link is offered as both alternate and canonical"), () => {
    const item = list.items.find((entry) => entry.title === "A one");
    if (item.alternate[0].href !== "https://a.test/1") throw new Error(JSON.stringify(item));
    if (item.canonical[0].href !== "https://a.test/1") throw new Error(JSON.stringify(item));
  });

  await check(say("the stream reports its own id"), () => {
    if (list.id !== READING_LIST) throw new Error(list.id);
  });

  const firstPage = await backend.stream(READING_LIST, { count: 2 });
  const secondPage = await backend.stream(READING_LIST, {
    count: 2,
    continuation: firstPage.continuation,
  });
  const thirdPage = await backend.stream(READING_LIST, {
    count: 2,
    continuation: secondPage.continuation,
  });
  await check(say("pages continue without gaps or repeats, and the last one stops"), () => {
    const ids = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
      (item) => item.id,
    );
    if (ids.length !== 5) throw new Error(`${ids.length} items over three pages`);
    if (new Set(ids).size !== 5) throw new Error("a page repeated an item");
    if (ids[0] !== localItemId(FEED_B, "b1")) throw new Error("pages are not newest first");
    if (thirdPage.continuation !== undefined) throw new Error("the last page offered more");
    if (firstPage.continuation === undefined) throw new Error("the first page offered no more");
  });

  const feedStream = await backend.stream(`feed/${FEED_A}`);
  await check(say("a feed's stream holds only its own articles"), () => {
    if (feedStream.items.length !== 3) throw new Error(String(feedStream.items.length));
    if (feedStream.items.some((item) => item.origin.streamId !== `feed/${FEED_A}`)) {
      throw new Error(JSON.stringify(feedStream.items.map((item) => item.origin)));
    }
  });

  const labelStream = await backend.stream("user/-/label/Comics");
  await check(say("a label's stream is the articles of the feeds in it"), () => {
    if (labelStream.items.length !== 3) throw new Error(String(labelStream.items.length));
    if (labelStream.items[0].title !== "A three") throw new Error(labelStream.items[0].title);
  });

  const noFeed = await refused(() => backend.stream("feed/https://c.test/rss"));
  await check(say("a feed that is not subscribed has no stream here"), () => {
    if (!(noFeed instanceof LocalStorageError)) throw new Error(String(noFeed));
    if (!/not subscribed/.test(noFeed.message)) throw new Error(noFeed.message);
  });

  const noLabel = await refused(() => backend.stream("user/-/label/Poetry"));
  await check(say("a label this device does not have is refused"), () => {
    if (!(noLabel instanceof LocalStorageError)) throw new Error(String(noLabel));
    if (!/no label called/.test(noLabel.message)) throw new Error(noLabel.message);
  });

  const unknownStream = await refused(() =>
    backend.stream("user/-/state/com.google/broadcast"),
  );
  await check(say("a stream id local mode does not serve is refused, not emptied"), () => {
    if (!(unknownStream instanceof LocalStorageError)) throw new Error(String(unknownStream));
    if (!/no stream called/.test(unknownStream.message)) throw new Error(unknownStream.message);
  });

  const junkCursor = await refused(() =>
    backend.stream(READING_LIST, { continuation: "not-a-cursor" }),
  );
  await check(say("a continuation this build cannot read is refused"), () => {
    if (!(junkCursor instanceof LocalStorageError)) throw new Error(String(junkCursor));
    if (!/place marker/.test(junkCursor.message)) throw new Error(junkCursor.message);
  });

  const emptyPage = await refused(() => backend.stream(READING_LIST, { count: 0 }));
  await check(say("a page of zero articles is refused"), () => {
    if (!(emptyPage instanceof LocalStorageError)) throw new Error(String(emptyPage));
  });

  /* Flags ------------------------------------------------------------------ */

  const itemA2 = localItemId(FEED_A, "a2");
  const storedBefore = await store.entry(itemA2);
  await backend.setRead([itemA2], true);
  await backend.setStarred([itemA2], true);

  const starred = await backend.stream(STATE_STARRED);
  await check(say("starring is a flag on the item and a stream of its own"), () => {
    if (starred.items.length !== 1) throw new Error(String(starred.items.length));
    if (starred.items[0].id !== itemA2) throw new Error(starred.items[0].id);
    if (!isStarred(starred.items[0])) throw new Error("not starred");
    if (!isRead(starred.items[0])) throw new Error("starring lost the read mark");
  });

  const unreadList = await backend.stream(READING_LIST, { count: 10, excludeRead: true });
  await check(say("excludeRead hides what is already read"), () => {
    if (unreadList.items.length !== 4) throw new Error(String(unreadList.items.length));
    if (unreadList.items.some((item) => item.id === itemA2)) throw new Error("showed a read item");
  });

  const readStream = await backend.stream(STATE_READ);
  await check(say("the read stream holds exactly what is read"), () => {
    if (readStream.items.length !== 1) throw new Error(String(readStream.items.length));
    if (readStream.items[0].id !== itemA2) throw new Error(readStream.items[0].id);
  });

  const unknownMark = await refused(() => backend.setRead(["local/nowhere/x"], true));
  await check(say("a mark for an article that is not stored is refused, not dropped"), () => {
    if (!(unknownMark instanceof LocalStorageError)) throw new Error(String(unknownMark));
    if (!/is stored on this device/.test(unknownMark.message)) throw new Error(unknownMark.message);
  });

  const itemA3 = localItemId(FEED_A, "a3");
  const halfBatch = await refused(() => backend.setStarred([itemA3, "local/nowhere/y"], true));
  await check(say("a batch with one unknown id writes nothing at all"), async () => {
    if (!(halfBatch instanceof LocalStorageError)) throw new Error(String(halfBatch));
    const row = await store.entry(itemA3);
    if (row.starred !== 0) throw new Error("starred half a batch");
  });

  await store.putEntries([
    { feedUrl: FEED_A, guid: "a2", title: "A two, corrected", published: T + 20 },
    { feedUrl: FEED_A, guid: "a2", title: "A two", published: T + 20 },
  ]);
  const reingested = await store.entry(itemA2);
  await check(say("re-ingesting a post keeps its marks and the day it arrived"), () => {
    if (reingested.read !== 1) throw new Error("lost the read mark");
    if (reingested.starred !== 1) throw new Error("lost the starred mark");
    if (reingested.stored_at !== storedBefore.stored_at) throw new Error("moved stored_at");
    if (reingested.title !== "A two") throw new Error(String(reingested.title));
  });

  const before = (await backend.stream(READING_LIST, { count: 10 })).items.map((item) => item.id);
  await check(say("a repeated ingest stores the post once"), () => {
    if (new Set(before).size !== before.length) throw new Error("duplicated an article");
    if (before.length !== 5) throw new Error(`${before.length} articles`);
  });

  /* Counts ----------------------------------------------------------------- */

  const counts = await backend.unreadCounts();
  await check(say("counts are per feed, per label and for the reading list"), () => {
    const byId = new Map(counts.map((row) => [row.id, row.count]));
    if (byId.get(`feed/${FEED_A}`) !== 2) throw new Error(String(byId.get(`feed/${FEED_A}`)));
    if (byId.get(`feed/${FEED_B}`) !== 2) throw new Error(String(byId.get(`feed/${FEED_B}`)));
    if (byId.get("user/-/label/Comics") !== 2) throw new Error("label count");
    if (byId.get("user/-/label/News") !== 2) throw new Error("label count");
    if (byId.get(READING_LIST) !== 4) throw new Error(String(byId.get(READING_LIST)));
  });

  await check(say("a count says when the feed was last added to"), () => {
    const row = counts.find((entry) => entry.id === `feed/${FEED_A}`);
    if (row.newestItemTimestampUsec !== `${T + 30}000000`) {
      throw new Error(String(row.newestItemTimestampUsec));
    }
  });

  /* Extraction ------------------------------------------------------------- */

  await store.saveExtraction({ itemId: itemA2, html: "<p>The whole article.</p>" });
  const extracted = await store.extraction(itemA2);
  await check(say("an extraction keeps the body, the time and that it worked"), () => {
    if (extracted === null) throw new Error("nothing stored");
    if (extracted.status !== "ok") throw new Error(extracted.status);
    if (extracted.html !== "<p>The whole article.</p>") throw new Error(String(extracted.html));
    if (extracted.error !== null) throw new Error(String(extracted.error));
    if (typeof extracted.extracted_at !== "number") throw new Error("no time");
  });

  await store.recordExtractionFailure(itemA3, "the page answered 403");
  const failed = await store.extraction(itemA3);
  await check(say("a failed extraction is remembered, with its reason"), () => {
    if (failed === null) throw new Error("nothing stored");
    if (failed.status !== "failed") throw new Error(failed.status);
    if (failed.html !== null) throw new Error(String(failed.html));
    if (failed.error !== "the page answered 403") throw new Error(String(failed.error));
  });

  const emptyExtraction = await refused(() =>
    store.saveExtraction({ itemId: itemA3, html: null }),
  );
  await check(say("an extraction with neither a body nor a reason is refused"), () => {
    if (!(emptyExtraction instanceof LocalStorageError)) throw new Error(String(emptyExtraction));
  });

  /* Reading position ------------------------------------------------------- */

  await store.savePosition(READING_LIST, { itemId: itemA2, offset: 0.4 });
  const position = await store.position(READING_LIST);
  await check(say("the reading position is kept per stream"), () => {
    if (position === null) throw new Error("nothing stored");
    if (position.itemId !== itemA2) throw new Error(position.itemId);
    if (position.offset !== 0.4) throw new Error(String(position.offset));
  });

  await store.savePosition(READING_LIST, { itemId: itemA2, offset: 4.2 });
  await check(say("a scroll past the end is clamped rather than lost"), async () => {
    const clamped = await store.position(READING_LIST);
    if (clamped.offset !== 1) throw new Error(String(clamped.offset));
  });

  const nonNumber = await refused(() =>
    store.savePosition(READING_LIST, { itemId: itemA2, offset: Number.NaN }),
  );
  await check(say("a position that is not a number is refused"), () => {
    if (!(nonNumber instanceof LocalStorageError)) throw new Error(String(nonNumber));
  });

  const neverOpened = await store.position(`feed/${FEED_B}`);
  await check(say("a stream never opened has no position"), () => {
    if (neverOpened !== null) throw new Error(JSON.stringify(neverOpened));
  });

  /* Folders ---------------------------------------------------------------- */

  await backend.moveFeed({ streamId: `feed/${FEED_A}`, to: "News", from: "Comics" });
  const moved = (await backend.subscriptions()).find((feed) => feed.url === FEED_A);
  await check(say("a move files the feed under the new label"), () => {
    if (moved.categories[0].label !== "News") throw new Error(JSON.stringify(moved.categories));
  });

  const staleMove = await refused(() =>
    backend.moveFeed({ streamId: `feed/${FEED_A}`, to: "Comics", from: "Comics" }),
  );
  await check(say("a move from a folder the feed is not in is refused"), () => {
    if (!(staleMove instanceof LocalStorageError)) throw new Error(String(staleMove));
    if (!/is in "News", not "Comics"/.test(staleMove.message)) throw new Error(staleMove.message);
  });

  const emptyLabel = await backend.stream("user/-/label/Comics");
  await check(say("a label with no feeds left is an empty page, not a missing stream"), () => {
    if (emptyLabel.items.length !== 0) throw new Error(String(emptyLabel.items.length));
  });

  const tagsAfterMove = (await backend.tags()).map((tag) => tag.id).sort();
  await check(say("an emptied folder is still a folder"), () => {
    if (tagsAfterMove.join(",") !== "user/-/label/Comics,user/-/label/News") {
      throw new Error(tagsAfterMove.join(","));
    }
  });

  /* Abort ------------------------------------------------------------------ */

  const aborter = new AbortController();
  aborter.abort();
  const aborted = await refused(() =>
    backend.stream(READING_LIST, { signal: aborter.signal }),
  );
  await check(say("a cancelled read reports itself as AbortError"), () => {
    if (aborted?.name !== "AbortError") throw new Error(String(aborted));
  });

  /* Unsubscribe ------------------------------------------------------------ */

  await store.savePosition(`feed/${FEED_A}`, { itemId: itemA2, offset: 0.5 });
  await backend.unsubscribe(`feed/${FEED_A}`);

  await check(say("unsubscribing leaves the feed out of the list"), async () => {
    const left = await backend.subscriptions();
    if (left.length !== 1) throw new Error(String(left.length));
    if (left[0].url !== FEED_B) throw new Error(left[0].url);
  });

  await check(say("…and its articles leave the reading list"), async () => {
    const left = await backend.stream(READING_LIST, { count: 10 });
    if (left.items.length !== 2) throw new Error(String(left.items.length));
    if (left.items.some((item) => item.origin.streamId === `feed/${FEED_A}`)) {
      throw new Error("an article outlived its feed");
    }
  });

  await check(say("…and its extraction goes with it"), async () => {
    if ((await store.extraction(itemA2)) !== null) throw new Error("an extraction outlived its feed");
  });

  await check(say("…and a position remembered for it goes too"), async () => {
    if ((await store.position(`feed/${FEED_A}`)) !== null) throw new Error("a position outlived it");
  });

  const itsStream = await refused(() => backend.stream(`feed/${FEED_A}`));
  await check(say("…and its stream is refused rather than answered empty"), () => {
    if (!(itsStream instanceof LocalStorageError)) throw new Error(String(itsStream));
    if (!/not subscribed/.test(itsStream.message)) throw new Error(itsStream.message);
  });

  const labelRemoval = await refused(() => backend.unsubscribe(READING_LIST));
  await check(say("only a feed is a subscription to remove"), () => {
    if (!(labelRemoval instanceof LocalStorageError)) throw new Error(String(labelRemoval));
    if (!/only a feed is a subscription/.test(labelRemoval.message)) {
      throw new Error(labelRemoval.message);
    }
  });

  const strayArticle = await refused(() =>
    store.putEntries([{ feedUrl: "https://c.test/rss", guid: "c1" }]),
  );
  await check(say("an article cannot arrive from a feed that is not subscribed"), () => {
    if (!(strayArticle instanceof LocalStorageError)) throw new Error(String(strayArticle));
    if (!/not subscribed/.test(strayArticle.message)) throw new Error(strayArticle.message);
  });

  const nobody = await refused(() => backend.unsubscribe(`feed/https://c.test/rss`));
  await check(say("unsubscribing from a feed that is not here is refused"), () => {
    if (!(nobody instanceof LocalStorageError)) throw new Error(String(nobody));
  });

  // A folder the reader already has must not be rewritten when a feed is filed
  // into it: `created_at` is its place in the sidebar's order.
  await database.write([
    { type: "put", table: "folders", row: { key: "Archive", created_at: 1 } },
  ]);
  await backend.subscribe({ feedUrl: "https://d.test/rss", title: "D feed", category: "Archive" });

  const archive = (await store.folders()).find((folder) => folder.key === "Archive");
  await check(say("filing a feed into an existing folder leaves the folder as it was"), () => {
    if (archive === undefined) throw new Error("the folder went missing");
    if (archive.created_at !== 1) throw new Error(String(archive.created_at));
  });

  const filed = (await backend.subscriptions()).find((feed) => feed.url === "https://d.test/rss");
  await check(say("…and the feed is in it"), () => {
    if (filed.categories[0]?.label !== "Archive") throw new Error(JSON.stringify(filed));
  });

  await backend.setRead([], true);
  await backend.setStarred([], false);
  await check(say("an empty batch costs nothing and fails at nothing"), () => true);

  await store.close();
}

await suite("memory", new MemoryDatabase());

let sqlite = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new NodeSqliteDatabase(new DatabaseSync(":memory:"));
} catch {
  console.log("\nsqlite (skipped: this Node has no node:sqlite)");
}
if (sqlite !== null) await suite("sqlite", sqlite);

console.log(`\n${passed} checks passed`);
