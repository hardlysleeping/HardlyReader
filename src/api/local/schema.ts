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
 * The five tables.
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
    ],
  },

  /**
   * Full-text extractions, kept beside the entry rather than inside it.
   *
   * A failure has to be rememberable too: an article whose page refuses to
   * parse would otherwise be re-fetched every time it is opened, and the reader
   * would never learn that it was tried. So a row with `status = 'failed'` and
   * the reason is a result, and `extracted_at` says when it is worth retrying.
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
} as const;

export type TableName = keyof typeof TABLES;

/** Every table, in declaration order. */
export function tableNames(): TableName[] {
  return Object.keys(TABLES) as TableName[];
}

function sqlType(type: ColumnType): string {
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
}

/** A row of `extractions`. */
export interface ExtractionRow extends LocalRow {
  status: string;
  html: string | null;
  error: string | null;
  extracted_at: number;
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
