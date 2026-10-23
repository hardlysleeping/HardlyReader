/**
 * A small IndexedDB store that survives restarts.
 *
 * The in-memory stream cache is empty every time the app starts, so the first
 * click on every feed paid a full round-trip — 300-600 ms to a server over the
 * tailnet before FreshRSS does any work. This keeps the last sidebar snapshot
 * and the last page of every recently opened stream on disk, so the app paints
 * from disk first and refreshes from the network second.
 *
 * Every call is best effort. Where IndexedDB does not exist (unit tests, some
 * private modes) or fails, reads return undefined and writes do nothing: the app
 * simply behaves as it did before this cache existed.
 */

const DB_NAME = "hardlyreader-cache";
const DB_VERSION = 1;
const STORE = "entries";

/** Upper bound on stored streams; the oldest are evicted past this. */
const MAX_STREAMS = 60;

interface Entry<T> {
  key: string;
  value: T;
  at: number;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening !== null) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" }).createIndex("at", "at");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function settle<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

/** Keys are scoped to one account on one server, so two logins never mix. */
export function scopeKey(serverUrl: string, user: string, name: string): string {
  return `${serverUrl.replace(/\/+$/, "")}|${user}|${name}`;
}

export async function readCached<T>(key: string): Promise<{ value: T; at: number } | undefined> {
  const db = await open();
  if (db === null) return undefined;
  try {
    const entry = await settle<Entry<T> | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(key),
    );
    return entry === undefined ? undefined : { value: entry.value, at: entry.at };
  } catch {
    return undefined;
  }
}

export async function writeCached<T>(key: string, value: T): Promise<void> {
  const db = await open();
  if (db === null) return;
  try {
    // Svelte state is a proxy; structured clone needs a plain object.
    const plain = JSON.parse(JSON.stringify(value)) as T;
    db.transaction(STORE, "readwrite").objectStore(STORE).put({ key, value: plain, at: Date.now() });
  } catch {
    /* a full or unavailable store just means no cache */
  }
}

/** Drops the oldest stream entries for this scope once there are too many. */
export async function pruneStreams(prefix: string): Promise<void> {
  const db = await open();
  if (db === null) return;
  try {
    const all = await settle<Entry<unknown>[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
    if (all === undefined) return;
    const streams = all
      .filter((entry) => entry.key.startsWith(prefix))
      .sort((a, b) => b.at - a.at);
    if (streams.length <= MAX_STREAMS) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    for (const entry of streams.slice(MAX_STREAMS)) store.delete(entry.key);
  } catch {
    /* pruning is housekeeping, never worth an error */
  }
}

/** Forgets everything for one account, used on sign-out. */
export async function clearScope(prefix: string): Promise<void> {
  const db = await open();
  if (db === null) return;
  try {
    const keys = await settle<IDBValidKey[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
    if (keys === undefined) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    for (const key of keys) if (String(key).startsWith(prefix)) store.delete(key);
  } catch {
    /* nothing to do */
  }
}
