/**
 * The backend that talks to a GReader server — FreshRSS, Miniflux, Tiny Tiny
 * RSS, The Old Reader.
 *
 * It owns no logic. Every method is the existing function in `freshrss.ts` with
 * the transport, the session and the write-token dance already supplied, so
 * putting this in front of the store cannot change a single request: the URLs,
 * the bodies and the error types are the ones that were already there.
 *
 * That is deliberate. The seam has to be provably behaviour-free before a second
 * implementation of it exists, otherwise a difference in what the reader shows
 * could belong to either change.
 */
import {
  editTag,
  getStreamContents,
  getUnreadCounts,
  listSubscriptions,
  listTags,
  moveFeed,
  STATE_READ,
  STATE_STARRED,
  subscribe,
  unsubscribe,
  userInfo,
  type Session,
  type StreamContents,
  type StreamOptions,
  type Subscription,
  type Tag,
  type Transport,
  type UnreadCount,
  type UserInfo,
} from "./freshrss";
import type { MoveFeedRequest, ReaderBackend, SubscribeRequest } from "./backend";

export class GReaderBackend implements ReaderBackend {
  readonly kind = "greader" as const;

  // Plain fields rather than constructor parameter properties: the unit suites
  // run under Node's strip-only TypeScript, which cannot compile the latter.
  private readonly transport: Transport;
  private readonly session: Session;

  constructor(transport: Transport, session: Session) {
    this.transport = transport;
    this.session = session;
  }

  profile(): Promise<UserInfo> {
    return userInfo(this.transport, this.session);
  }

  subscriptions(): Promise<Subscription[]> {
    return listSubscriptions(this.transport, this.session);
  }

  tags(): Promise<Tag[]> {
    return listTags(this.transport, this.session);
  }

  unreadCounts(): Promise<UnreadCount[]> {
    return getUnreadCounts(this.transport, this.session);
  }

  stream(streamId: string, options: StreamOptions = {}): Promise<StreamContents> {
    return getStreamContents(this.transport, this.session, streamId, options);
  }

  /**
   * One request for the whole batch, which is what `edit-tag` is for.
   *
   * Read and starred are two separate tag lists on purpose: passing the wrong
   * one as `remove` un-stars an article the reader meant to mark read, and that
   * mistake is invisible until it is noticed days later.
   */
  async setRead(itemIds: string[], read: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    await editTag(this.transport, this.session, read
      ? { itemIds, add: [STATE_READ] }
      : { itemIds, remove: [STATE_READ] });
  }

  async setStarred(itemIds: string[], starred: boolean): Promise<void> {
    if (itemIds.length === 0) return;
    await editTag(this.transport, this.session, starred
      ? { itemIds, add: [STATE_STARRED] }
      : { itemIds, remove: [STATE_STARRED] });
  }

  subscribe(request: SubscribeRequest): Promise<void> {
    return subscribe(this.transport, this.session, request.feedUrl, request.title, request.category);
  }

  unsubscribe(streamId: string): Promise<void> {
    return unsubscribe(this.transport, this.session, streamId);
  }

  moveFeed(request: MoveFeedRequest): Promise<void> {
    return moveFeed(this.transport, this.session, request.streamId, request.to, request.from);
  }
}
