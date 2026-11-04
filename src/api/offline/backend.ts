/**
 * A server account, with a queue behind it.
 *
 * The reading UI asks whoever serves the account; for a FreshRSS in the world
 * that is `GReaderBackend`. This sits in front of one and changes exactly one
 * thing: **a mark is written here, not to the server**. The reader's press lands
 * on the device at once, and the request happens when there is a network to carry
 * it. Browsing with the tailnet down therefore reads like browsing with it up:
 * posts mark themselves, the list moves, and nothing is rolled back because the
 * train went into a tunnel.
 *
 * Everything else is passed through untouched — the subscriptions, the tags, the
 * counts, a page of a stream, adding and removing feeds. Reads are not cached
 * here: the app already paints its last sidebar and its last pages from disk
 * before asking (`state/persist.ts`), and the text of a post that was read comes
 * from `lib/article-cache`. A second cache in the middle would be a second answer
 * to "what did the server say", and the two would disagree within a week.
 *
 * Three rules keep the queue honest:
 *
 * 1. **The queue is the reader's, and it is drawn.** A page that arrives while a
 *    mark is still queued is painted with the queued mark, not with the server's
 *    older one: the reader's press is newer than the answer that has not heard
 *    about it. (`overlay` below.)
 * 2. **A write that cannot be stored is not swallowed.** If the queue cannot be
 *    written — a locked database, no disk — the mark goes to the server the old
 *    way, and fails the old way, with a banner. A quiet "saved" that is neither
 *    stored nor sent would be the one unacceptable outcome.
 * 3. **A failure is either worth retrying or not.** A connection that never
 *    reached the server, a 5xx, a 429 or an expired token is retried later (the
 *    last of those rarely: a token does not heal by waiting, it heals by signing
 *    in). A 4xx that names the request is not retried — the server looked at it
 *    and refused — and the mark is dropped rather than looping forever.
 */
import type { ReaderBackend, BackendKind, WriteStatus } from "../backend";
import {
  AuthError,
  HttpError,
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
import type { MoveFeedRequest, SubscribeRequest } from "../backend";
import type { PendingMark, WriteJournal } from "./journal";
import { withState } from "../../lib/marks";

/** How long a queue that met a network failure is left alone. */
const RETRY_MS = 20_000;

/** How long after the server refused the credential. Signing in clears it sooner. */
const AUTH_RETRY_MS = 300_000;

export interface OfflineBackendOptions {
  /** The queue this account writes into. Owned by the caller, so a switch can keep it. */
  journal: WriteJournal;
  now?: () => number;
  retryMs?: number;
  authRetryMs?: number;
  /**
   * Whether a press asks the server straight away when the last attempt worked.
   *
   * True everywhere in the app: online, the queue is emptied in the background as
   * fast as the reader fills it, and nothing on screen waits for that. A suite
   * turns it off to drive the queue by hand and see what it holds — the behaviour
   * a reader gets is the other one.
   */
  autoFlush?: boolean;
}

/**
 * Why a flush ended where it did.
 *
 * `landed` is an empty queue at the end; `idle` is an empty queue at the start —
 * no request was made. `waiting` is the backoff a failed attempt left behind, and
 * the three failures say what was met: a network that never became a request
 * (`unreached`), a server whose credential is dead, and a request the server
 * looked at and refused.
 */
export type FlushStop = "landed" | "idle" | "waiting" | "unreached" | "unauthorised" | "refused";

export interface FlushReport {
  /** How many marks reached the server and left the queue. */
  sent: number;
  /** Why the flush ended early, when it did. */
  stop: FlushStop;
  /** Marks the server refused outright, now dropped. */
  refused: PendingMark[];
}

/** The per-item answer about one register, as a map the overlay can ask. */
function valuesFor(journal: WriteJournal, kind: "read" | "starred"): Map<string, boolean> {
  return journal.values(kind);
}

export class OfflineBackend implements ReaderBackend {
  readonly kind: BackendKind;

  private readonly inner: ReaderBackend;
  private readonly journal: WriteJournal;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly authRetryMs: number;
  private readonly autoFlush: boolean;

  /** No flush is started before this moment, ms. Cleared by a forced flush. */
  private retryAt = 0;
  private flushing: Promise<FlushReport> | null = null;
  /** What the last flush ended with, for the readout and for the suite. */
  lastFlush: FlushReport = { sent: 0, stop: "idle", refused: [] };

  /**
   * Present only when the backend underneath has one.
   *
   * `Main` reads it to decide whether a pull has anyone to fetch for: a server
   * crawls its own feeds, and a wrapper that always offered `refresh` would make
   * every server account look like a local library and stall the launch on a
   * fetch nobody asked for.
   */
  fetchNew?: ReaderBackend["fetchNew"];

  constructor(inner: ReaderBackend, options: OfflineBackendOptions) {
    this.inner = inner;
    this.kind = inner.kind;
    this.journal = options.journal;
    this.now = options.now ?? (() => Date.now());
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.authRetryMs = options.authRetryMs ?? AUTH_RETRY_MS;
    this.autoFlush = options.autoFlush ?? true;
    if (typeof inner.fetchNew === "function") {
      this.fetchNew = async (options) => {
        // The reader's marks go first: a fetch that runs before them stores what
        // the server thought before the reader spoke, which is yesterday's answer
        // arriving last. A server backend has no `fetchNew` — its crawler does
        // the fetching — so this is the local-library shape, kept honest here.
        await this.flush();
        return inner.fetchNew!(options);
      };
    }
  }

  /** How many decisions the server has not been told about. */
  get pending(): number {
    return this.journal.size;
  }

  async profile(): Promise<UserInfo> {
    const value = await this.inner.profile();
    this.nudge();
    return value;
  }

  async subscriptions(): Promise<Subscription[]> {
    const value = await this.inner.subscriptions();
    this.nudge();
    return value;
  }

  async tags(): Promise<Tag[]> {
    const value = await this.inner.tags();
    this.nudge();
    return value;
  }

  async unreadCounts(): Promise<UnreadCount[]> {
    const value = await this.inner.unreadCounts();
    this.nudge();
    return value;
  }

  async stream(streamId: string, options: StreamOptions = {}): Promise<StreamContents> {
    const page = await this.inner.stream(streamId, options);
    this.nudge();
    return this.overlay(page);
  }

  /**
   * Queues the mark. Resolves as soon as the device has it.
   *
   * The write to the server happens in the background and is not this call's
   * business: a reader who marks a post read has finished that action, and
   * making them wait on a round trip is how the list used to stall.
   */
  async setRead(itemIds: string[], read: boolean): Promise<void> {
    await this.queue("read", itemIds, read);
  }

  async setStarred(itemIds: string[], starred: boolean): Promise<void> {
    await this.queue("starred", itemIds, starred);
  }

  subscribe(request: SubscribeRequest): Promise<void> {
    return this.inner.subscribe(request);
  }

  unsubscribe(streamId: string): Promise<void> {
    return this.inner.unsubscribe(streamId);
  }

  moveFeed(request: MoveFeedRequest): Promise<void> {
    return this.inner.moveFeed(request);
  }

  /**
   * Sends what the queue holds, oldest first.
   *
   * Marks are batched by register and by value, because that is the shape
   * `edit-tag` takes: one request can carry twenty posts marked read, and it is
   * twenty requests' worth of latency that a reconnect does not have to spend.
   * A flush is never run twice at once, and a queue with nothing to say costs no
   * request at all. The answer is how many marks now live on the server;
   * `lastFlush` says how the attempt ended.
   *
   * `force` skips the backoff — that is what the network coming back is, and what
   * a launch is: an event that says the reason for waiting has changed.
   */
  async flush(force = false): Promise<number> {
    if (this.flushing !== null) return (await this.flushing).sent;
    if (!force && this.now() < this.retryAt) {
      this.lastFlush = { sent: 0, stop: "waiting", refused: [] };
      return 0;
    }
    this.flushing = this.runFlush().finally(() => {
      this.flushing = null;
    });
    return (await this.flushing).sent;
  }

  /**
   * What the queue holds, for a page the backend did not return.
   *
   * `overlay` covers every page this backend hands out. A page restored from the
   * reader's own disk cache never passes through here, so the reader asks this
   * instead — same registers, same "the reader's press is newer" rule.
   */
  async pendingMarks(): Promise<{ read: Map<string, boolean>; starred: Map<string, boolean> }> {
    await this.journal.open();
    return { read: valuesFor(this.journal, "read"), starred: valuesFor(this.journal, "starred") };
  }

  /**
   * The queue for the readout beside sync: how many, and how the last attempt went.
   *
   * `idle` — no attempt this session — is reported as `null` rather than as
   * success, because "nothing has been tried" and "the last try worked" are
   * different facts and only one of them is worth drawing as settled.
   */
  async writeStatus(): Promise<WriteStatus> {
    await this.journal.open();
    return {
      pending: this.journal.size,
      last: this.lastFlush.stop === "idle" ? null : this.lastFlush.stop,
    };
  }

  /** The marks a page should be painted with, applied to the server's page. */
  private overlay(page: StreamContents): StreamContents {
    const read = valuesFor(this.journal, "read");
    const starred = valuesFor(this.journal, "starred");
    if (read.size === 0 && starred.size === 0) return page;
    let changed = false;
    const items: StreamItem[] = page.items.map((item) => {
      const wantsRead = read.get(item.id);
      const wantsStarred = starred.get(item.id);
      if (wantsRead === undefined && wantsStarred === undefined) return item;
      const before = item.categories ?? [];
      const after = withState(withState(before, STATE_READ, wantsRead), STATE_STARRED, wantsStarred);
      if (after.length === before.length && after.every((category, at) => category === before[at])) return item;
      changed = true;
      return { ...item, categories: after };
    });
    return changed ? { ...page, items } : page;
  }

  private async queue(kind: "read" | "starred", itemIds: string[], value: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    try {
      await this.journal.record(kind, itemIds, value);
    } catch (error) {
      // No queue on this device: the mark goes to the server the way it always
      // did, failure and banner included. Losing it silently is not an option.
      if (kind === "read") await this.inner.setRead(itemIds, value);
      else await this.inner.setStarred(itemIds, value);
      return;
    }
    this.nudge();
  }

  /** Tries the queue after a request that got through, without waiting for it. */
  private nudge(): void {
    if (!this.autoFlush) return;
    if (this.journal.size === 0) return;
    if (this.now() < this.retryAt) return;
    void this.flush().catch(() => {
      /* a flush reports its own outcome; nothing here may reach the reader */
    });
  }

  private async runFlush(): Promise<FlushReport> {
    // A queue read from a previous launch is sent by this launch's first flush.
    await this.journal.open();
    let sent = 0;
    const refused: PendingMark[] = [];
    for (const batch of batches(this.journal.entries())) {
      try {
        if (batch.kind === "read") await this.inner.setRead(batch.itemIds, batch.value);
        else await this.inner.setStarred(batch.itemIds, batch.value);
      } catch (error) {
        const verdict = verdictFor(error);
        if (verdict === "refused") {
          // The server looked at this request and said no. Asking again would ask
          // the same question forever, so the marks go and the report says so.
          refused.push(...batch.marks);
          await this.journal.forget(batch.marks);
          continue;
        }
        this.retryAt = this.now() + (verdict === "unauthorised" ? this.authRetryMs : this.retryMs);
        this.lastFlush = { sent, stop: verdict === "unauthorised" ? "unauthorised" : "unreached", refused };
        return this.lastFlush;
      }
      await this.journal.forget(batch.marks);
      sent += batch.itemIds.length;
    }
    this.retryAt = 0;
    // A pass that sent nothing because every mark in it was refused is not a
    // landing: the report says which marks the server would not take.
    this.lastFlush = { sent, stop: refused.length > 0 ? "refused" : "landed", refused };
    return this.lastFlush;
  }
}

/** One `edit-tag` call's worth of marks: same register, same value. */
interface Batch {
  kind: "read" | "starred";
  value: boolean;
  itemIds: string[];
  marks: PendingMark[];
}

/**
 * The queue as requests.
 *
 * Grouped by register and value rather than by adjacent entries, because a
 * reader scrolling a list produces one interruptible stream of `read: true` and
 * the batching has to survive the odd star in the middle. Order inside a batch is
 * the order the marks were made, which is what the server's own log reads best.
 */
export function batches(marks: readonly PendingMark[]): Batch[] {
  const groups = new Map<string, Batch>();
  for (const mark of marks) {
    const key = `${mark.kind}\u0000${mark.value}`;
    const held = groups.get(key);
    if (held === undefined) {
      groups.set(key, { kind: mark.kind, value: mark.value, itemIds: [mark.itemId], marks: [mark] });
    } else {
      held.itemIds.push(mark.itemId);
      held.marks.push(mark);
    }
  }
  return [...groups.values()];
}

/**
 * Whether a failed write is worth trying again.
 *
 * `unauthorised` is kept apart from `retry` because the wait is different and the
 * reason is not the network: the token died, and a queue that retried it every
 * twenty seconds would knock on a door that is not going to open.
 */
export function verdictFor(error: unknown): "retry" | "unauthorised" | "refused" {
  if (error instanceof AuthError) return "unauthorised";
  if (error instanceof HttpError) {
    if (error.status === 429 || error.status >= 500) return "retry";
    return "refused";
  }
  // Anything else is a connection that never became a request: fetch's own
  // TypeError, the Tauri http plugin's network error, an abort. All of them are
  // the reason this queue exists.
  return "retry";
}
