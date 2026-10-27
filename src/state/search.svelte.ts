/**
 * The sidebar's search box.
 *
 * Two modes, and the difference is where the text comes from:
 *
 * - Titles (default) are already in memory. Matching is instant and costs
 *   nothing, so it happens on every keystroke.
 * - Post text is not in memory, so it is extracted once per feed, written to
 *   IndexedDB, and reused. That work only starts when the toggle is ticked —
 *   typing must never be the thing that fires forty requests.
 *
 * The index is per account and refreshes after `FRESH_MS`, so a feed you have not
 * opened in a while is re-read the next time deep search is switched on.
 */
import { getStreamContents, type Session, type Subscription } from "../api/freshrss";
import { transport } from "../api/transport";
import { extractText, normalise } from "../lib/search";
import { readCached, scopeKey, writeCached } from "./persist";

const PREF_KEY = "hardlyreader.search.v1";

/** Re-read a feed's text after this long. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/** How many posts per feed are worth keeping for a hint. */
const POSTS_PER_FEED = 12;

/** Characters kept per post, and per feed, so the index cannot run away. */
const CHARS_PER_POST = 700;

export interface IndexedPost {
  id: string;
  title: string;
  text: string;
}

export interface FeedTextEntry {
  posts: IndexedPost[];
  at: number;
}

class SearchState {
  query = $state("");

  /**
   * Search inside posts as well as names. Off by default: it is the expensive
   * half, and a feed list is normally navigated by name.
   */
  deep = $state(false);

  /** Feeds indexed so far, while a run is in progress. */
  progress = $state<{ done: number; total: number } | null>(null);

  /** Extracted text by feed id, for this session. */
  index = $state<Record<string, FeedTextEntry>>({});

  private controller: AbortController | null = null;
  private running = false;

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as { deep?: unknown };
      if (typeof saved.deep === "boolean") this.deep = saved.deep;
    } catch {
      // A corrupt preference is not worth a dialog.
    }
  }

  setQuery(query: string): void {
    this.query = query;
  }

  clear(): void {
    this.query = "";
  }

  /**
   * Turn post-text search on or off.
   *
   * Turning it on starts the extraction in the background. Turning it off
   * abandons any run in progress and keeps what was already indexed, so the next
   * tick does not start from nothing.
   */
  async setDeep(on: boolean, feeds: readonly Subscription[], session: Session | null): Promise<void> {
    if (this.deep === on) return;
    this.deep = on;
    this.save();
    if (on) await this.refresh(feeds, session);
    else this.cancel();
  }

  /** Whether post text is searched. The only search setting that travels. */
  snapshot(): Record<string, unknown> {
    return { deep: this.deep };
  }

  /** Takes the account's copy, ignoring a value that is not a boolean. */
  adopt(value: Record<string, unknown>): void {
    if (typeof value.deep === "boolean" && value.deep !== this.deep) {
      this.deep = value.deep;
      this.save();
    }
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ deep: this.deep }));
    } catch {
      // Best effort: the choice still applies for this session.
    }
  }

  private cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.progress = null;
  }

  private keyFor(session: Session, feedId: string): string {
    return scopeKey(session, `feedtext:${feedId}`);
  }

  /**
   * Bring the index up to date: load what is on disk, then fetch whatever is
   * missing or stale, two feeds at a time.
   *
   * Bounded on purpose — a large account must not turn one tick into a hundred
   * parallel requests, and stopping half way is fine because the next tick
   * continues from what is stored.
   */
  async refresh(feeds: readonly Subscription[], session: Session | null): Promise<void> {
    if (session === null || this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const missing: Subscription[] = [];
      for (const feed of feeds) {
        const stored = this.index[feed.id] ?? (await this.readFromDisk(session, feed.id));
        if (stored !== undefined && Date.now() - stored.at < FRESH_MS) {
          this.index[feed.id] = stored;
        } else {
          missing.push(feed);
        }
        if (controller.signal.aborted) return;
      }

      this.progress = { done: 0, total: missing.length };
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < missing.length && !controller.signal.aborted) {
          const feed = missing[cursor++];
          const entry = await this.fetchText(session, feed, controller.signal);
          if (entry !== null) {
            this.index[feed.id] = entry;
            void writeCached(this.keyFor(session, feed.id), entry);
          }
          this.progress = { done: (this.progress?.done ?? 0) + 1, total: missing.length };
        }
      };
      await Promise.all([worker(), worker()]);
    } finally {
      this.running = false;
      if (this.controller === controller) this.controller = null;
      this.progress = null;
    }
  }

  private async readFromDisk(session: Session, feedId: string): Promise<FeedTextEntry | undefined> {
    const cached = await readCached<FeedTextEntry>(this.keyFor(session, feedId));
    return cached?.value;
  }

  private async fetchText(
    session: Session,
    feed: Subscription,
    signal: AbortSignal,
  ): Promise<FeedTextEntry | null> {
    try {
      const page = await getStreamContents(transport, session, feed.id, {
        count: POSTS_PER_FEED,
        signal,
      });
      const posts = page.items.slice(0, POSTS_PER_FEED).map((item) => ({
        id: item.id,
        title: item.title ?? "",
        text: extractText(item.content?.content ?? item.summary?.content, CHARS_PER_POST),
      }));
      if (posts.length === 0) return null;
      return { posts, at: Date.now() };
    } catch {
      // A feed that will not load is simply not indexed; it still matches by name.
      return null;
    }
  }

  /** True when a feed has text available to search. */
  hasText(feedId: string): boolean {
    return this.index[feedId] !== undefined;
  }

  /** How many feeds have text, for the honest "searched N of M" line. */
  indexedCount(): number {
    return Object.keys(this.index).length;
  }

  /** The post whose text matched, for the row's second line. */
  matchIn(feedId: string, query: string): IndexedPost | null {
    const q = normalise(query).trim();
    if (q === "") return null;
    const entry = this.index[feedId];
    if (entry === undefined) return null;
    return (
      entry.posts.find(
        (post) => normalise(post.text).includes(q) || normalise(post.title).includes(q),
      ) ?? null
    );
  }
}

export const search = new SearchState();
search.load();
