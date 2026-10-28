/**
 * The thin thing a database has to be.
 *
 * Node cannot load the Tauri SQL plugin — it is an IPC call into a Rust process
 * that is not there — so anything written against `@tauri-apps/plugin-sql`
 * directly could only ever be tested by launching the app. This interface is
 * the way out: it is small enough to implement three times (SQLite, IndexedDB,
 * and an in-memory store for the tests) and identical in meaning each time, so
 * the query logic above it is exercised under plain Node against a real
 * database rather than against a mock of one.
 *
 * The shape is deliberately the least common denominator of the two engines the
 * app actually ships: a table of rows keyed by one string. IndexedDB is exactly
 * that; SQLite is far more, but is used here as exactly that. Pushing filtering
 * down into SQL is the obvious next optimisation, and it can be made inside
 * each driver without the layer above noticing, which is the point of a seam.
 *
 * Reads are answered in full and writes are batched: a whole page of new
 * articles arrives as one transaction, because a half-ingested feed is a
 * library that shows the same post twice with different flags.
 */
import type { LocalEngine, LocalRow, TableName } from "./schema";

/**
 * A failure of the local store, as opposed to a failure of the network.
 *
 * Callers in the app already distinguish "the server said no" (`AuthError`,
 * `HttpError`); this is the local mode's equivalent, and its message is written
 * to be shown: it says what was asked for and why this device cannot do it.
 */
export class LocalStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStorageError";
  }
}

export type WriteOperation =
  | { type: "put"; table: TableName; row: LocalRow }
  | { type: "delete"; table: TableName; key: string };

export interface LocalDatabase {
  /** Which engine this is. Shown to the reader; never used to branch queries. */
  readonly engine: LocalEngine;

  /** Every row of one table. Order is the engine's business, not a promise. */
  all<T extends LocalRow>(table: TableName): Promise<T[]>;

  get<T extends LocalRow>(table: TableName, key: string): Promise<T | null>;

  /** Several keys at once — a page of items and a batch of read marks. */
  getMany<T extends LocalRow>(table: TableName, keys: readonly string[]): Promise<T[]>;

  /** Applies every operation or, where the engine can, none of them. */
  write(operations: readonly WriteOperation[]): Promise<void>;

  close(): Promise<void>;
}
