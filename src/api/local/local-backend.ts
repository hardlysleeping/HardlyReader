/**
 * The local backend: the reader's own device answering the seam's questions.
 *
 * It is not a FreshRSS server pretending to be inside the app. There is no HTTP
 * surface here, no GReader endpoints, no auth token and no `output=json` — only
 * a store, translated into the vocabulary the reading UI already speaks. The
 * translation is the whole job of this file, and it is deliberately dull: every
 * method either does what it was asked or refuses in a sentence a person can
 * read.
 *
 * The refusals are the interesting part, because a local library cannot do
 * everything a server can:
 *
 * - A stream id this device has never heard of is refused rather than answered
 *   with an empty page. An empty page means "nothing unread here", which is a
 *   claim about the reader's library; a missing feed means "ask a different
 *   question", which is a claim about the question.
 * - A read mark for an article that is not stored is refused by the store, for
 *   the same reason: the mark would not survive the next page.
 * - A move whose `from` disagrees with the stored folder is refused, because the
 *   caller's view is stale and moving anyway is how a feed ends up in a folder
 *   nobody chose.
 *
 * What it does honour is everything the three panes actually ask for: the
 * reading list, a single feed, a label, starred, read, unread filtering, the
 * page size and the continuation.
 */
import {
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
  type StreamContents,
  type StreamItem,
  type StreamOptions,
  type Subscription,
  type Tag,
  type UnreadCount,
  type UserInfo,
} from "../freshrss";
import { transport } from "../transport";
import { LocalStorageError } from "./driver";
import { refreshDueFeeds, type FeedFetcher, type RefreshReport, type WakeReason } from "./refresh";
import type { EntryRow, FeedRow } from "./schema";
import type { EntryQuery, LocalStore } from "./store";
import type { MoveFeedRequest, ReaderBackend, SubscribeRequest } from "../backend";

const FEED_PREFIX = "feed/";
const LABEL_PREFIX = "user/-/label/";

/** What the account panel shows for a library that lives on this device. */
export interface LocalBackendOptions {
  /** What to call this device in the account panel. */
  deviceName?: string;
  /**
   * How to reach a feed over the network.
   *
   * The same transport the GReader client uses, which means the plugin's HTTP
   * inside the app (no CORS, and the phone's own radio) and plain `fetch` in a
   * browser tab. Injected so a suite can answer without a network.
   */
  fetch?: FeedFetcher;
}

/** The cancellation error name the rest of the app already knows. */
function cancelled(): Error {
  const error = new Error("The local stream read was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Whether the caller has given up on this read.
 *
 * A function rather than an inline test so the two checks in `stream` are reads
 * of the signal rather than a value the compiler has already narrowed: after
 * the first check the type would say "not aborted", and the second check would
 * be dead code to everyone except the browser.
 */
function abandoned(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Seconds to the microseconds GReader spells timestamps in. */
function usec(published: number): string {
  return `${published}000000`;
}

/**
 * One stored article as a `StreamItem`.
 *
 * The fields are the ones the app renders and nothing else: a missing author is
 * absent rather than an empty string, and a body that was never stored is absent
 * so the feed's summary still shows through. Filling those in with `""` would
 * look like an article that had been fetched and turned out to be blank.
 */
function toStreamItem(row: EntryRow, feed: FeedRow | undefined): StreamItem {
  const categories: string[] = [];
  if (row.read === 1) categories.push(STATE_READ);
  if (row.starred === 1) categories.push(STATE_STARRED);

  const item: StreamItem = {
    id: row.key,
    published: row.published,
    timestampUsec: usec(row.published),
    categories,
    origin: {
      streamId: `${FEED_PREFIX}${row.feed}`,
      title: feed?.title,
      htmlUrl: feed?.html_url ?? undefined,
    },
  };

  if (row.title !== null) item.title = row.title;
  if (row.author !== null) item.author = row.author;
  if (row.link !== null) {
    item.alternate = [{ href: row.link }];
    item.canonical = [{ href: row.link }];
  }
  if (row.summary !== null) item.summary = { content: row.summary };
  if (row.content !== null) item.content = { content: row.content };
  if (row.enclosure_href !== null) {
    item.enclosure =
      row.enclosure_type === null
        ? [{ href: row.enclosure_href }]
        : [{ href: row.enclosure_href, type: row.enclosure_type }];
  }

  return item;
}

export class LocalBackend implements ReaderBackend {
  readonly kind = "local" as const;

  /**
   * The library itself, for the two things that are not reading: the poller and
   * device sync. Both need the store rather than the seam — a sync merges rows,
   * it does not fetch a page — and a caller holding only a `ReaderBackend` has
   * no other way to reach them.
   */
  readonly store: LocalStore;
  private readonly deviceName: string;
  private readonly fetcher: FeedFetcher;

  constructor(store: LocalStore, options: LocalBackendOptions = {}) {
    this.store = store;
    this.deviceName = options.deviceName ?? "On this device";
    this.fetcher = options.fetch ?? (transport as unknown as FeedFetcher);
  }

  /**
   * Polls every feed that is due and keeps what it finds.
   *
   * This is what a server does on its own: there is no crawler behind a library
   * on this device, so opening the app (or pressing sync) is the crawl. The
   * report is returned rather than swallowed so a caller can say how many
   * articles arrived, and a feed that failed stays a per-feed line instead of
   * taking the whole wake down.
   */
  async fetchNew(options: { wake?: WakeReason; signal?: AbortSignal } = {}): Promise<RefreshReport> {
    return refreshDueFeeds({
      store: this.store,
      fetch: this.fetcher,
      wake: options.wake ?? "manual",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * The account behind a local library.
   *
   * There is no address and no email because there is no server and no sign-in;
   * saying so in the fields the panel prints is more honest than inventing a
   * domain, and `userId: "local"` is the marker a caller can test for.
   */
  profile(): Promise<UserInfo> {
    return Promise.resolve({
      userId: "local",
      userName: this.deviceName,
      userProfileId: "local",
      userEmail: "",
    });
  }

  async subscriptions(): Promise<Subscription[]> {
    const feeds = await this.store.feeds();
    return feeds.map((feed) => ({
      id: `${FEED_PREFIX}${feed.key}`,
      title: feed.title,
      url: feed.key,
      ...(feed.html_url === null ? {} : { htmlUrl: feed.html_url }),
      ...(feed.icon_url === null ? {} : { iconUrl: feed.icon_url }),
      // One folder per feed in this model, so the list has at most one entry.
      categories:
        feed.folder === null
          ? []
          : [{ id: `${LABEL_PREFIX}${feed.folder}`, label: feed.folder }],
    }));
  }

  async tags(): Promise<Tag[]> {
    const folders = await this.store.folders();
    return folders.map((folder) => ({ id: `${LABEL_PREFIX}${folder.key}`, type: "folder" }));
  }

  /**
   * Unread totals, in the spelling the sidebar asks for: one row per feed, one
   * per label, and the reading list's own total.
   *
   * A feed with nothing stored is listed with a zero, because "subscribed and
   * empty" is a fact about that feed and the sidebar draws it as one. A label is
   * the sum of its feeds, which is what a server computes too.
   */
  async unreadCounts(): Promise<UnreadCount[]> {
    const [feeds, folders, counts] = await Promise.all([
      this.store.feeds(),
      this.store.folders(),
      this.store.counts(),
    ]);

    const byFeed = new Map(counts.map((count) => [count.feedUrl, count]));
    const rows: UnreadCount[] = [];
    let total = 0;
    let newest: number | null = null;

    for (const feed of feeds) {
      const count = byFeed.get(feed.key);
      const unread = count?.count ?? 0;
      total += unread;
      if (count?.newestPublished != null && (newest === null || count.newestPublished > newest)) {
        newest = count.newestPublished;
      }
      rows.push({
        id: `${FEED_PREFIX}${feed.key}`,
        count: unread,
        ...(count?.newestPublished == null
          ? {}
          : { newestItemTimestampUsec: usec(count.newestPublished) }),
      });
    }

    for (const folder of folders) {
      const members = feeds.filter((feed) => feed.folder === folder.key);
      const unread = members.reduce((sum, feed) => sum + (byFeed.get(feed.key)?.count ?? 0), 0);
      rows.push({ id: `${LABEL_PREFIX}${folder.key}`, count: unread });
    }

    rows.push({
      id: READING_LIST,
      count: total,
      ...(newest === null ? {} : { newestItemTimestampUsec: usec(newest) }),
    });
    return rows;
  }

  async stream(streamId: string, options: StreamOptions = {}): Promise<StreamContents> {
    if (abandoned(options.signal)) throw cancelled();

    const query = await this.queryFor(streamId, options);
    const page = await this.store.queryEntries(query);

    // The caller may have moved on while the page was being assembled; handing
    // it a page it has already dropped is wasted work, not a lie, but the
    // signal was given for a reason.
    if (abandoned(options.signal)) throw cancelled();

    const feeds = new Map((await this.store.feeds()).map((feed) => [feed.key, feed]));
    const contents: StreamContents = {
      id: streamId,
      // GReader stamps a stream with when it was assembled. There is nothing to
      // ask here, so it is now — the one honest answer available.
      updated: Math.floor(Date.now() / 1000),
      items: page.entries.map((row) => toStreamItem(row, feeds.get(row.feed))),
    };
    if (page.continuation !== undefined) contents.continuation = page.continuation;
    return contents;
  }

  /**
   * Which rows a stream id means.
   *
   * The ids are the ones the whole app already speaks, so no translation table
   * is needed anywhere else: `user/-/state/com.google/reading-list`, a
   * `feed/<url>`, a `user/-/label/<name>`, starred and read.
   */
  private async queryFor(streamId: string, options: StreamOptions): Promise<EntryQuery> {
    const page: EntryQuery = {
      count: options.count,
      continuation: options.continuation,
      excludeRead: options.excludeRead,
    };

    if (streamId === READING_LIST) return page;
    if (streamId === STATE_STARRED) return { ...page, starred: true };
    if (streamId === STATE_READ) return { ...page, read: true };

    if (streamId.startsWith(FEED_PREFIX)) {
      const url = streamId.slice(FEED_PREFIX.length);
      if ((await this.store.feed(url)) === null) {
        throw new LocalStorageError(
          `${url} is not subscribed on this device, so it has no stream here`,
        );
      }
      return { ...page, feeds: [url] };
    }

    if (streamId.startsWith(LABEL_PREFIX)) {
      const label = streamId.slice(LABEL_PREFIX.length);
      const folders = await this.store.folders();
      if (!folders.some((folder) => folder.key === label)) {
        throw new LocalStorageError(`There is no label called "${label}" on this device`);
      }
      const feeds = (await this.store.feeds())
        .filter((feed) => feed.folder === label)
        .map((feed) => feed.key);
      return { ...page, feeds };
    }

    throw new LocalStorageError(
      `This device has no stream called "${streamId}". Local mode serves the reading list, ` +
        "starred, read, a feed's own stream and a label's; anything else belongs to a server.",
    );
  }

  async setRead(itemIds: string[], read: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    await this.store.setRead(itemIds, read);
  }

  async setStarred(itemIds: string[], starred: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    await this.store.setStarred(itemIds, starred);
  }

  /**
   * Adds a feed.
   *
   * The folder is created if it is new, so the label a caller subscribes into is
   * a label afterwards. Nothing is fetched: see `LocalStore.subscribe` for why
   * the title may be the host until the feed itself supplies one.
   */
  async subscribe(request: SubscribeRequest): Promise<void> {
    await this.store.subscribe(request.feedUrl, {
      title: request.title,
      folder: request.category ?? null,
    });
  }

  /** Removes a feed. A label or a state stream is not a subscription to remove. */
  async unsubscribe(streamId: string): Promise<void> {
    if (!streamId.startsWith(FEED_PREFIX)) {
      throw new LocalStorageError(
        `Local mode cannot unsubscribe from "${streamId}": only a feed is a subscription here`,
      );
    }
    await this.store.unsubscribe(streamId.slice(FEED_PREFIX.length));
  }

  async moveFeed(request: MoveFeedRequest): Promise<void> {
    if (!request.streamId.startsWith(FEED_PREFIX)) {
      throw new LocalStorageError(
        `Local mode cannot move "${request.streamId}": only a feed sits in a folder`,
      );
    }
    await this.store.moveFeed(
      request.streamId.slice(FEED_PREFIX.length),
      request.to,
      request.from,
    );
  }
}
