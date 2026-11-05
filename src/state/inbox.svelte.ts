/**
 * The inbox, as Settings draws it.
 *
 * `api/messages.ts` is the two calls; this file is what a screen needs around
 * them: the list, how many are unread, and one honest status. It is small on
 * purpose — a message is not a feed, and nothing here fetches on launch.
 *
 * Four rules, each one a way this could be wrong:
 *
 * 1. **Nothing loads until a screen asks.** No launch call, no timer, no push.
 *    The only thing that ever asks is the section that lists them, so an app
 *    nobody has opened Settings in costs exactly zero requests.
 * 2. **A signed-out device has no inbox.** Messages are addressed to an account,
 *    so with no account there is nothing to fetch and nothing to show — not an
 *    error, and not an empty list claiming "no messages".
 * 3. **The last list is kept for this account, and read before the network.** A
 *    reader who opens Settings on a train still sees yesterday's message about
 *    the outage; the fetch then replaces it. The cache is keyed by user id and
 *    is dropped when the account changes, so one reader's messages never draw
 *    for another.
 * 4. **Read is local first and the server catches up.** Opening the list is what
 *    marks it read — there is no per-message button to miss — so the count
 *    clears under the finger, and the server records the same ids afterwards.
 *    A failed record leaves them read on this device, which is what the reader
 *    has already seen.
 *
 * The cache is a copy of a server answer, never a second source of truth: a
 * message deleted on the server disappears at the next successful load.
 */

import { identity, identityConfig, type Identity, type KeyStore } from "../api/identity";
import {
  INBOX_APP,
  listMessages,
  markRead,
  type InboxMessage,
  type MessageFetch,
} from "../api/messages";

/** Where one account's last list lives. The user id is appended. */
export const INBOX_CACHE_PREFIX = "hardlyreader.inbox.v1";

/** `loading` while a call is out; `failed` only when there is nothing to draw. */
export type InboxStatus = "idle" | "loading" | "ready" | "failed";

/** The project, and the seam. Everything has a default, so the app passes none. */
export interface InboxOptions {
  /** Who is signed in, and the token to ask with. Defaults to the app's identity. */
  readonly identity?: Pick<Identity, "userId" | "token">;
  /** The project this build was configured with, or null. */
  readonly server?: () => { url: string; anonKey: string } | null;
  /** Injected by the suite; the app uses `fetch`. */
  readonly request?: MessageFetch;
  /** The account's own storage. Null is a suite's memory. */
  readonly storage?: KeyStore | null;
  /** The clock, for the millisecond a message is marked read at. */
  readonly now?: () => number;
}

/** The device's own storage, or null where there is none. Same rule as the identity's. */
function deviceKeys(): KeyStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Newest first. The server already sorts; this holds the cache to the same order. */
function newestFirst(messages: readonly InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => (a.publishedAt === b.publishedAt ? 0 : b.publishedAt - a.publishedAt));
}

/** A parsed cache entry, or null when it is not one for this account. */
function readCache(storage: KeyStore | null, userId: string): InboxMessage[] | null {
  if (storage === null) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(`${INBOX_CACHE_PREFIX}.${userId}`);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw) as { userId?: unknown; messages?: unknown };
    // The key says whose list this is; the value says it again. Both, always.
    if (saved.userId !== userId || !Array.isArray(saved.messages)) return null;
    const messages: InboxMessage[] = [];
    for (const entry of saved.messages) {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.body !== "string") return null;
      if (typeof row.publishedAt !== "number") return null;
      const readAt = row.readAt === null || typeof row.readAt === "number" ? row.readAt : null;
      messages.push({ id: row.id, title: row.title, body: row.body, publishedAt: row.publishedAt, readAt });
    }
    return newestFirst(messages);
  } catch {
    return null;
  }
}

export class Inbox {
  private readonly seam: Pick<Identity, "userId" | "token">;
  private readonly project: () => { url: string; anonKey: string } | null;
  private readonly request: MessageFetch | undefined;
  private readonly keys: KeyStore | null;
  private readonly clock: () => number;
  /** The account whose list is in `messages` right now. */
  private loadedFor: string | null = null;
  /** The call that is out, so two presses share one request. */
  private pending: Promise<void> | null = null;

  /** What the section draws. Empty while signed out, and while nothing asked. */
  messages = $state<InboxMessage[]>([]);
  status = $state<InboxStatus>("idle");
  /** A sentence when something is off — including "this is the last copy". */
  reason = $state<string | null>(null);

  constructor(options: InboxOptions = {}) {
    this.seam = options.identity ?? identity;
    this.project = options.server ?? identityConfig;
    this.request = options.request;
    this.keys = options.storage === undefined ? deviceKeys() : options.storage;
    this.clock = options.now ?? Date.now;
  }

  /** Who this inbox belongs to, or null when the device is signed out. */
  get userId(): string | null {
    return this.seam.userId;
  }

  /** Whether a device that is signed out should draw nothing at all. */
  get signedIn(): boolean {
    return this.seam.userId !== null && this.seam.token !== null;
  }

  /** How many messages this account has not opened yet. The bell's dot. */
  get unread(): number {
    return this.messages.filter((message) => message.readAt === null).length;
  }

  /**
   * This account's messages, newest first.
   *
   * Reads the last copy first when the account has changed (so a cached list
   * appears at once), then asks the server whatever the answer. A failure keeps
   * the cached list and says so; with no cached list it is `failed` with the
   * reason, never an empty `ready`.
   *
   * One call at a time: the Settings sheet asks for the count and the list asks
   * again when it is opened, and a second request for the same list on the same
   * press is a request nobody asked for.
   */
  async load(): Promise<void> {
    if (this.pending !== null) return await this.pending;
    this.pending = this.fetchAndDraw();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async fetchAndDraw(): Promise<void> {
    const userId = this.seam.userId;
    const token = this.seam.token;
    if (userId === null || token === null) {
      this.messages = [];
      this.status = "ready";
      this.reason = null;
      this.loadedFor = null;
      return;
    }

    if (this.loadedFor !== userId) {
      const cached = readCache(this.keys, userId);
      this.messages = cached ?? [];
      this.loadedFor = userId;
    }

    const project = this.project();
    if (project === null) {
      this.status = "failed";
      this.reason = "this build has no account service, so there are no messages to ask for";
      return;
    }

    this.status = "loading";
    const answer = await listMessages(
      {
        url: project.url,
        anonKey: project.anonKey,
        token,
        ...(this.request === undefined ? {} : { request: this.request }),
      },
      INBOX_APP,
    );

    // Signed out or switched while the call was out: that answer is not this screen's.
    if (this.seam.userId !== userId) return;

    if (answer.ok) {
      this.messages = newestFirst(answer.messages);
      this.status = "ready";
      this.reason = null;
      this.remember(userId);
      return;
    }

    this.reason = answer.reason;
    if (this.messages.length > 0) {
      // The last copy is a real answer, and saying so is better than a blank list.
      this.status = "ready";
      this.reason = `${answer.reason} — showing the messages this device last saw`;
    } else {
      this.status = "failed";
    }
  }

  /**
   * Marks everything on screen read, locally first.
   *
   * Called when the list is opened, so there is nothing for the reader to press.
   * The ids are then recorded on the server; a refusal leaves the device's own
   * copy read, because the reader has seen these words either way.
   */
  async readAll(): Promise<void> {
    const unread = this.messages.filter((message) => message.readAt === null);
    if (unread.length === 0) return;
    const at = this.clock();
    this.messages = this.messages.map((message) =>
      message.readAt === null ? { ...message, readAt: at } : message,
    );
    const userId = this.seam.userId;
    if (userId !== null) this.remember(userId);

    const project = this.project();
    const token = this.seam.token;
    if (project === null || token === null) return;
    await markRead(
      {
        url: project.url,
        anonKey: project.anonKey,
        token,
        ...(this.request === undefined ? {} : { request: this.request }),
      },
      unread.map((message) => message.id),
      INBOX_APP,
    );
  }

  /** Writes this account's list where the next opening reads it. Best effort. */
  private remember(userId: string): void {
    if (this.keys === null) return;
    try {
      this.keys.setItem(
        `${INBOX_CACHE_PREFIX}.${userId}`,
        JSON.stringify({ userId, messages: this.messages }),
      );
    } catch {
      // A full or refused store costs the cache, never the screen.
    }
  }
}

/** The app's one inbox. A build with no project simply never fills it. */
export const inbox = new Inbox();
