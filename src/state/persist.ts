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
 *
 * Keys are account-scoped the same way `localStorage` is, through the one slug
 * in `lib/account-key`: `<slug>|<name>`, never a server or an address. See
 * `scopeKey` for what the slug does and does not buy.
 */

import { accountSlug, type AccountIdentity } from "../lib/account-key";

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
      request.onsuccess = () => {
        const db = request.result;
        // Old-layout blobs are unreadable from here on; drop them rather than
        // leave stored addresses behind. Fire and forget: a read that arrives
        // first is simply a miss.
        void dropStaleKeys(db);
        resolve(db);
      };
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

/**
 * Keys are scoped to one account, so two logins never mix.
 *
 * The account is named by the same slug `localStorage` uses — a hash of the
 * server and the address, never either of them. IndexedDB is as readable as
 * `localStorage` to anything running in the webview (and to anyone with a
 * developer console), so a key that spelled out the server and then the address
 * was a stored address with a cache value bolted on.
 *
 * What the slug buys: no stored key carries a name, and two accounts on one
 * device land on different keys. What it does not buy: secrecy. 32 bits of
 * FNV-1a is an identity tag; someone holding the device who can name a candidate
 * server and address can hash it in microseconds and see whether a blob is
 * theirs. It is not a password, not a salt, and not a boundary worth trusting if
 * the cache value itself is sensitive — the cache holds public feed text and
 * stream listings, and that is a fair thing to keep in a readable place.
 */
export function scopeKey(account: AccountIdentity, name: string): string {
  return `${accountSlug(account)}|${name}`;
}

/**
 * Shapes a key this build writes. A blob under any other key was written by an
 * older build and can no longer be found, since every read goes through
 * `scopeKey`.
 */
const OWN_KEY = /^[0-9a-f]{8}\|/;

let swept = false;

/**
 * Drops cache blobs this build cannot read, once per launch.
 *
 * The pre-scoping keys were `${serverUrl}|${user}|${name}`, so on a device that
 * upgrades they hold exactly the server and the address we no longer want
 * stored — and nothing would ever delete them: lookups miss them, and
 * `pruneStreams`/`clearScope` filter on a slug prefix they do not carry.
 *
 * These blobs are read once or not at all: they are let go, not migrated. A
 * cache is disposable by definition, and the whole cost of letting one go is the
 * single round-trip it was there to save, once. Migrating instead would mean
 * reading old keys, parsing an address out of them to work out whose they were,
 * and re-writing them — more code, more address handling, to save one fetch.
 */
async function dropStaleKeys(db: IDBDatabase): Promise<void> {
  if (swept) return;
  swept = true;
  try {
    const keys = await settle<IDBValidKey[]>(
      db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys(),
    );
    if (keys === undefined) return;
    const stale = keys.filter((key) => !OWN_KEY.test(String(key)));
    if (stale.length === 0) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    for (const key of stale) store.delete(key);
  } catch {
    /* housekeeping: an un-swept store is only untidy, never wrong */
  }
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
