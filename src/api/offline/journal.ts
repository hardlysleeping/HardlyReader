/**
 * The marks a reader made while the server could not be reached.
 *
 * A read mark is the smallest thing in this app and the one the reader makes
 * most: scrolling a list marks posts as they are read, and every one of those
 * presses used to be a request. On a train, in a lift, behind a captive portal,
 * that request fails — and until now the app rolled the mark back and said why.
 * The reader's answer to a post going out of view is not "the network was down":
 * the mark is their decision, it is what the next launch should show, and it is
 * the one thing a server can be told later.
 *
 * So marks are written here first, and sent when there is somewhere to send
 * them. This file is the queue and nothing else: it never talks to a backend, it
 * has no opinion about HTTP, and it does not know what a stream is. The policy is
 * three lines long — last value wins per item, a mark is forgotten when it lands,
 * and the file survives a restart — and it is testable against a bank that is a
 * `Map`.
 *
 * `read` and `starred` are two registers, never one: a post marked read and then
 * starred is two facts about it, and a queue that folded them together would
 * send whichever was last and lose the other. That is the same rule the device
 * sync document follows (`api/local/sync.ts`), for the same reason.
 */

/** The two marks a reader can make, as GReader names them. */
export type MarkKind = "read" | "starred";

/** One decision that has not reached the server yet. */
export interface PendingMark {
  kind: MarkKind;
  /** The post, as GReader spells it. */
  itemId: string;
  /** What the reader decided: true is marked, false is cleared. */
  value: boolean;
  /** When they decided it, in milliseconds. The queue's order, and a batch's. */
  at: number;
}

/**
 * Where the queue is kept between launches.
 *
 * Two methods and no queries: the policy lives in `WriteJournal`, where a `Map`
 * can stand in for a database, and a bank only has to be a keyed bag of marks.
 * Both may throw — a locked IndexedDB, a full quota, a private window — and the
 * caller treats that as "no queue", which is why the fallback is the plain
 * write it has always done.
 */
export interface JournalBank {
  load(slug: string): Promise<PendingMark[]>;
  save(slug: string, marks: readonly PendingMark[]): Promise<void>;
}

/** One mark's identity inside the queue: the item, and which register it is. */
export function markKey(mark: Pick<PendingMark, "kind" | "itemId">): string {
  // The kind first and a NUL between them: an item id is a URL and could hold a
  // separator a person can type, and two marks that collide in the queue would
  // silently become one.
  return `${mark.kind}\u0000${mark.itemId}`;
}

/** A bank in memory. What a suite uses, and what a runtime without IndexedDB gets. */
export class MemoryJournalBank implements JournalBank {
  private readonly held = new Map<string, PendingMark[]>();

  load(slug: string): Promise<PendingMark[]> {
    return Promise.resolve((this.held.get(slug) ?? []).map((mark) => ({ ...mark })));
  }

  save(slug: string, marks: readonly PendingMark[]): Promise<void> {
    this.held.set(slug, marks.map((mark) => ({ ...mark })));
    return Promise.resolve();
  }
}

const DB_NAME = "hardlyreader-writes";
const DB_VERSION = 1;
const STORE = "marks";

interface Row extends PendingMark {
  /** `${slug}|${kind}|${itemId}`: one row per mark, so a save is a replace. */
  key: string;
  slug: string;
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
          db.createObjectStore(STORE, { keyPath: "key" }).createIndex("slug", "slug");
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

/**
 * The queue on disk, per account.
 *
 * Its own database (`hardlyreader-writes`) rather than a corner of the stream
 * cache: a cache is disposable and is cleared on a whim, and a queued mark is a
 * decision the server has not heard yet. Nothing else writes here, and nothing
 * here writes anywhere else — the store holds bookmarks, not article text.
 *
 * Rows carry the account slug rather than a database per account, so a device
 * with three accounts has one store to open and a sign-out can drop exactly one
 * account's rows.
 */
export class IdbJournalBank implements JournalBank {
  async load(slug: string): Promise<PendingMark[]> {
    const db = await open();
    if (db === null) return [];
    try {
      const rows = await settle<Row[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
      if (rows === undefined) return [];
      return rows
        .filter((row) => row.slug === slug)
        .map((row) => ({ kind: row.kind, itemId: row.itemId, value: row.value, at: row.at }));
    } catch {
      return [];
    }
  }

  async save(slug: string, marks: readonly PendingMark[]): Promise<void> {
    const db = await open();
    if (db === null) throw new Error("This device has no store for queued marks");
    // A save is the whole queue for one account: the rows it no longer names are
    // gone, which is what makes a landed mark disappear rather than linger. The
    // keys are read first, in their own transaction, because a delete needs the
    // key and the write transaction must not hold one open across an await.
    const stale = await settle<IDBValidKey[]>(
      db.transaction(STORE, "readonly").objectStore(STORE).index("slug").getAllKeys(IDBKeyRange.only(slug)),
    );
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    for (const key of stale ?? []) store.delete(key);
    for (const mark of marks) {
      const row: Row = {
        key: `${slug}|${mark.kind}|${mark.itemId}`,
        slug,
        kind: mark.kind,
        itemId: mark.itemId,
        value: mark.value,
        at: mark.at,
      };
      store.put(row);
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = store.transaction;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("The queued marks could not be stored"));
      transaction.onabort = () => reject(new Error("The queued marks could not be stored"));
    });
  }

  /** Drops one account's queue. Used when the account is removed from the device. */
  async clear(slug: string): Promise<void> {
    const db = await open();
    if (db === null) return;
    try {
      const keys = await settle<IDBValidKey[]>(
        db.transaction(STORE, "readonly").objectStore(STORE).index("slug").getAllKeys(IDBKeyRange.only(slug)),
      );
      if (keys === undefined) return;
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      for (const key of keys) store.delete(key);
    } catch {
      /* housekeeping: an un-cleared queue is untidy, never wrong */
    }
  }
}

/**
 * The queue for one account, in memory, written through to its bank.
 *
 * Read once on `open()` and kept in a `Map` after that: a flush walks the whole
 * queue on every attempt, and going to disk for that would make a reconnect as
 * slow as the network it is recovering from. Every `record` writes the whole
 * queue back, which is a handful of small rows and is what makes "the mark is
 * made" and "the mark is stored" the same moment.
 */
export class WriteJournal {
  private readonly bank: JournalBank;
  private readonly slug: string;
  private readonly now: () => number;
  private readonly marks = new Map<string, PendingMark>();
  private opening: Promise<void> | null = null;
  private loaded = false;

  // Plain fields rather than parameter properties: the unit suites run under
  // Node's strip-only TypeScript, which cannot compile the latter.
  constructor(bank: JournalBank, slug: string, now: () => number = () => Date.now()) {
    this.bank = bank;
    this.slug = slug;
    this.now = now;
  }

  /** Reads what a previous launch left behind. Idempotent, and safe to race. */
  open(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.opening !== null) return this.opening;
    this.opening = this.bank
      .load(this.slug)
      .then((stored) => {
        // The disk is not authority over decisions made since this launch: a mark
        // recorded while the read was out keeps its newer value.
        for (const mark of stored) {
          const key = markKey(mark);
          if (!this.marks.has(key)) this.marks.set(key, mark);
        }
      })
      .catch(() => {
        /* no queue on disk is an empty queue */
      })
      .finally(() => {
        this.loaded = true;
        this.opening = null;
      });
    return this.opening;
  }

  /**
   * Records a decision, and waits only for the disk.
   *
   * The value replaces whatever this item last said — a post read and then
   * marked unread queues one write, not two — and the timestamp moves with it, so
   * the queue's order is the order of the reader's presses.
   */
  async record(kind: MarkKind, itemIds: readonly string[], value: boolean): Promise<void> {
    await this.open();
    const at = this.now();
    const replaced = new Map<string, PendingMark | undefined>();
    for (const itemId of itemIds) {
      const key = markKey({ kind, itemId });
      replaced.set(key, this.marks.get(key));
      this.marks.set(key, { kind, itemId, value, at });
    }
    try {
      await this.bank.save(this.slug, this.entries());
    } catch (error) {
      // The disk did not take it, so the queue does not hold it either: a mark
      // that only lives in memory would be sent twice — once by the caller's
      // fallback and once by the next flush — and would be gone after a restart
      // while the app behaved as if it were safe.
      for (const [key, previous] of replaced) {
        if (previous === undefined) this.marks.delete(key);
        else this.marks.set(key, previous);
      }
      throw error;
    }
  }

  /** The queue in the order it was written. */
  entries(): PendingMark[] {
    return [...this.marks.values()].sort((a, b) => (a.at === b.at ? markKey(a).localeCompare(markKey(b)) : a.at - b.at));
  }

  /**
   * What this account has decided about each post, for one register.
   *
   * The reading surfaces use this to draw a page the server sent *before* it was
   * told: a queued mark is the reader's answer, and painting the server's older
   * one over it would undo it on screen while the queue still held it.
   */
  values(kind: MarkKind): Map<string, boolean> {
    const values = new Map<string, boolean>();
    for (const mark of this.marks.values()) {
      if (mark.kind === kind) values.set(mark.itemId, mark.value);
    }
    return values;
  }

  /** Forgets marks that reached the server. */
  async forget(marks: readonly PendingMark[]): Promise<void> {
    let changed = false;
    for (const mark of marks) {
      // Only if it is still the mark that landed: a press made while the write
      // was out must survive the write's own completion.
      const held = this.marks.get(markKey(mark));
      if (held === undefined || held.value !== mark.value || held.at !== mark.at) continue;
      this.marks.delete(markKey(mark));
      changed = true;
    }
    if (changed) await this.bank.save(this.slug, this.entries());
  }

  /** Forgets everything, for an account that is leaving the device. */
  async clear(): Promise<void> {
    this.marks.clear();
    await this.bank.save(this.slug, []);
    if (this.bank instanceof IdbJournalBank) await this.bank.clear(this.slug);
  }

  get size(): number {
    return this.marks.size;
  }
}
