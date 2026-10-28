/**
 * What the reader needs from wherever the articles come from.
 *
 * The app reads one shape of thing — subscriptions, labels, streams of items,
 * read/starred flags — and until now it got them by calling the GReader
 * functions in `freshrss.ts` directly from the store. That made the transport
 * detail (a server URL, an API prefix, an auth token, a write token fetched
 * before every edit) inseparable from the reading UI.
 *
 * This is the seam. A backend answers the same questions no matter whether the
 * answers came from a server over HTTP or from a database on this device, and
 * the store is meant to hold one of these instead of knowing which.
 *
 * Two rules keep the seam honest:
 *
 * 1. **The types are the existing ones.** `Subscription`, `StreamItem` and the
 *    rest are the GReader vocabulary the whole app already renders — not a new
 *    model to translate into. A local backend produces exactly these, so a row
 *    drawn from SQLite and a row drawn from FreshRSS are the same object.
 * 2. **Ids stay strings, in GReader's spelling.** `feed/<url>`,
 *    `user/-/label/<name>`, `user/-/state/com.google/read`. Every store, every
 *    preference key and every extension call already speaks that dialect; a
 *    local backend that invented its own ids would need a translation layer
 *    everywhere else.
 *
 * Nothing here is implemented yet beyond `GReaderBackend`, which delegates to
 * the existing functions and therefore changes no behaviour. `LocalBackend` is
 * the other side of the seam and is not written.
 */
import type {
  Session,
  StreamContents,
  StreamItem,
  StreamOptions,
  Subscription,
  Tag,
  UnreadCount,
  UserInfo,
} from "./freshrss";

/** Which side of the seam answered. Used for labels and for capability checks. */
export type BackendKind = "greader" | "local";

export interface SubscribeRequest {
  feedUrl: string;
  /** Overrides the feed's own title; omit to keep it. */
  title?: string;
  /** Category label to file it under; omit for Uncategorized. */
  category?: string;
}

export interface MoveFeedRequest {
  streamId: string;
  /** The label it should end up in, or null for Uncategorized. */
  to: string | null;
  /** The label it is in now, so it can be removed in the same request. */
  from: string | null;
}

/**
 * Everything the reading UI asks of a source.
 *
 * Deliberately small: it is the set of operations the reader actually performs,
 * not the union of GReader's API. Anything a backend cannot honour must reject
 * with an error the UI can show, never resolve to something plausible — a lie
 * about a read mark is worse than a failure.
 */
export interface ReaderBackend {
  readonly kind: BackendKind;

  /**
   * What this backend can store itself.
   *
   * Optional and partial on purpose: a backend that says nothing is treated as a plain GReader
   * service (feeds, folders, read, stars — and nothing extended), which is the safe default for a
   * server we have not measured. `src/lib/capabilities.ts` is what turns this into a decision about
   * where a feature's truth lives; see `docs/authority.md` for why the decision is per feature
   * rather than per profile.
   */
  readonly capabilities?: Partial<import("../lib/capabilities").Capabilities>;

  /** The account behind this backend, for the header and the account panel. */
  profile(): Promise<UserInfo>;

  subscriptions(): Promise<Subscription[]>;
  tags(): Promise<Tag[]>;
  unreadCounts(): Promise<UnreadCount[]>;

  /**
   * One page of one stream. `streamId` is a GReader stream id, including the
   * synthetic ones the app builds for its own lists.
   */
  stream(streamId: string, options?: StreamOptions): Promise<StreamContents>;

  setRead(itemIds: string[], read: boolean): Promise<void>;
  setStarred(itemIds: string[], starred: boolean): Promise<void>;

  subscribe(request: SubscribeRequest): Promise<void>;
  unsubscribe(streamId: string): Promise<void>;
  moveFeed(request: MoveFeedRequest): Promise<void>;

  /**
   * Fetches whatever has been published since this backend last looked.
   *
   * Optional because a server crawls on its own: a FreshRSS backend has nothing
   * to fetch, and pretending otherwise would make every client poll on behalf of
   * a crawler that is already doing it. A local library has no crawler behind
   * it, so it is the crawler, and this is the call that runs it.
   */
  fetchNew?(options?: {
    wake?: "launch" | "resume" | "background" | "manual";
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/** The items a stream page carries, for callers that only want those. */
export function itemsOf(page: StreamContents): StreamItem[] {
  return page.items ?? [];
}

/** A backend built from a signed-in session, whoever is going to serve it. */
export type BackendFactory = (session: Session) => ReaderBackend;
