/**
 * What a local library is made of, declared once.
 *
 * The same declaration has to serve two very different stores: SQLite through
 * the Tauri plugin in the desktop build, and IndexedDB in a browser tab. Both
 * understand "a table of rows keyed by a string", and neither is asked to
 * understand more than that — no joins, no `WHERE`, no index planning. So the
 * tables are written down here as data, the SQLite driver turns them into
 * `CREATE TABLE` statements, the IndexedDB driver turns them into object
 * stores, and the queries themselves live in `store.ts` in plain TypeScript,
 * exactly once, so a row read from either engine is the same row.
 *
 * Three conventions the rest of the directory relies on:
 *
 * 1. **Every row has a string `key`.** It is the table's primary key in SQLite
 *    and the key path in IndexedDB, and it is always the thing a query was
 *    asked for — a feed's URL, an item's id, a stream's id, a label's name.
 * 2. **Booleans are integers, 0 or 1.** SQLite has no boolean type and
 *    IndexedDB would happily keep `true` alongside `1`, which would make
 *    `read === true` and `read === 1` two different libraries. One spelling.
 * 3. **Times are seconds**, except `timestampUsec`, which is derived. That is
 *    what `StreamItem.published` is in the GReader vocabulary the seam hands
 *    back, and there is no reason for a second scale inside the app.
 */

/** A value that can go into a column, and come back out of one unchanged. */
export type LocalValue = string | number | null;

/** A stored row. Concrete row shapes below add their own columns. */
export interface LocalRow {
  key: string;
  [column: string]: LocalValue | undefined;
}

/** Which engine is answering. Reported so callers can say where data lives. */
export type LocalEngine = "sqlite" | "indexeddb" | "memory";

export type ColumnType = "text" | "integer" | "real";

export interface ColumnSchema {
  name: string;
  type: ColumnType;
}

/**
 * The six tables.
 *
 * They are deliberately flat. A local library is one person's reading, so the
 * questions asked of it are simple — "this feed's items, newest first", "what
 * is unread", "did I already extract this one" — and a schema that answers them
 * with a scan costs nothing at the size a device holds, while a schema with
 * joins would have to be written twice, once per engine, and kept in step.
 */
export const TABLES = {
  /**
   * One row per subscription. The key is the feed's own URL, which is also how
   * its stream id is spelled: `feed/<url>`.
   */
  feeds: {
    columns: [
      { name: "title", type: "text" },
      { name: "html_url", type: "text" },
      { name: "icon_url", type: "text" },
      /** The one folder it sits in, or null for Uncategorized. */
      { name: "folder", type: "text" },
      { name: "added_at", type: "integer" },
      /**
       * Where the title came from: `feed` when the feed said it, `given` when
       * the reader typed it, `url` when it is only the host standing in until
       * the feed is first fetched. A title nobody chose should be visible as
       * such rather than looking like a feed that renamed itself.
       */
      { name: "title_source", type: "text" },
      /**
       * The poll's own memory, kept on the row it belongs to.
       *
       * A device that fetches its own feeds cannot ask a server whether
       * something is due, so the answer has to be stored: when this feed was
       * last read successfully, when it was last attempted at all, and the
       * two validators that let a poll cost nothing when nothing changed.
       *
       * Two times rather than one, because they answer different questions.
       * `fetched_at` is how stale this library is — a feed that answered `500`
       * has not become current — while `attempted_at` is what the next attempt
       * is measured from, so a feed that is down is retried on a widening
       * interval instead of on every wake. `failures` is the width of it.
       */
      { name: "fetched_at", type: "integer" },
      { name: "attempted_at", type: "integer" },
      { name: "etag", type: "text" },
      { name: "last_modified", type: "text" },
      { name: "failures", type: "integer" },
      { name: "last_error", type: "text" },
      /**
       * Where the feed finally answered, which is not always where it was
       * subscribed: a site that moved to another host, or answers a permanent
       * redirect, gives a different address than the one typed into the box.
       *
       * The row's key follows this once a poll has seen the difference — one
       * feed, one identity — and this column is what remembers the address
       * even for a feed that never moved, so the question "does this feed live
       * where it says it does" is answered by a column rather than by a fetch.
       * Null until the first successful poll.
       */
      { name: "resolved_url", type: "text" },
    ],
  },

  /**
   * One row per article. The key is the item id handed to the UI, minted by
   * `store.ts` from the feed URL and the entry's own guid, so the same post
   * fetched twice is the same row rather than a second copy.
   */
  entries: {
    columns: [
      /** The feed's URL, i.e. its key in `feeds`. */
      { name: "feed", type: "text" },
      /** The feed's own identifier for the post, kept for debugging and dedupe. */
      { name: "guid", type: "text" },
      { name: "title", type: "text" },
      { name: "link", type: "text" },
      { name: "author", type: "text" },
      { name: "published", type: "integer" },
      { name: "summary", type: "text" },
      { name: "content", type: "text" },
      { name: "enclosure_href", type: "text" },
      { name: "enclosure_type", type: "text" },
      /** 0 or 1, never a boolean — see the note at the top. */
      { name: "read", type: "integer" },
      { name: "starred", type: "integer" },
      /** When this device first stored the post, not when it was published. */
      { name: "stored_at", type: "integer" },
      /**
       * The id of the row that replaced this one, when the feed changed its
       * guid scheme and the same article arrived under a new id.
       *
       * The old row is kept rather than deleted — its body, its marks and the
       * fact that it existed — but it is no longer the article: the list, the
       * counts and the sync document all follow the row that superseded it.
       */
      { name: "superseded_by", type: "text" },
    ],
  },

  /**
   * Full-text extractions, kept beside the entry rather than inside it.
   *
   * A failure has to be rememberable too: an article whose page refuses to
   * parse would otherwise be re-fetched every time it is opened, and the reader
   * would never learn that it was tried. So a row with `status = 'failed'` and
   * the reason is a result, and `extracted_at` says when it is worth retrying.
   *
   * The rest of the row is what makes the table a library rather than a memo: a
   * body that survives a restart is read back without a request, so it carries
   * the parts of the extraction the pane draws (`title`, `byline`, the length
   * `chooseBody` weighs) and the two numbers the budget needs — `bytes` on disk
   * and `used_at`, the last time the post was opened. Both are absent on a
   * failure: a failure holds no text and is not a candidate for eviction.
   */
  extractions: {
    columns: [
      /** `ok` or `failed`. */
      { name: "status", type: "text" },
      /** The readable body, once there is one. Null on a failure. */
      { name: "html", type: "text" },
      /** Why it failed, in words a reader could be shown. */
      { name: "error", type: "text" },
      { name: "extracted_at", type: "integer" },
      /** The article's own headline, when the extractor found one. */
      { name: "title", type: "text" },
      { name: "byline", type: "text" },
      /** Characters of text, which is what `chooseBody` decides on. */
      { name: "text_length", type: "integer" },
      /** UTF-8 bytes of `html`: what this body costs the device. */
      { name: "bytes", type: "integer" },
      /** Seconds, the last time this body was read. Least-recently-used order. */
      { name: "used_at", type: "integer" },
    ],
  },

  /**
   * Where the reader had got to, per stream.
   *
   * Keyed by stream id rather than by item: the position that matters is "in
   * this list, this post, this far down", and a stream that is re-read later
   * should resume where it was left.
   */
  positions: {
    columns: [
      { name: "item_id", type: "text" },
      /** How far into the article, 0 at the top and 1 at the end. */
      { name: "offset", type: "real" },
      { name: "updated_at", type: "integer" },
    ],
  },

  /**
   * Folders, including empty ones.
   *
   * A folder that holds nothing is still a thing the reader made and expects to
   * see, so it cannot be inferred from the feeds that point at it.
   */
  folders: {
    columns: [
      { name: "created_at", type: "integer" },
    ],
  },

  /**
   * A feed that moved, and the address it moved to.
   *
   * The key is the address the feed was subscribed at, and `to` is where it
   * answers now. It is a separate row rather than a field on `feeds` because
   * the feed's row has *become* the new address: the old one is a fact about
   * the past, and it has to outlive the subscription so the other device can
   * follow it instead of subscribing a second time.
   *
   * `at` is when this device learned the move. It is the one thing a merge
   * compares, and a redirect is a fact rather than a preference: one device
   * seeing it is enough, and two devices disagreeing about the target is a
   * conflict the newer record settles.
   */
  redirects: {
    columns: [
      { name: "to", type: "text" },
      { name: "at", type: "integer" },
    ],
  },
} as const;

export type TableName = keyof typeof TABLES;

/** Every table, in declaration order. */
export function tableNames(): TableName[] {
  return Object.keys(TABLES) as TableName[];
}

export function sqlType(type: ColumnType): string {
  switch (type) {
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "real":
      return "REAL";
  }
}

/**
 * The `CREATE TABLE` for one table.
 *
 * `IF NOT EXISTS` because opening a library that already exists is the normal
 * case, and because this statement is also the migration: a future column is a
 * line here plus a step that fills it in, and the tests run this exact text
 * against a real SQLite engine so a typo cannot wait until the app is launched.
 */
export function createTableSql(name: TableName): string {
  const columns = TABLES[name].columns
    .map((column) => `"${column.name}" ${sqlType(column.type)}`)
    .join(", ");
  return `CREATE TABLE IF NOT EXISTS "${name}" ("key" TEXT PRIMARY KEY NOT NULL, ${columns})`;
}

/** One row's column values, in the order {@link TABLES} declares them. */
export function columnValues(name: TableName, row: LocalRow): LocalValue[] {
  return TABLES[name].columns.map((column) => row[column.name] ?? null);
}

/** Column names in declaration order, `key` first — the insert order. */
export function columnNames(name: TableName): string[] {
  return ["key", ...TABLES[name].columns.map((column) => column.name)];
}

/** A row of `feeds`. */
export interface FeedRow extends LocalRow {
  title: string;
  html_url: string | null;
  icon_url: string | null;
  folder: string | null;
  added_at: number;
  title_source: string;
  /** Seconds of the last poll that got an answer; null until one has. */
  fetched_at: number | null;
  /** Seconds of the last poll attempt, successful or not. */
  attempted_at: number | null;
  /** The feed's own validators, sent back on the next poll. */
  etag: string | null;
  last_modified: string | null;
  /** Consecutive failed polls, reset by any poll that gets an answer. */
  failures: number | null;
  /** Why the last poll failed, in words, or null when it did not. */
  last_error: string | null;
  /**
   * Where the feed finally answered: its own key once a poll has confirmed it,
   * and the address it arrived from before a move. Null until it is fetched.
   */
  resolved_url: string | null;
}

/** A row of `entries`. */
export interface EntryRow extends LocalRow {
  feed: string;
  guid: string;
  title: string | null;
  link: string | null;
  author: string | null;
  published: number;
  summary: string | null;
  content: string | null;
  enclosure_href: string | null;
  enclosure_type: string | null;
  read: number;
  starred: number;
  stored_at: number;
  /** The row that replaced this one, or null while this is the article. */
  superseded_by?: string | null;
}

/** A row of `extractions`. */
export interface ExtractionRow extends LocalRow {
  status: string;
  html: string | null;
  error: string | null;
  extracted_at: number;
  /** Absent on a row written before bodies were kept, and on any failure. */
  title?: string | null;
  byline?: string | null;
  text_length?: number | null;
  bytes?: number | null;
  used_at?: number | null;
}

/** A row of `positions`. */
export interface PositionRow extends LocalRow {
  item_id: string;
  offset: number;
  updated_at: number;
}

/** A row of `folders`. */
export interface FolderRow extends LocalRow {
  created_at: number;
}

/** A row of `redirects`: a feed that moved, and where it went. */
export interface RedirectRow extends LocalRow {
  to: string;
  at: number;
}
