/**
 * Choosing a store, the way the rest of the app chooses a platform.
 *
 * The test is the same one `src/lib/platform.ts` uses for the opener and the
 * HTTP plugin — the internals object Tauri injects, absent in a browser — so
 * there is one definition of "this is the desktop app" and not a second one
 * that could disagree with it.
 *
 * The order is not arbitrary. A Tauri window can have IndexedDB and must still
 * get SQLite, because a library in the webview's origin storage is invisible to
 * the user, awkward to back up, and cleared by accident; a browser tab has no
 * choice. `memory` is the last resort for an environment with neither (a tab in
 * a private window that refuses storage) and is reported as such: it works, and
 * it forgets everything when the tab closes, which the caller should say out
 * loud rather than let the reader discover.
 */
import { isTauri } from "../../lib/platform";
import { LocalStorageError, type LocalDatabase } from "./driver";
import { IndexedDbDatabase, LOCAL_DATABASE_NAME } from "./indexeddb-db";
import { MemoryDatabase } from "./memory-db";
import { LOCAL_DATABASE_FILE, SqliteDatabase } from "./sqlite-db";
import type { LocalEngine } from "./schema";

export interface LocalDatabaseOptions {
  /** Forces an engine. Omit to take whatever this runtime offers. */
  engine?: LocalEngine;
  /** File name for SQLite, database name for IndexedDB. */
  name?: string;
}

/** Which engine this runtime would get if nothing were forced. */
export function preferredEngine(): LocalEngine {
  if (isTauri()) return "sqlite";
  if (typeof indexedDB !== "undefined") return "indexeddb";
  return "memory";
}

export async function openLocalDatabase(
  options: LocalDatabaseOptions = {},
): Promise<LocalDatabase> {
  const engine = options.engine ?? preferredEngine();

  switch (engine) {
    case "sqlite":
      return SqliteDatabase.open(options.name ?? LOCAL_DATABASE_FILE);
    case "indexeddb":
      return IndexedDbDatabase.open(options.name ?? LOCAL_DATABASE_NAME);
    case "memory":
      return new MemoryDatabase();
    default:
      throw new LocalStorageError(`There is no local store called "${String(engine)}"`);
  }
}
