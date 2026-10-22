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
import {
  categoryIdForLabel,
  getState as getHiddenState,
  setCategoryHidden as apiSetCategoryHidden,
  setView as apiSetView,
  unavailableState,
  type HiddenCategoriesState,
  type HiddenView,
} from "../api/hardlyread";
import { transport } from "../api/transport";
import { categoryMenu, type MenuAction, type MenuModel, type Point } from "../lib/contextmenu";
import { effectiveView, visibleGroups } from "./hidden";
import { applyHiddenWrite, withCategoryHidden, withView, type HiddenWriteOutcome } from "./hidden-write";

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

  /**
   * Hidden Categories state from the HardlyRead v1 API.
   *
   * Starts as "not available" and stays that way when the extension is absent,
   * which is what every ordinary FreshRSS install looks like.
   */
  hiddenCategories = $state<HiddenCategoriesState>(unavailableState());
  /** Why the state could not be read. Kept apart from `error`: no extension is
   * a normal install, not a failure worth a banner. */
  hiddenError = $state<string | null>(null);

  /** True while a hide/show/view write is in flight. */
  hiddenBusy = $state(false);

  /**
   * The open category menu, anchored at a viewport point.
   *
   * It lives here rather than in the sidebar because a `position: fixed` menu
   * inside the sidebar would be positioned against that element on narrow
   * layouts, where the sidebar is a transformed drawer. The shell renders it.
   */
  menu = $state<{ x: number; y: number; label: string } | null>(null);

  /** The items to draw for the open menu, or null when none is open. */
  get menuModel(): MenuModel | null {
    if (this.menu === null) return null;
    return categoryMenu(this.hiddenCategories, this.menu.label);
  }

  /** The view the extension is actually applying. */
  get hiddenView(): HiddenView {
    return effectiveView(this.hiddenCategories);
  }

  get hiddenAvailable(): boolean {
    return this.hiddenCategories.available;
  }

  /** The numeric FreshRSS id behind a GReader label, or null if unknown. */
  categoryId(labelOrStreamId: string): number | null {
    return categoryIdForLabel(this.hiddenCategories, labelOrStreamId);
  }

  /** Opens the menu for a category row. Does nothing without the extension. */
  openCategoryMenu(label: string, point: Point): void {
    if (!this.hiddenAvailable) return;
    this.menu = { x: point.x, y: point.y, label };
  }

  closeCategoryMenu(): void {
    this.menu = null;
  }

  /**
   * Runs one menu item and closes the menu.
   *
   * The menu closes before the write so the row's new state is visible without
   * anything on top of it — the change is optimistic either way.
   */
  async applyMenuAction(action: MenuAction): Promise<HiddenWriteOutcome | null> {
    const label = this.menu?.label;
    this.menu = null;
    if (label === undefined) return null;
    return action.type === "hidden"
      ? this.setCategoryHidden(label, action.hidden)
      : this.setHiddenView(action.view);
  }

  /** Hides or shows one category: optimistically, then against the server. */
  async setCategoryHidden(label: string, hidden: boolean): Promise<HiddenWriteOutcome | null> {
    const session = this.session;
    const id = this.categoryId(label);
    if (session === null || id === null || this.hiddenBusy) return null;

    this.hiddenBusy = true;
    try {
      const outcome = await applyHiddenWrite(
        this.hiddenCategories,
        withCategoryHidden(this.hiddenCategories, id, hidden),
        (next) => {
          this.hiddenCategories = next;
        },
        () => apiSetCategoryHidden(transport, session, id, hidden),
      );
      this.settleHidden(outcome);
      return outcome;
    } finally {
      this.hiddenBusy = false;
    }
  }

  /** Switches the hidden-categories view: optimistically, then against the server. */
  async setHiddenView(view: HiddenView): Promise<HiddenWriteOutcome | null> {
    const session = this.session;
    if (session === null || !this.hiddenAvailable || this.hiddenBusy) return null;

    this.hiddenBusy = true;
    try {
      const outcome = await applyHiddenWrite(
        this.hiddenCategories,
        withView(this.hiddenCategories, view),
        (next) => {
          this.hiddenCategories = next;
        },
        () => apiSetView(transport, session, view),
      );
      this.settleHidden(outcome);
      return outcome;
    } finally {
      this.hiddenBusy = false;
    }
  }

  get selected(): StreamItem | null {
    return this.items.find((item) => item.id === this.selectedId) ?? null;
  }

  /**
   * Every category the server reported, unfiltered. Hidden ones are still in
   * here: GReader cannot tell "hidden" from "deleted", so the extension state
   * is the only way to know, and `categories` applies it.
   */
  get allCategories(): CategoryGroup[] {
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

  /** The sidebar's categories, with the hidden-categories view applied. */
  get categories(): CategoryGroup[] {
    return visibleGroups(this.allCategories, this.hiddenCategories);
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
    this.hiddenCategories = unavailableState();
    this.hiddenError = null;
    this.hiddenBusy = false;
    this.menu = null;
  }

  async loadSidebar(): Promise<void> {
    if (!this.session) return;
    try {
      const [subscriptions, tags, counts] = await Promise.all([
        listSubscriptions(transport, this.session),
        listTags(transport, this.session),
        getUnreadCounts(transport, this.session),
        // Never throws; an install without the extension is not an error.
        this.loadHiddenState(),
      ]);
      this.subscriptions = subscriptions;
      this.tags = tags;
      this.setCounts(counts);
    } catch (error) {
      this.error = message(error);
    }
  }

  /**
   * Reads hidden-categories state.
   *
   * Deliberately does not touch `error`: a missing extension, a 409 or a 401
   * here must not take over the sidebar, and the GReader calls already report
   * a dead token.
   */
  async loadHiddenState(): Promise<void> {
    if (!this.session) return;
    try {
      this.hiddenCategories = await getHiddenState(transport, this.session);
      this.hiddenError = null;
    } catch (error) {
      this.hiddenCategories = unavailableState();
      this.hiddenError = message(error);
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

  /**
   * Surfaces the failures the user has to know about.
   *
   * A reconciled write says nothing: the state it returned is already drawn, so
   * the row moving is the message. A stateless failure rolled nothing back for
   * a reason, and that reason belongs in the banner.
   */
  private settleHidden(outcome: HiddenWriteOutcome): void {
    if (outcome.kind === "failed") this.error = outcome.message;
  }

  dismissError(): void {
    this.error = null;
  }
}

export const reader = new ReaderState();
