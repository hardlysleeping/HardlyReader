import { SvelteMap } from "svelte/reactivity";

import {
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
  editTag,
  getStreamContents,
  getUnreadCounts,
  isRead,
  isStarred,
  listSubscriptions,
  listTags,
  type Session,
  type StreamItem,
  type Subscription,
  type Tag,
} from "../api/freshrss";
import { transport } from "../api/transport";

export const PAGE_SIZE = 50;

export interface CategoryGroup {
  id: string;
  label: string;
  feeds: Subscription[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Labels on an item that correspond to a category stream. */
function itemCategories(item: StreamItem): string[] {
  return (item.categories ?? []).filter((c) => c.startsWith("user/-/label/"));
}

export class ReaderState {
  session = $state<Session | null>(null);

  subscriptions = $state<Subscription[]>([]);
  tags = $state<Tag[]>([]);
  counts = new SvelteMap<string, number>();

  items = $state<StreamItem[]>([]);
  continuation = $state<string | undefined>(undefined);
  activeStream = $state(READING_LIST);
  activeTitle = $state("Reading list");
  selectedId = $state<string | null>(null);

  loadingList = $state(false);
  loadingMore = $state(false);
  busyItems = new SvelteMap<string, boolean>();
  error = $state<string | null>(null);

  get selected(): StreamItem | null {
    return this.items.find((item) => item.id === this.selectedId) ?? null;
  }

  get categories(): CategoryGroup[] {
    const groups = new Map<string, CategoryGroup>();
    for (const feed of this.subscriptions) {
      const cats = feed.categories?.length
        ? feed.categories
        : [{ id: "user/-/label/Uncategorized", label: "Uncategorized" }];
      for (const category of cats) {
        const group = groups.get(category.id) ?? {
          id: category.id,
          label: category.label,
          feeds: [],
        };
        if (!group.feeds.some((entry) => entry.id === feed.id)) {
          group.feeds.push(feed);
        }
        groups.set(category.id, group);
      }
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        feeds: [...group.feeds].sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  countFor(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /** FreshRSS reports unread totals per stream id in one call. */
  private setCounts(entries: { id: string; count: number }[]): void {
    for (const entry of entries) {
      this.counts.set(entry.id, entry.count);
    }
  }

  async start(session: Session): Promise<void> {
    this.session = session;
    this.error = null;
    await Promise.all([this.loadSidebar(), this.openStream(READING_LIST, "Reading list")]);
  }

  stop(): void {
    this.session = null;
    this.subscriptions = [];
    this.tags = [];
    this.counts.clear();
    this.items = [];
    this.selectedId = null;
    this.continuation = undefined;
  }

  async loadSidebar(): Promise<void> {
    if (!this.session) return;
    try {
      const [subscriptions, tags, counts] = await Promise.all([
        listSubscriptions(transport, this.session),
        listTags(transport, this.session),
        getUnreadCounts(transport, this.session),
      ]);
      this.subscriptions = subscriptions;
      this.tags = tags;
      this.setCounts(counts);
    } catch (error) {
      this.error = message(error);
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([this.loadSidebar(), this.reloadStream()]);
  }

  async openStream(streamId: string, title: string): Promise<void> {
    if (this.activeStream === streamId && this.items.length > 0) {
      this.activeTitle = title;
      return;
    }
    this.activeStream = streamId;
    this.activeTitle = title;
    this.selectedId = null;
    await this.reloadStream();
  }

  async reloadStream(): Promise<void> {
    if (!this.session) return;
    this.loadingList = true;
    this.error = null;
    try {
      const page = await getStreamContents(transport, this.session, this.activeStream, {
        count: PAGE_SIZE,
      });
      this.items = page.items;
      this.continuation = page.continuation;
    } catch (error) {
      this.error = message(error);
      this.items = [];
    } finally {
      this.loadingList = false;
    }
  }

  async loadMore(): Promise<void> {
    if (!this.session || !this.continuation || this.loadingMore) return;
    this.loadingMore = true;
    const requested = this.activeStream;
    try {
      const page = await getStreamContents(transport, this.session, requested, {
        count: PAGE_SIZE,
        continuation: this.continuation,
      });
      // Ignore the page if the user switched streams while it was in flight.
      if (this.activeStream === requested) {
        const seen = new Set(this.items.map((item) => item.id));
        this.items = [...this.items, ...page.items.filter((item) => !seen.has(item.id))];
        this.continuation = page.continuation;
      }
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loadingMore = false;
    }
  }

  select(item: StreamItem): void {
    this.selectedId = item.id;
    if (!isRead(item)) {
      void this.setRead(item, true);
    }
  }

  closeReader(): void {
    this.selectedId = null;
  }

  private adjustUnread(item: StreamItem, delta: number): void {
    const streams = [READING_LIST, item.origin?.streamId, ...itemCategories(item)];
    for (const stream of streams) {
      if (!stream) continue;
      const current = this.counts.get(stream);
      if (current === undefined) continue;
      this.counts.set(stream, Math.max(0, current + delta));
    }
  }

  /**
   * Writes read state optimistically, then reconciles with the server.
   *
   * On failure the local change is rolled back rather than left lying: the
   * server is the only source of truth for unread counts.
   */
  async setRead(item: StreamItem, read: boolean): Promise<void> {
    if (!this.session || this.busyItems.get(item.id)) return;
    const wasRead = isRead(item);
    if (wasRead === read) return;

    const previous = item.categories ?? [];
    const next = read
      ? [...previous.filter((c) => c !== STATE_READ), STATE_READ]
      : previous.filter((c) => c !== STATE_READ);

    this.busyItems.set(item.id, true);
    item.categories = next;
    this.adjustUnread(item, read ? -1 : 1);

    try {
      await editTag(transport, this.session, {
        itemIds: [item.id],
        add: read ? [STATE_READ] : [],
        remove: read ? [] : [STATE_READ],
      });
    } catch (error) {
      item.categories = previous;
      this.adjustUnread(item, read ? 1 : -1);
      this.error = message(error);
    } finally {
      this.busyItems.delete(item.id);
    }
  }

  async toggleStar(item: StreamItem): Promise<void> {
    if (!this.session || this.busyItems.get(item.id)) return;
    const starred = isStarred(item);
    const previous = item.categories ?? [];
    const next = starred
      ? previous.filter((c) => c !== STATE_STARRED)
      : [...previous.filter((c) => c !== STATE_STARRED), STATE_STARRED];

    this.busyItems.set(item.id, true);
    item.categories = next;

    try {
      await editTag(transport, this.session, {
        itemIds: [item.id],
        add: starred ? [] : [STATE_STARRED],
        remove: starred ? [STATE_STARRED] : [],
      });
      if (starred && this.activeStream === STATE_STARRED) {
        this.items = this.items.filter((entry) => entry.id !== item.id);
        if (this.selectedId === item.id) this.selectedId = null;
      }
      void this.loadSidebar();
    } catch (error) {
      item.categories = previous;
      this.error = message(error);
    } finally {
      this.busyItems.delete(item.id);
    }
  }

  dismissError(): void {
    this.error = null;
  }
}

export const reader = new ReaderState();
