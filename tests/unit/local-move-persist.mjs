/**
 * A category move on a local library, seen across a restart.
 *
 * `local-backend.mjs` proves that a move files a feed under its new label while
 * the store is open. That is not the same question as this one. A reader who
 * drags a feed into another folder and closes the app expects the feed to still
 * be there tomorrow, and expects the folder it landed in to list it — which is
 * a claim about two rows on disk (`feeds.folder`, and the `folders` row that
 * makes the label a label) and about how the label's stream is resolved after a
 * reopen, not about what is in memory when the drag finishes.
 *
 * So every check here is made on a *newly opened* store over the same data:
 *
 *   - the in-memory engine, reopened as a fresh view over the same database;
 *   - a real SQLite file, with the handle closed and reopened, which is the
 *     desktop engine's own path — the `CREATE TABLE` text, the binding and the
 *     upsert all go through `schema.ts`, exactly as the Tauri driver does.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-move-persist.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import {
  columnNames,
  columnValues,
  createTableSql,
  tableNames,
  TABLES,
} from "../../src/api/local/schema.ts";
import { READING_LIST } from "../../src/api/freshrss.ts";

const COMICS = "https://comics.test/rss";
const NEWS = "https://news.test/rss";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

async function refused(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

/**
 * The smallest driver over Node's own SQLite.
 *
 * Kept here rather than imported from `local-backend.mjs`, because that file
 * runs its whole suite on import and this suite needs a *file* it can close and
 * open again. The statements are the same ones, built from `schema.ts`.
 */
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

/** A store and the backend above it, over whatever database was handed in. */
function opened(database) {
  const store = new LocalStore(database);
  return { store, backend: new LocalBackend(store, { deviceName: "This laptop" }) };
}

const labelStream = (backend, label) => backend.stream(`user/-/label/${label}`, { count: 50 });
const feedOf = async (backend, url) => (await backend.subscriptions()).find((f) => f.url === url);

/**
 * One library's life: subscribe, drag, quit, come back.
 *
 * `open`/`close` are given by the caller because only it knows what a restart
 * means for its engine: a new handle on a file, with the old one released, or a
 * fresh view over a store that was never going to outlive the process anyway.
 */
async function scenario(label, library) {
  console.log(`\n${label}`);

  /* A library with two feeds in two folders, and articles in both. ------- */
  {
    const { store, backend } = await library.open();
    await backend.subscribe({ feedUrl: COMICS, title: "Comics feed", category: "Comics" });
    await backend.subscribe({ feedUrl: NEWS, title: "News feed", category: "News" });
    await store.putEntries([
      { feedUrl: COMICS, guid: "c1", title: "C one", published: 300 },
      { feedUrl: COMICS, guid: "c2", title: "C two", published: 200 },
      { feedUrl: NEWS, guid: "n1", title: "N one", published: 100 },
    ]);

    // The drag: Comics -> News, sent as the same `to`/`from` pair the sidebar's
    // arrangeFeed builds from the label it is in and the label it was dropped on.
    await backend.moveFeed({ streamId: `feed/${COMICS}`, to: "News", from: "Comics" });
    await library.close(store);
  }

  /* The restart. -------------------------------------------------------- */
  {
    const { store, backend } = await library.open();

    const moved = await feedOf(backend, COMICS);
    await check(`${label}: the moved feed is still in its new folder after a restart`, () => {
      if (moved === undefined) throw new Error("the feed went missing");
      const labels = moved.categories.map((entry) => entry.label);
      if (labels.join(",") !== "News") throw new Error(JSON.stringify(moved.categories));
    });

    const row = (await store.feeds()).find((feed) => feed.key === COMICS);
    await check(`${label}: …because the folder is a column on the feed's own row`, () => {
      if (row === undefined) throw new Error("no row");
      if (row.folder !== "News") throw new Error(String(row.folder));
    });

    const tags = (await backend.tags()).map((tag) => tag.id).sort();
    await check(`${label}: both folders are still there, the emptied one included`, () => {
      if (tags.join(",") !== "user/-/label/Comics,user/-/label/News") {
        throw new Error(tags.join(","));
      }
    });

    const inNews = await labelStream(backend, "News");
    await check(`${label}: the folder it landed in lists it — and the feed already there`, () => {
      const feeds = [...new Set(inNews.items.map((item) => item.origin.streamId))].sort();
      if (feeds.join(",") !== `feed/${COMICS},feed/${NEWS}`) throw new Error(feeds.join(","));
      if (inNews.items.length !== 3) throw new Error(String(inNews.items.length));
    });

    const inComics = await labelStream(backend, "Comics");
    await check(`${label}: the folder it left no longer lists it`, () => {
      if (inComics.items.length !== 0) throw new Error(String(inComics.items.length));
    });

    const counts = new Map((await backend.unreadCounts()).map((row) => [row.id, row.count]));
    await check(`${label}: the folders' unread counts follow the move`, () => {
      const news = counts.get("user/-/label/News");
      const comics = counts.get("user/-/label/Comics");
      if (news !== 3) throw new Error(String(news));
      if (comics !== 0) throw new Error(String(comics));
    });

    /* Dragged back out to Uncategorized, and back in. ------------------- */
    // Uncategorized is the absence of a label, not a label named that, so this
    // is the half of the drag that removes rather than adds.
    await backend.moveFeed({ streamId: `feed/${NEWS}`, to: null, from: "News" });
    await library.close(store);
  }

  {
    const { store, backend } = await library.open();

    const loose = await feedOf(backend, NEWS);
    await check(`${label}: a feed dragged to Uncategorized stays uncategorized`, () => {
      if (loose === undefined) throw new Error("the feed went missing");
      if (loose.categories.length !== 0) throw new Error(JSON.stringify(loose.categories));
    });

    const inNews = await labelStream(backend, "News");
    await check(
      `${label}: …and leaves the folder's list, without losing its articles`,
      () => {
        const feeds = [...new Set(inNews.items.map((item) => item.origin.streamId))];
        if (feeds.join(",") !== `feed/${COMICS}`) throw new Error(feeds.join(","));
      },
    );

    const list = await backend.stream(READING_LIST, { count: 50 });
    await check(`${label}: the reading list is unchanged by any of the moves`, () => {
      if (list.items.length !== 3) throw new Error(String(list.items.length));
    });

    // A drag out of Uncategorized names no folder to leave, so `from` is null —
    // and it lands on a folder nobody has made yet, which the move must create.
    await backend.moveFeed({ streamId: `feed/${NEWS}`, to: "Longform", from: null });
    await library.close(store);
  }

  {
    const { store, backend } = await library.open();
    const filed = await feedOf(backend, NEWS);
    await check(`${label}: a feed dragged out of Uncategorized lands in the folder`, () => {
      if (filed === undefined) throw new Error("the feed went missing");
      if (filed.categories.map((entry) => entry.label).join(",") !== "Longform") {
        throw new Error(JSON.stringify(filed.categories));
      }
    });

    const inLongform = await labelStream(backend, "Longform");
    await check(`${label}: …and that folder lists it`, () => {
      const feeds = [...new Set(inLongform.items.map((item) => item.origin.streamId))];
      if (feeds.join(",") !== `feed/${NEWS}`) throw new Error(feeds.join(","));
    });

    const invented = (await backend.tags()).map((tag) => tag.id);
    await check(`${label}: a folder invented by a drag is a folder after a restart`, () => {
      if (!invented.includes("user/-/label/Longform")) throw new Error(invented.join(","));
    });

    // A stale `from` is still refused after a restart, which is what stops a
    // second device's older view from undoing a move it never saw.
    const stale = await refused(() =>
      backend.moveFeed({ streamId: `feed/${NEWS}`, to: "News", from: "News" }),
    );
    await check(`${label}: a move from a folder it is not in is refused after a restart`, () => {
      if (stale === null) throw new Error("the move was accepted");
      if (!/is in "Longform", not "News"/.test(stale.message)) throw new Error(stale.message);
    });

    await library.close(store);
  }
}

/* ---------------------------------------------------------------------- */

const memory = new MemoryDatabase();
await scenario("memory, a fresh view over the same library", {
  open: async () => opened(memory),
  // Closing the memory engine clears it — durability is exactly what it does
  // not have — so the fresh view above is all a "restart" can mean here.
  close: async () => {},
});

let sqlite = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = DatabaseSync;
} catch {
  console.log("\nsqlite (skipped: this Node has no node:sqlite)");
}

if (sqlite !== null) {
  const dir = mkdtempSync(join(tmpdir(), "hardlyread-move-"));
  const file = join(dir, "library.sqlite");
  try {
    await scenario("sqlite file, closed and reopened", {
      open: async () => opened(new NodeSqliteDatabase(new sqlite(file))),
      close: async (store) => store.close(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} checks passed`);