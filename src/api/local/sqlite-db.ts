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
  sqlType,
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

/**
 * How the plugin is reached, given a file name.
 *
 * Injectable for one reason: the statements this driver writes are the ones the
 * desktop build runs, and the only way to run them without launching the app is
 * to hand the driver an engine that speaks the same three-method slice. The
 * default is the plugin; a test passes something else and the SQL under test is
 * still this file's.
 */
export type SqlConnector = (name: string) => Promise<SqlDatabase>;

/** The real one: the Tauri SQL plugin, resolved at open time. */
async function connectPlugin(name: string): Promise<SqlDatabase> {
  let Database: typeof import("@tauri-apps/plugin-sql").default;
  try {
    Database = (await import("@tauri-apps/plugin-sql")).default;
  } catch {
    throw new LocalStorageError(
      "The SQLite plugin is not available in this build, so the local library cannot be opened",
    );
  }
  return (await Database.load(`sqlite:${name}`)) as unknown as SqlDatabase;
}

/**
 * The two statements a migration needs, so it can be run by a test against an
 * engine other than the plugin.
 *
 * `ensureColumns` below is the only part of this file that touches a database
 * that already exists, which makes it the only part worth proving outside a
 * launched app: a fresh install creates its tables from `createTableSql` and
 * never notices, while an install from before a column existed is exactly the
 * case that would fail on first write with `no such column`.
 */
export interface SqlExecutor {
  execute(query: string, values?: unknown[]): Promise<unknown>;
  select<T>(query: string, values?: unknown[]): Promise<T>;
}

/**
 * Adds, to a table that already exists, every column the schema declares and
 * the table is missing.
 *
 * SQLite's `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that is
 * already there, so a new column is invisible to every database created before
 * it — and a `put` that names it fails at the first write rather than at the
 * first read, which is a library that stops accepting articles after an update.
 * `ALTER TABLE … ADD COLUMN` is the whole fix; a new column is always nullable
 * here, because a row written before it has no value to invent.
 *
 * Returns the columns it added, which is what the suite asserts on.
 */
export async function ensureColumns(db: SqlExecutor, table: TableName): Promise<string[]> {
  const rows = await db.select<{ name: string }[]>(
    `SELECT name FROM pragma_table_info('${table}')`,
  );
  const present = new Set(rows.map((row) => row.name));
  const added: string[] = [];
  for (const column of TABLES[table].columns) {
    if (present.has(column.name)) continue;
    await db.execute(
      `ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${sqlType(column.type)}`,
    );
    added.push(column.name);
  }
  return added;
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
   *
   * `connect` is the plugin by default; a test hands in its own engine so the
   * `CREATE TABLE`, migration and write statements below are the ones that run.
   */
  static async open(
    name: string = LOCAL_DATABASE_FILE,
    connect: SqlConnector = connectPlugin,
  ): Promise<SqliteDatabase> {
    const db = await connect(name);
    const opened = new SqliteDatabase(db);
    for (const table of tableNames()) {
      await db.execute(createTableSql(table));
      // A library created by an older version has the table but not every
      // column in it; the file is the reader's, so it is brought forward rather
      // than replaced.
      await ensureColumns(db, table);
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
