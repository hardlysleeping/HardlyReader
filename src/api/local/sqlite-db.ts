/**
 * The desktop store: SQLite, through the Tauri SQL plugin.
 *
 * The plugin talks to a Rust process over IPC, so this driver is the only place
 * in the app that knows SQL at all. It is written against a three-method slice
 * of the plugin (`execute`, `select`, `close`) so that what it demands of the
 * plugin is visible in one interface rather than discovered by reading the
 * calls.
 *
 * Two details are not incidental:
 *
 * - **Placeholders are `$1`, `$2`, …** — the plugin uses sqlx, whose SQLite
 *   driver numbers its arguments. A `?` here looks fine and binds nothing.
 * - **Writes are serialised and wrapped in a transaction.** Two concurrent
 *   `write()` calls would otherwise interleave their `BEGIN`/`COMMIT` on the
 *   same pool, and a feed ingested halfway is a library that shows the same
 *   post twice with different flags. The queue is a promise chain, which is
 *   enough because the whole app is one thread.
 *
 * The schema is created on open from `createTableSql`, the same text the unit
 * suite runs against a real SQLite engine. Migrations are expected to grow
 * here as `ALTER TABLE` steps guarded by `PRAGMA user_version`; nothing needs
 * that yet, and `CREATE TABLE IF NOT EXISTS` is the correct first step.
 */
import {
  LocalStorageError,
  type LocalDatabase,
  type WriteOperation,
} from "./driver";
import {
  columnNames,
  columnValues,
  createTableSql,
  tableNames,
  TABLES,
  type LocalRow,
  type TableName,
} from "./schema";

/** The file inside the app's data directory. */
export const LOCAL_DATABASE_FILE = "hardlyreader.db";

/**
 * The slice of `@tauri-apps/plugin-sql` this driver uses.
 *
 * Declared rather than imported so the driver can be read on its own, and so
 * that the package remains a runtime import: a browser build must never pull it
 * into the bundle, which is why `open` imports it dynamically.
 */
interface SqlDatabase {
  execute(query: string, values?: unknown[]): Promise<unknown>;
  select<T>(query: string, values?: unknown[]): Promise<T>;
  close(): Promise<boolean>;
}

/** SQLite's default limit on bound parameters, with room left for the rest. */
const KEY_CHUNK = 400;

function quoted(columns: readonly string[]): string {
  return columns.map((column) => `"${column}"`).join(", ");
}

export class SqliteDatabase implements LocalDatabase {
  readonly engine = "sqlite" as const;

  private readonly db: SqlDatabase;

  /** Writes are chained here so no two transactions overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(db: SqlDatabase) {
    this.db = db;
  }

  /**
   * Opens (or creates) the library file and makes sure the tables exist.
   *
   * The plugin resolves `sqlite:hardlyreader.db` under the app's data
   * directory, which is where a library belongs: beside the account's own
   * preferences, not in a temporary folder the OS may clear.
   */
  static async open(name: string = LOCAL_DATABASE_FILE): Promise<SqliteDatabase> {
    let Database: typeof import("@tauri-apps/plugin-sql").default;
    try {
      Database = (await import("@tauri-apps/plugin-sql")).default;
    } catch {
      throw new LocalStorageError(
        "The SQLite plugin is not available in this build, so the local library cannot be opened",
      );
    }

    const db = (await Database.load(`sqlite:${name}`)) as unknown as SqlDatabase;
    const opened = new SqliteDatabase(db);
    for (const table of tableNames()) {
      await db.execute(createTableSql(table));
    }
    return opened;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // A failed write must not poison the queue for every write after it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async all<T extends LocalRow>(table: TableName): Promise<T[]> {
    return this.db.select<T[]>(`SELECT * FROM "${table}"`);
  }

  async get<T extends LocalRow>(table: TableName, key: string): Promise<T | null> {
    const rows = await this.db.select<T[]>(`SELECT * FROM "${table}" WHERE "key" = $1`, [key]);
    return rows[0] ?? null;
  }

  async getMany<T extends LocalRow>(table: TableName, keys: readonly string[]): Promise<T[]> {
    const rows: T[] = [];
    // SQLite takes a bounded number of parameters per statement; a page of a
    // long stream can exceed it, so the keys go in batches.
    for (let start = 0; start < keys.length; start += KEY_CHUNK) {
      const chunk = keys.slice(start, start + KEY_CHUNK);
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
      const found = await this.db.select<T[]>(
        `SELECT * FROM "${table}" WHERE "key" IN (${placeholders})`,
        chunk,
      );
      rows.push(...found);
    }
    return rows;
  }

  async write(operations: readonly WriteOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.serial(async () => {
      await this.db.execute("BEGIN");
      try {
        for (const operation of operations) {
          if (operation.type === "put") {
            await this.put(operation.table, operation.row);
          } else {
            await this.db.execute(`DELETE FROM "${operation.table}" WHERE "key" = $1`, [
              operation.key,
            ]);
          }
        }
        await this.db.execute("COMMIT");
      } catch (error) {
        // A transaction left open would hold a write lock on the file for the
        // rest of the run, so rolling back is not optional even on the way out.
        await this.db.execute("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * An upsert, spelled as one statement so a re-ingested post cannot lose the
   * read mark between a `SELECT` and an `INSERT` even in principle.
   */
  private async put(table: TableName, row: LocalRow): Promise<void> {
    const columns = columnNames(table);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const updates = TABLES[table].columns
      .map((column) => `"${column.name}" = excluded."${column.name}"`)
      .join(", ");
    await this.db.execute(
      `INSERT INTO "${table}" (${quoted(columns)}) VALUES (${placeholders}) ` +
        `ON CONFLICT("key") DO UPDATE SET ${updates}`,
      [row.key, ...columnValues(table, row)],
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
