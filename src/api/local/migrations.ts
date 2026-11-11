/**
 * Bringing a library forward, and refusing to take it backwards.
 *
 * A library is the reader's, and it outlives every build of the app that opens
 * it. Three things therefore have to be true of opening one, and none of them
 * were true while the tables were simply re-`CREATE`d on every launch:
 *
 * 1. **A file from before a column existed is brought forward, not replaced.**
 *    `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that is
 *    already there, so a column added in a later build is invisible to every
 *    library created before it — and the failure does not appear on read, it
 *    appears on the first write that names the column. `ensureColumns` is that
 *    fix, per table, and here is where it runs.
 *
 * 2. **The file says what shape it is in.** `PRAGMA user_version` is SQLite's
 *    own one-integer slot, and this module owns it: it is the schema version,
 *    written once the shapes above are guaranteed. Without it there is no way
 *    to ask a file which build last wrote it, and no place to hang a step that
 *    is not "add a column" — a backfill, a table rebuilt to change a type, a
 *    repair of rows written by a bug.
 *
 * 3. **A newer file is refused rather than downgraded.** The builds are not one
 *    program: a stable release, a QA build and a demo sit on one machine and
 *    can be pointed at the same library. An older build opening a newer file
 *    would happily add nothing, read the columns it knows, and then write rows
 *    whose new columns are null — a silent downgrade that looks like data going
 *    missing. So a version above this build's is an error with a sentence the
 *    reader can act on, not a shrug.
 *
 * There is no migration step yet, and that is not a placeholder: the first one
 * costs a line in `MIGRATIONS` because the runner, the version and the guard it
 * needs are already here. Version 1 is the schema as it stands.
 */
import { LocalStorageError } from "./driver";
import { TABLES, createTableSql, sqlType, tableNames, type TableName } from "./schema";

/**
 * The two statements a migration needs.
 *
 * The Tauri SQL plugin's slice, narrowed to what this file asks for, so a test
 * can run the real statements against a real SQLite engine without a launched
 * app — the same reason `SqliteDatabase` takes a connector.
 */
export interface SqlExecutor {
  execute(query: string, values?: unknown[]): Promise<unknown>;
  select<T>(query: string, values?: unknown[]): Promise<T>;
}

/**
 * The shape of a library this build understands.
 *
 * Bumped when `schema.ts` changes in a way a file cannot absorb on its own —
 * adding a column does not need it (that is `ensureColumns`, which heals any
 * file whatever its version), while dropping one, renaming one, changing a type
 * or rewriting rows does. Raise this and add a step to `MIGRATIONS` in the same
 * change.
 */
export const SCHEMA_VERSION = 1;

/** One step, run once, on a library older than the version it produces. */
export interface Migration {
  /** The version this step brings the file to. Steps run in this order. */
  version: number;
  /** Named so a report can say what ran, and a failure can say which step. */
  name: string;
  up(db: SqlExecutor): Promise<void>;
}

/**
 * The steps, in order.
 *
 * Empty on purpose. Every migration so far has been a column, and columns heal
 * themselves from `TABLES` — writing a step to add one would be a second
 * declaration of the same column, and the two would drift.
 */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrationOptions {
  /** The steps to run. Overridden by a suite that needs to prove a step runs. */
  migrations?: readonly Migration[];
  /** The version to bring the file to. Overridden by the same suite. */
  target?: number;
}

/** What opening the library did to it, so the caller can say so if it matters. */
export interface MigrationReport {
  /** The version the file was at before. 0 means it had never been stamped. */
  from: number;
  /** The version it is at now. */
  to: number;
  /** Names of the steps that ran, in order. Empty on an up-to-date library. */
  ran: readonly string[];
  /** Tables that were missing columns, and which ones were added. */
  added: readonly { table: TableName; columns: readonly string[] }[];
}

/** Adds, to a table that already exists, every column the schema declares and the table is missing. */
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

/**
 * The version the file says it is.
 *
 * A file that has never been stamped answers 0, which is also every library
 * written before this module existed — so 0 is read as "unknown shape" and is
 * treated as the oldest possible one rather than as an error.
 */
export async function readVersion(db: SqlExecutor): Promise<number> {
  const rows = await db.select<Record<string, unknown>[]>("PRAGMA user_version");
  const first = rows[0];
  if (!first) return 0;
  const value = Object.values(first)[0];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Records the version.
 *
 * Interpolated because SQLite takes no bound parameter here, so the number is
 * checked to be a non-negative integer first: this is the one place in the
 * directory where a value reaches a statement as text.
 */
export async function writeVersion(db: SqlExecutor, version: number): Promise<void> {
  if (!Number.isInteger(version) || version < 0) {
    throw new LocalStorageError(`"${String(version)}" is not a schema version`);
  }
  await db.execute(`PRAGMA user_version = ${version}`);
}

/**
 * Makes sure every table exists, heals the ones that are behind, runs the steps
 * this file needs, and records the result.
 *
 * The order is deliberate. Tables first, because a step is allowed to assume
 * the tables exist and only needs to move data. Columns second, because a step
 * should never have to know which columns a particular file happens to have —
 * it runs against the shape this build declares. Steps third, and the stamp
 * last, so a file is never recorded as current unless everything that makes it
 * current has run: an interrupted open repeats the work rather than skipping
 * it, which is the only choice that is safe twice.
 */
export async function migrate(
  db: SqlExecutor,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const target = options.target ?? SCHEMA_VERSION;
  const steps = options.migrations ?? MIGRATIONS;
  const from = await readVersion(db);

  if (from > target) {
    throw new LocalStorageError(
      `This library was written by a newer HardlyReader (schema ${from}, this build reads ${target}). ` +
        "Open it with that build, or with a build at least as new, so nothing written here is lost.",
    );
  }

  for (const table of tableNames()) {
    await db.execute(createTableSql(table));
  }

  const added: { table: TableName; columns: string[] }[] = [];
  for (const table of tableNames()) {
    const columns = await ensureColumns(db, table);
    if (columns.length > 0) added.push({ table, columns });
  }

  const ran: string[] = [];
  const ordered = [...steps].sort((one, other) => one.version - other.version);
  for (const step of ordered) {
    if (step.version <= from || step.version > target) continue;
    await step.up(db);
    ran.push(step.name);
  }

  if (from !== target) await writeVersion(db, target);

  return { from, to: target, ran, added };
}
