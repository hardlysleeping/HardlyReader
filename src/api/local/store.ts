/**
 * The queries, written once.
 *
 * Everything the reader needs to know about its own library is answered here,
 * on top of the four-method `LocalDatabase`. No SQL, no IndexedDB API: sorting,
 * filtering, paging, flagging and the meaning of "unread" are ordinary
 * TypeScript, so the desktop build and the browser build cannot disagree about
 * what a page contains, and the unit suite can prove what they contain without
 * a webview or a Rust process.
 *
 * The deliberate cost is that a query reads the table it needs in full. At the
 * size a device holds — one person's subscriptions, some thousands of articles —
 * that is a few milliseconds, and it buys the property this card cares most
 * about: one implementation, provable in Node. Pushing predicates down into SQL
 * is a change inside a driver, not a change to anything above it.
 *
 * Two rules the rest of the file keeps:
 *
 * - **Nothing is invented.** A feed that is not subscribed cannot have entries,
 *   a read mark for an item that is not stored is refused rather than dropped,
 *   and an extraction is either a body or a remembered failure, never both.
 * - **Ids are the item id the UI holds.** Entries are keyed by it, so a flag
 *   written for an id is a flag the next page will show.
 */
import { LocalStorageError, type LocalDatabase, type WriteOperation } from "./driver";
import type {
  EntryRow,
  ExtractionRow,
  FeedRow,
  FolderRow,
  PositionRow,
} from "./schema";

/** One article, as a feed poll hands it over. */
export interface EntryInput {
  /** The feed's URL, which is its key in `feeds`. */
  feedUrl: string;
  /** The feed's own id for the post: its guid, or its link when it has none. */
  guid: string;
  title?: string | null;
  link?: string | null;
  author?: string | null;
  /** Publication time in seconds. Missing means "as of now". */
  published?: number | null;
  summary?: string | null;
  content?: string | null;
  enclosure?: { href: string; type?: string } | null;
}

export interface EntryQuery {
  /** Restrict to these feeds. An empty list is a label with nothing in it. */
  feeds?: readonly string[];
  /** Only items marked read, or only items not marked read. */
  read?: boolean;
  starred?: boolean;
  /** The `xt` of a GReader stream: hide what is already read. */
  excludeRead?: boolean;
  count?: number;
  continuation?: string;
}

export interface EntryPage {
  entries: EntryRow[];
  /** Pass back as `continuation` for the next page; absent on the last one. */
  continuation?: string;
}

/** One feed's unread total, and the newest thing in it. */
export interface FeedCount {
  feedUrl: string;
  count: number;
  /** Seconds, or null when the feed has nothing stored. */
  newestPublished: number | null;
}

export interface ExtractionInput {
  itemId: string;
  /** The readable body, or null when the attempt failed. */
  html: string | null;
  /** Why it failed. Required when `html` is null. */
  error?: string | null;
}

export interface ReadingPosition {
  itemId: string;
  /** How far into the article, 0 at the top and 1 at the end. */
  offset: number;
  updatedAt: number;
}

export interface SubscribeOptions {
  /** The reader's own title for the feed; omit to use the feed's host. */
  title?: string;
  /** The folder to file it under; omit for Uncategorized. */
  folder?: string | null;
  htmlUrl?: string | null;
  iconUrl?: string | null;
}

/** GReader's default page size, which is what a caller who names none expects. */
const DEFAULT_PAGE = 20;

/** Seconds. The whole schema counts time this way. */
function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A URL-safe base64 of a string of any alphabet.
 *
 * The item id has to survive being put in an attribute, a preference key and a
 * continuation string, so the feed URL inside it is folded down to `[A-Za-z0-9_-]`
 * rather than trusted to be harmless.
 */
function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The id of an article in local mode: the feed it came from, and the feed's own
 * id for it.
 *
 * Stable across a re-fetch, which is what makes a read mark survive one, and
 * derived rather than counted because a local library has no server to hand out
 * numbers — and an id that changed between runs would be a different article
 * every time the app opened.
 */
export function localItemId(feedUrl: string, guid: string): string {
  return `local/${base64Url(feedUrl)}/${guid}`;
}

/** Newest first, with the id breaking ties so a page boundary cannot repeat. */
function newestFirst(a: { published: number; key: string }, b: { published: number; key: string }): number {
  if (a.published !== b.published) return b.published - a.published;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function encodeContinuation(cursor: { published: number; key: string }): string {
  return btoa(encodeURIComponent(JSON.stringify([cursor.published, cursor.key])));
}

function decodeContinuation(value: string): { published: number; key: string } {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(value)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      typeof parsed[1] === "string"
    ) {
      return { published: parsed[0], key: parsed[1] };
    }
  } catch {
    // Falls through to the refusal below: a continuation this code cannot read
    // is not a reason to guess at a page.
  }
  throw new LocalStorageError(
    "This list cannot be continued: its place marker was not written by this version of HardlyReader",
  );
}

export class LocalStore {
  private readonly db: LocalDatabase;

  constructor(db: LocalDatabase) {
    this.db = db;
  }

  /** Which engine is underneath. For the account panel, not for branching. */
  get engine() {
    return this.db.engine;
  }

  /* -------------------------------------------------------------------------
   * Feeds and folders
   * ----------------------------------------------------------------------- */

  async feeds(): Promise<FeedRow[]> {
    const rows = await this.db.all<FeedRow>("feeds");
    return rows.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  async feed(feedUrl: string): Promise<FeedRow | null> {
    return this.db.get<FeedRow>("feeds", feedUrl);
  }

  async folders(): Promise<FolderRow[]> {
    const rows = await this.db.all<FolderRow>("folders");
    return rows.sort(
      (a, b) => a.created_at - b.created_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }

  /**
   * Adds a feed.
   *
   * Nothing here fetches the URL — that is a poller's job, and pretending a
   * subscription is verified when nothing has been fetched would be exactly the
   * kind of plausible lie this layer is meant to avoid. What the row does say is
   * where its title came from: the reader's own words, or the host standing in
   * until the feed can speak for itself.
   */
  async subscribe(feedUrl: string, options: SubscribeOptions = {}): Promise<FeedRow> {
    const url = this.feedUrl(feedUrl);
    const existing = await this.db.get<FeedRow>("feeds", url);
    if (existing !== null) {
      throw new LocalStorageError(`${url} is already subscribed on this device`);
    }

    const given = options.title?.trim() ?? "";
    const folder = options.folder?.trim() ?? "";
    const row: FeedRow = {
      key: url,
      title: given !== "" ? given : new URL(url).hostname,
      html_url: options.htmlUrl ?? null,
      icon_url: options.iconUrl ?? null,
      folder: folder === "" ? null : folder,
      added_at: seconds(),
      title_source: given !== "" ? "given" : "url",
    };

    await this.db.write([
      { type: "put", table: "feeds", row },
      ...(await this.folderWrite(folder)),
    ]);
    return row;
  }

  /**
   * Removes a feed and everything that belonged only to it: its entries, their
   * extractions, and the reading position of its own stream.
   *
   * Leaving the entries behind would make a later visit to the same URL show
   * articles that had been "removed", which is worse than either keeping the
   * subscription or losing the history.
   */
  async unsubscribe(feedUrl: string): Promise<void> {
    const url = this.feedUrl(feedUrl);
    const feed = await this.db.get<FeedRow>("feeds", url);
    if (feed === null) {
      throw new LocalStorageError(`${url} is not subscribed on this device`);
    }

    const entries = (await this.db.all<EntryRow>("entries")).filter((row) => row.feed === url);
    await this.db.write([
      { type: "delete", table: "feeds", key: url },
      { type: "delete", table: "positions", key: `feed/${url}` },
      ...entries.map((row) => ({ type: "delete" as const, table: "entries" as const, key: row.key })),
      ...entries.map((row) => ({
        type: "delete" as const,
        table: "extractions" as const,
        key: row.key,
      })),
    ]);
  }

  /**
   * Files a feed under another folder.
   *
   * `from` is checked rather than ignored: the caller passes the folder it
   * believes the feed is in, and a disagreement means the view that asked is
   * stale. Moving anyway is how a feed ends up in a folder nobody chose, so the
   * disagreement is refused and the reader can look again.
   */
  async moveFeed(feedUrl: string, to: string | null, from: string | null): Promise<void> {
    const url = this.feedUrl(feedUrl);
    const feed = await this.db.get<FeedRow>("feeds", url);
    if (feed === null) {
      throw new LocalStorageError(`${url} is not subscribed on this device`);
    }

    const target = to?.trim() ?? "";
    const source = from?.trim() ?? "";
    const current = feed.folder ?? "";
    if (source !== "" && source !== current) {
      throw new LocalStorageError(
        current === ""
          ? `${url} is not in "${source}" — it is not in a folder at all`
          : `${url} is in "${current}", not "${source}"`,
      );
    }
    if (target === current) return;

    await this.db.write([
      { type: "put", table: "feeds", row: { ...feed, folder: target === "" ? null : target } },
      ...(await this.folderWrite(target)),
    ]);
  }

  /**
   * The row that makes a folder exist, if it does not exist already.
   *
   * Existing folders are left untouched on purpose: `created_at` is what the
   * sidebar orders them by, and an upsert that reset it every time a feed was
   * filed would shuffle the reader's folders each time they tidied one.
   */
  private async folderWrite(name: string): Promise<WriteOperation[]> {
    if (name === "") return [];
    if ((await this.db.get<FolderRow>("folders", name)) !== null) return [];
    const row: FolderRow = { key: name, created_at: seconds() };
    return [{ type: "put", table: "folders", row }];
  }

  /** A feed URL as it will be stored, or a refusal a reader can act on. */
  private feedUrl(input: string): string {
    const trimmed = input.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new LocalStorageError(`"${input}" is not a web address`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new LocalStorageError(`${trimmed} is not an http or https feed address`);
    }
    return trimmed;
  }

  /* -------------------------------------------------------------------------
   * Entries
   * ----------------------------------------------------------------------- */

  /**
   * Stores a batch of articles, keeping whatever the reader has already said
   * about them.
   *
   * A poll re-delivers posts that are already here, so this is an upsert that
   * deliberately does not touch `read` and `starred`: refreshing a feed must not
   * undo a mark, and `stored_at` keeps the first time the post was seen rather
   * than the last time it was re-fetched.
   */
  async putEntries(inputs: readonly EntryInput[]): Promise<{ stored: number; added: number }> {
    if (inputs.length === 0) return { stored: 0, added: 0 };

    const known = new Set((await this.db.all<FeedRow>("feeds")).map((feed) => feed.key));
    const now = seconds();

    // Keyed by id so a batch that repeats a post stores it once, last one wins.
    const rows = new Map<string, EntryRow>();
    for (const input of inputs) {
      const url = this.feedUrl(input.feedUrl);
      if (!known.has(url)) {
        throw new LocalStorageError(
          `Cannot store an article from ${url}: it is not subscribed on this device`,
        );
      }
      const key = localItemId(url, input.guid);
      rows.set(key, {
        key,
        feed: url,
        guid: input.guid,
        title: input.title ?? null,
        link: input.link ?? null,
        author: input.author ?? null,
        published: Math.floor(input.published ?? now),
        summary: input.summary ?? null,
        content: input.content ?? null,
        enclosure_href: input.enclosure?.href ?? null,
        enclosure_type: input.enclosure?.type ?? null,
        read: 0,
        starred: 0,
        stored_at: now,
      });
    }

    const before = new Map(
      (await this.db.getMany<EntryRow>("entries", [...rows.keys()])).map((row) => [row.key, row]),
    );

    const operations = [...rows.values()].map((row) => {
      const prior = before.get(row.key);
      return {
        type: "put" as const,
        table: "entries" as const,
        row: {
          ...row,
          read: prior?.read ?? 0,
          starred: prior?.starred ?? 0,
          stored_at: prior?.stored_at ?? row.stored_at,
        },
      };
    });

    await this.db.write(operations);
    return {
      stored: operations.length,
      added: [...rows.keys()].filter((key) => !before.has(key)).length,
    };
  }

  async entry(itemId: string): Promise<EntryRow | null> {
    return this.db.get<EntryRow>("entries", itemId);
  }

  /**
   * One page of a stream, newest first.
   *
   * The continuation is opaque on purpose — a caller that parsed it would be
   * depending on how pages are cut today.
   */
  async queryEntries(query: EntryQuery = {}): Promise<EntryPage> {
    const count = query.count ?? DEFAULT_PAGE;
    if (!Number.isFinite(count) || count < 1) {
      throw new LocalStorageError(`A page of ${String(query.count)} articles is not a page`);
    }

    if (query.feeds !== undefined && query.feeds.length === 0) {
      return { entries: [] };
    }

    const wanted = query.feeds === undefined ? null : new Set(query.feeds);
    const rows = (await this.db.all<EntryRow>("entries")).filter((row) => {
      if (wanted !== null && !wanted.has(row.feed)) return false;
      if (query.starred === true && row.starred !== 1) return false;
      if (query.read === true && row.read !== 1) return false;
      if (query.read === false && row.read === 1) return false;
      if (query.excludeRead === true && row.read === 1) return false;
      return true;
    });

    rows.sort(newestFirst);

    const cursor =
      query.continuation === undefined ? null : decodeContinuation(query.continuation);
    const start = cursor === null ? 0 : rows.findIndex((row) => newestFirst(row, cursor) > 0);
    if (start === -1) return { entries: [] };

    const page = rows.slice(start, start + count);
    const hasMore = rows.length > start + page.length;
    const last = page[page.length - 1];
    return hasMore && last !== undefined
      ? { entries: page, continuation: encodeContinuation(last) }
      : { entries: page };
  }

  /**
   * Marks items read or unread.
   *
   * An id that is not stored is refused instead of ignored: a mark this layer
   * accepts and cannot keep would come back as unread on the next page, which is
   * the one outcome the seam forbids. In local mode the UI can only mark what it
   * was shown, so an unknown id means the view is stale and should be reloaded.
   */
  async setRead(itemIds: readonly string[], read: boolean): Promise<void> {
    await this.setFlag(itemIds, "read", read);
  }

  async setStarred(itemIds: readonly string[], starred: boolean): Promise<void> {
    await this.setFlag(itemIds, "starred", starred);
  }

  private async setFlag(
    itemIds: readonly string[],
    column: "read" | "starred",
    value: boolean,
  ): Promise<void> {
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return;

    const rows = await this.db.getMany<EntryRow>("entries", ids);
    const found = new Set(rows.map((row) => row.key));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const shown = missing.slice(0, 3).join(", ");
      throw new LocalStorageError(
        `Cannot mark ${missing.length} article${missing.length === 1 ? "" : "s"} as ` +
          `${value ? "" : "not "}${column}: nothing with the id ${shown}` +
          `${missing.length > 3 ? " (and more)" : ""} is stored on this device`,
      );
    }

    await this.db.write(
      rows.map((row) => ({
        type: "put" as const,
        table: "entries" as const,
        row: { ...row, [column]: value ? 1 : 0 },
      })),
    );
  }

  /**
   * Unread totals per feed, in one pass.
   *
   * Also the newest stored article in each feed, which the counts endpoint
   * reports alongside the number and the sidebar uses to order by recency.
   */
  async counts(): Promise<FeedCount[]> {
    const counts = new Map<string, FeedCount>();
    for (const row of await this.db.all<EntryRow>("entries")) {
      const current = counts.get(row.feed) ?? {
        feedUrl: row.feed,
        count: 0,
        newestPublished: null,
      };
      if (row.read !== 1) current.count += 1;
      if (current.newestPublished === null || row.published > current.newestPublished) {
        current.newestPublished = row.published;
      }
      counts.set(row.feed, current);
    }
    return [...counts.values()];
  }

  /* -------------------------------------------------------------------------
   * Extraction results
   * ----------------------------------------------------------------------- */

  /**
   * Records what fetching the article's own page came to.
   *
   * A failure is stored as deliberately as a success: the app can then say it
   * tried, when, and why not, instead of silently re-fetching the same stubborn
   * page every time the post is opened.
   */
  async saveExtraction(input: ExtractionInput): Promise<void> {
    const error = input.error?.trim() ?? "";
    if (input.html === null && error === "") {
      throw new LocalStorageError(
        `Nothing to record for ${input.itemId}: an extraction needs a body or a reason it failed`,
      );
    }

    const row: ExtractionRow = {
      key: input.itemId,
      status: input.html === null ? "failed" : "ok",
      html: input.html,
      error: error === "" ? null : error,
      extracted_at: seconds(),
    };
    await this.db.write([{ type: "put", table: "extractions", row }]);
  }

  /** A remembered failure, in one call. */
  async recordExtractionFailure(itemId: string, reason: string): Promise<void> {
    await this.saveExtraction({ itemId, html: null, error: reason });
  }

  async extraction(itemId: string): Promise<ExtractionRow | null> {
    return this.db.get<ExtractionRow>("extractions", itemId);
  }

  /* -------------------------------------------------------------------------
   * Reading position
   * ----------------------------------------------------------------------- */

  /**
   * Remembers where the reader had got to in a stream.
   *
   * The offset is clamped rather than refused: a scroll position can overshoot
   * when the last pane shrinks under it, and that is not a reason to lose the
   * place. A value that is not a number at all is a different thing — a bug —
   * and is reported.
   */
  async savePosition(streamId: string, position: { itemId: string; offset: number }): Promise<void> {
    if (!Number.isFinite(position.offset)) {
      throw new LocalStorageError(
        `Cannot remember where ${streamId} was scrolled to: ${String(position.offset)} is not a position`,
      );
    }

    const row: PositionRow = {
      key: streamId,
      item_id: position.itemId,
      offset: Math.min(1, Math.max(0, position.offset)),
      updated_at: seconds(),
    };
    await this.db.write([{ type: "put", table: "positions", row }]);
  }

  async position(streamId: string): Promise<ReadingPosition | null> {
    const row = await this.db.get<PositionRow>("positions", streamId);
    return row === null
      ? null
      : { itemId: row.item_id, offset: row.offset, updatedAt: row.updated_at };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
