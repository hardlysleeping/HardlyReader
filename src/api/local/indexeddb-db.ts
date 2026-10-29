/**
 * The browser store: IndexedDB.
 *
 * A tab cannot open a file, so the library there is a database of the browser's
 * own. The mapping is almost embarrassingly direct — one object store per table,
 * key path `"key"`, the store name being the table name — which is the whole
 * reason `LocalDatabase` is a table-of-rows interface rather than a SQL one: the
 * queries written against it in `store.ts` are the same queries the desktop
 * build runs, so the two builds cannot drift into showing different lists.
 *
 * IndexedDB is asynchronous by design (every call is a request that fires an
 * event), so each request is wrapped in a promise here and the rest of the app
 * is spared the translation. A read-write transaction commits when the last
 * request in it finishes, which is why `write` waits on the transaction rather
 * than on the puts: resolving early would let a caller read a page it had just
 * written and not find it.
 */
import {
  LocalStorageError,
  type LocalDatabase,
  type WriteOperation,
} from "./driver";
import { tableNames, type LocalRow, type TableName } from "./schema";

/** The database inside the browser's origin storage. */
export const LOCAL_DATABASE_NAME = "hardlyreader-local";

/**
 * Schema version. A future column means a version bump and a copy step here.
 *
 * 2 added the picture cache's two tables (`images`, `image_data`). A browser
 * library that already exists upgrades in place: `onupgradeneeded` creates the
 * stores that are missing and touches nothing that is there, so the reader's
 * feeds, posts and marks are the same rows afterwards.
 */
const SCHEMA_VERSION = 2;

function failure(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new LocalStorageError("IndexedDB refused the request");
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error));
  });
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(failure(transaction.error));
    transaction.onabort = () => reject(failure(transaction.error));
  });
}

export class IndexedDbDatabase implements LocalDatabase {
  readonly engine = "indexeddb" as const;

  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(name: string = LOCAL_DATABASE_NAME): Promise<IndexedDbDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new LocalStorageError(
        "This browser does not offer IndexedDB, so the local library cannot be opened",
      );
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        // Every table that does not exist yet is created. Opening a version
        // that already has them all is the ordinary case and does nothing.
        const database = request.result;
        for (const table of tableNames()) {
          if (!database.objectStoreNames.contains(table)) {
            database.createObjectStore(table, { keyPath: "key" });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(failure(request.error));
      request.onblocked = () =>
        reject(
          new LocalStorageError(
            "Another HardlyReader tab is holding an old copy of the local library open",
          ),
        );
    });

    return new IndexedDbDatabase(db);
  }

  async all<T extends LocalRow>(table: TableName): Promise<T[]> {
    const store = this.db.transaction(table, "readonly").objectStore(table);
    return requested(store.getAll()) as Promise<T[]>;
  }

  async get<T extends LocalRow>(table: TableName, key: string): Promise<T | null> {
    const store = this.db.transaction(table, "readonly").objectStore(table);
    const row = (await requested(store.get(key))) as T | undefined;
    return row ?? null;
  }

  async getMany<T extends LocalRow>(table: TableName, keys: readonly string[]): Promise<T[]> {
    if (keys.length === 0) return [];
    const store = this.db.transaction(table, "readonly").objectStore(table);
    // One transaction for the whole batch: a page of items and its read marks
    // are read from one consistent view, not twenty separate ones.
    const rows = await Promise.all(keys.map((key) => requested(store.get(key))));
    return rows.filter((row): row is T => row !== undefined) as T[];
  }

  async write(operations: readonly WriteOperation[]): Promise<void> {
    if (operations.length === 0) return;

    const tables = [...new Set(operations.map((operation) => operation.table))];
    const transaction = this.db.transaction(tables, "readwrite");

    for (const operation of operations) {
      const store = transaction.objectStore(operation.table);
      if (operation.type === "put") {
        if (typeof operation.row.key !== "string" || operation.row.key === "") {
          transaction.abort();
          throw new LocalStorageError(`A row in "${operation.table}" was written without a key`);
        }
        store.put(operation.row);
      } else {
        store.delete(operation.key);
      }
    }

    await settled(transaction);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
