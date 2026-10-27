/**
 * The store the tests run against, and the last resort at runtime.
 *
 * It is a real implementation of {@link LocalDatabase} rather than a mock: the
 * same calls the app makes go through the same query code above it, and only
 * the durability is missing. That is what makes the unit suite worth having —
 * a page assembled out of `store.ts` in a test is assembled by the same lines
 * that assemble it in the app.
 *
 * Rows are copied on the way in and on the way out, because SQLite returns a
 * fresh object every time and a test that accidentally shares one row between
 * two readers would pass here and fail in the app.
 */
import {
  LocalStorageError,
  type LocalDatabase,
  type WriteOperation,
} from "./driver";
import { tableNames, type LocalRow, type TableName } from "./schema";

export class MemoryDatabase implements LocalDatabase {
  readonly engine = "memory" as const;

  private readonly tables = new Map<TableName, Map<string, LocalRow>>();

  constructor() {
    for (const name of tableNames()) {
      this.tables.set(name, new Map<string, LocalRow>());
    }
  }

  private store(name: TableName): Map<string, LocalRow> {
    const table = this.tables.get(name);
    if (table === undefined) {
      // Unreachable while `TableName` is the set of declared tables; kept so a
      // future table added to the schema but not to the map fails loudly.
      throw new LocalStorageError(`The local store has no table called "${name}"`);
    }
    return table;
  }

  async all<T extends LocalRow>(table: TableName): Promise<T[]> {
    return [...this.store(table).values()].map((row) => ({ ...row }) as T);
  }

  async get<T extends LocalRow>(table: TableName, key: string): Promise<T | null> {
    const row = this.store(table).get(key);
    return row === undefined ? null : ({ ...row } as T);
  }

  async getMany<T extends LocalRow>(table: TableName, keys: readonly string[]): Promise<T[]> {
    const rows: T[] = [];
    for (const key of keys) {
      const row = this.store(table).get(key);
      if (row !== undefined) rows.push({ ...row } as T);
    }
    return rows;
  }

  async write(operations: readonly WriteOperation[]): Promise<void> {
    // Checked before anything is applied so a bad batch cannot leave half of
    // itself behind — the promise the SQLite and IndexedDB drivers keep with a
    // transaction, kept here by looking first.
    for (const operation of operations) {
      if (operation.type === "put" && (typeof operation.row.key !== "string" || operation.row.key === "")) {
        throw new LocalStorageError(`A row in "${operation.table}" was written without a key`);
      }
    }

    for (const operation of operations) {
      if (operation.type === "put") {
        this.store(operation.table).set(operation.row.key, { ...operation.row });
      } else {
        this.store(operation.table).delete(operation.key);
      }
    }
  }

  async close(): Promise<void> {
    for (const table of this.tables.values()) table.clear();
  }
}
