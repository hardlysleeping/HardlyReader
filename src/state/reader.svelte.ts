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
  subscribe,
  unsubscribe,
  type Session,
  type StreamItem,
  type Subscription,
  type Tag,
} from "../api/freshrss";
import {
  categoryIdForLabel,
  favoriteIdForLabel,
  getApiState as getApiStateFromServer,
  clampIndentPx,
  getState as getHiddenState,
  setCategoryFavorite as apiSetCategoryFavorite,
  ApiError,
  lockHidden as apiLockHidden,
  setCategoryHidden as apiSetCategoryHidden,
  setHiddenPasscode as apiSetHiddenPasscode,
  unlockHidden as apiUnlockHidden,
  setFavoritesView as apiSetFavoritesView,
  setView as apiSetView,
  SIDEBAR_INDENT_FALLBACK_PX,
  unavailableFavorites,
  unavailableState,
  type FavoriteView,
  type FavoritesState,
  type HiddenCategoriesState,
  type HiddenView,
  type SidebarIndentState,
} from "../api/hardlyread";
import { transport } from "../api/transport";
import { feedMenu, categoryMenu, type MenuAction, type MenuModel, type Point } from "../lib/contextmenu";
import {
  applyFavoritesWrite,
  nextFavoriteView as viewAfter,
  withCategoryFavorite,
  withFavoritesView,
  type FavoritesWriteOutcome,
} from "./favorites";
import { effectiveView, visibleGroups } from "./hidden";
import { StreamCache } from "./stream-cache";
import {
  arrangeByPins,
  emptyPins,
  nextPinView,
  parsePins,
  withPinned,
  type LocalPins,
  type PinView,
} from "./pins";
import { pruneStreams, readCached, scopeKey, writeCached } from "./persist";
import { applyHiddenWrite, withCategoryHidden, withView, type HiddenWriteOutcome } from "./hidden-write";
import type { WriteOutcome } from "./write";

export const PAGE_SIZE = 50;
/** Cached streams stay usable for a minute; after that they revalidate on open. */
const STREAM_CACHE_TTL_MS = 60_000;
const STREAM_CACHE_MAX = 20;
/** Speculative fetches never exceed this many concurrent requests. */
const PREFETCH_MAX_INFLIGHT = 2;
/** Past this many feeds, categories start folded so the sidebar draws quickly. */
const LARGE_SIDEBAR_FEEDS = 150;

interface DiskStream {
  items: StreamItem[];
  continuation?: string;
}

interface SidebarSnapshot {
  subscriptions: Subscription[];
  tags: Tag[];
  counts: { id: string; count: number }[];
  api?: {
    hiddenCategories: HiddenCategoriesState;
    favorites: FavoritesState;
    sidebarIndent: SidebarIndentState;
  };
}

/** Abort surfaces as a DOMException; it is not an error worth showing. */
function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export interface CategoryGroup {
  id: string;
  label: string;
  feeds: Subscription[];
}

/** What the open menu is about. It decides which items the menu draws. */
type MenuTarget =
  | { kind: "category"; label: string }
  | { kind: "feed"; id: string; title: string };

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

  /** Last lock/unlock message, so a wrong passcode is visible rather than silent. */
  lockNotice = $state<string | null>(null);

  /** Favorite Categories state, from the same `/v1/state` read. */
  favorites = $state<FavoritesState>(unavailableFavorites());
  /** True while a favorite/view write is in flight. */
  favoritesBusy = $state(false);

  /**
   * Pins kept on this device: every feed pin, and category pins when the
   * server has no Favorite Categories to hold them.
   */
  localPins = $state<LocalPins>(emptyPins());

  /** The sidebar band (hidden / lock / pin) folded away, per account. */
  bandCollapsed = $state(false);

  /**
   * Indent chosen in this app. Kept beside the server value instead of over it:
   * the extension's number is the default, a local change wins until cleared.
   */
  localIndentPx = $state<number | null>(null);
  /** Categories folded shut, per account, so a big sidebar stays short. */
  collapsedCategories = $state<Record<string, boolean>>({});

  /**
   * Sidebar feed indentation. Always holds a usable number: the fallback when
   * the extension is absent, the clamped server value when it is not.
   */
  sidebarIndent = $state<SidebarIndentState>({
    available: false,
    px: SIDEBAR_INDENT_FALLBACK_PX,
  });

  /** True while a subscribe or unsubscribe is in flight. */
  feedBusy = $state(false);
  /** Why the last add-feed attempt failed, in the server's words. */
  addFeedError = $state<string | null>(null);

  /**
   * The open row menu, anchored at a viewport point.
   *
   * It lives here rather than in the sidebar because a `position: fixed` menu
   * inside the sidebar would be positioned against that element on narrow
   * layouts, where the sidebar is a transformed drawer. The shell renders it.
   */
  menu = $state<{ x: number; y: number; target: MenuTarget; confirming: boolean } | null>(null);

  /** The items to draw for the open menu, or null when none is open. */
  get menuModel(): MenuModel | null {
    const menu = this.menu;
    if (menu === null) return null;
    return menu.target.kind === "category"
      ? categoryMenu(this.hiddenCategories, menu.target.label, this.isCategoryPinned(menu.target.label))
      : feedMenu(
          menu.target.title,
          menu.confirming,
          this.isFeedPinned(menu.target.id),
          this.sidebarIndent.px,
          this.sidebarIndent.available,
        );
  }

  /** The view the extension is actually applying. */
  get hiddenView(): HiddenView {
    return effectiveView(this.hiddenCategories);
  }

  get hiddenAvailable(): boolean {
    return this.hiddenCategories.available;
  }

  get favoritesAvailable(): boolean {
    return this.favorites.available;
  }

  /** The favorites view the server has stored. */
  get favoriteView(): FavoriteView {
    return this.favorites.view;
  }

  /** What one click on the header's favorites control would ask for. */
  get nextFavoriteView(): FavoriteView {
    return viewAfter(this.favorites.view);
  }

  /** The numeric FreshRSS id behind a GReader label, or null if unknown. */
  categoryId(labelOrStreamId: string): number | null {
    return categoryIdForLabel(this.hiddenCategories, labelOrStreamId);
  }

  /**
   * The numeric id to favorite, from whichever block knows it.
   *
   * The favorites block is authoritative, but a server can report the hidden
   * block and not every category in the favorites one; both describe the same
   * category table, so a miss in one is worth a look in the other.
   */
  favoriteId(labelOrStreamId: string): number | null {
    return (
      favoriteIdForLabel(this.favorites, labelOrStreamId) ??
      categoryIdForLabel(this.hiddenCategories, labelOrStreamId)
    );
  }

  /** True when the server reports this category as a favorite. */
  isFavorite(labelOrStreamId: string): boolean {
    if (!this.favorites.available) return false;
    const id = this.favoriteId(labelOrStreamId);
    return id !== null && this.favorites.ids.includes(id);
  }

  /** Where category pins live: the server's favourites when it has them. */
  get pinSource(): "server" | "local" {
    return this.favorites.available ? "server" : "local";
  }

  isCategoryPinned(label: string): boolean {
    return this.pinSource === "server"
      ? this.isFavorite(label)
      : this.localPins.categories.includes(label);
  }

  isFeedPinned(streamId: string): boolean {
    return this.localPins.feeds.includes(streamId);
  }

  get pinView(): PinView {
    return this.pinSource === "server" ? this.favorites.view : this.localPins.view;
  }

  /** How many categories are pinned, for the status strip. */
  get pinnedCount(): number {
    return this.allCategories.filter((group) => this.isCategoryPinned(group.label)).length +
      this.localPins.feeds.length;
  }

  /** How many categories the extension hides. Never drawn while locked. */
  get hiddenCount(): number {
    return this.hiddenCategories.available ? this.hiddenCategories.hiddenIds.length : 0;
  }

  get hiddenHasPasscode(): boolean {
    return this.hiddenCategories.available && this.hiddenCategories.hasPasscode;
  }

  get hiddenLocked(): boolean {
    return this.hiddenCategories.available && this.hiddenCategories.locked;
  }

  /** Pins or unpins a category on the server when it can, locally otherwise. */
  async setCategoryPinned(label: string, pinned: boolean): Promise<void> {
    if (this.pinSource === "server" && this.favoriteId(label) !== null) {
      await this.setCategoryFavorite(label, pinned);
      return;
    }
    this.updateLocalPins({ categories: withPinned(this.localPins.categories, label, pinned) });
  }

  /**
   * Applies indentation to every feed row. Indent is one global setting in the
   * extension, so this never varies per feed; the choice is remembered here
   * because the adapter has no write route for it yet.
   */
  setSidebarIndentPx(px: number): void {
    const clamped = clampIndentPx(px);
    this.localIndentPx = clamped;
    this.sidebarIndent = { ...this.sidebarIndent, px: clamped };
    this.savePrefs();
  }

  setFeedPinned(streamId: string, pinned: boolean): void {
    this.updateLocalPins({ feeds: withPinned(this.localPins.feeds, streamId, pinned) });
  }

  /** One click on the band's pin control: the next view in the cycle. */
  async cyclePinView(): Promise<void> {
    const next = nextPinView(this.pinView);
    if (this.pinSource === "server") {
      await this.setFavoritesView(next);
      return;
    }
    this.updateLocalPins({ view: next });
  }

  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
    this.savePrefs();
  }

  toggleCategory(id: string): void {
    this.collapsedCategories = { ...this.collapsedCategories, [id]: !this.isCategoryCollapsed(id) };
    this.savePrefs();
  }

  /**
   * Large sidebars start folded: drawing thousands of feed rows is what made a
   * big account slow to show. Small ones start open, as before.
   */
  isCategoryCollapsed(id: string): boolean {
    const stored = this.collapsedCategories[id];
    return stored ?? this.subscriptions.length > LARGE_SIDEBAR_FEEDS;
  }

  /** Server indent, unless this device has its own choice. */
  private withLocalIndent(state: SidebarIndentState): SidebarIndentState {
    return this.localIndentPx === null ? state : { ...state, px: this.localIndentPx };
  }

  private updateLocalPins(change: Partial<LocalPins>): void {
    this.localPins = { ...this.localPins, ...change };
    this.savePrefs();
  }

  private prefsKey(): string | null {
    const session = this.session;
    return session === null ? null : `hardlyreader:prefs:${session.serverUrl}|${session.email}`;
  }

  private loadPrefs(): void {
    const key = this.prefsKey();
    if (key === null || typeof localStorage === "undefined") return;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
      this.localPins = parsePins(raw?.pins);
      this.bandCollapsed = raw?.bandCollapsed === true;
      const indent = raw?.indentPx;
      this.localIndentPx =
        typeof indent === "number" && Number.isFinite(indent) ? clampIndentPx(indent) : null;
      if (this.localIndentPx !== null) {
        this.sidebarIndent = { ...this.sidebarIndent, px: this.localIndentPx };
      }
      const collapsed = raw?.collapsed;
      this.collapsedCategories =
        typeof collapsed === "object" && collapsed !== null ? (collapsed as Record<string, boolean>) : {};
    } catch {
      this.localPins = emptyPins();
    }
  }

  private savePrefs(): void {
    const key = this.prefsKey();
    if (key === null || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          pins: this.localPins,
          bandCollapsed: this.bandCollapsed,
          collapsed: this.collapsedCategories,
          indentPx: this.localIndentPx,
        }),
      );
    } catch {
      /* storage full or blocked: preferences just do not persist */
    }
  }

  /** Opens the menu for a category row. Does nothing without the extension. */
  openCategoryMenu(label: string, point: Point): void {
    this.menu = { x: point.x, y: point.y, target: { kind: "category", label }, confirming: false };
  }

  /** Opens the menu for a feed row: removal, and the confirmation of it. */
  openFeedMenu(feed: { id: string; title: string }, point: Point): void {
    this.menu = {
      x: point.x,
      y: point.y,
      target: { kind: "feed", id: feed.id, title: feed.title },
      confirming: false,
    };
  }

  closeCategoryMenu(): void {
    this.menu = null;
  }

  /**
   * Runs one menu item.
   *
   * Anything that writes closes the menu first, so the row's new state is
   * visible without anything on top of it — the change is optimistic either
   * way. Asking to remove a feed does not write: it swaps the menu into its
   * confirmation step, which is the point of a confirmation step.
   */
  async applyMenuAction(action: MenuAction): Promise<WriteOutcome<HiddenCategoriesState | FavoritesState> | null> {
    const menu = this.menu;
    if (menu === null) return null;
    const target = menu.target;

    switch (action.type) {
      case "confirm-remove":
        this.menu = { ...menu, confirming: true };
        return null;
      case "cancel-remove":
        this.menu = { ...menu, confirming: false };
        return null;
      case "remove-feed": {
        this.menu = null;
        if (target.kind !== "feed") return null;
        await this.removeFeed(target.id);
        return null;
      }
      case "hidden":
        this.menu = null;
        return target.kind === "category" ? this.setCategoryHidden(target.label, action.hidden) : null;
      case "pin":
        this.menu = null;
        if (target.kind === "category") await this.setCategoryPinned(target.label, action.pinned);
        else this.setFeedPinned(target.id, action.pinned);
        return null;
      case "indent":
        // Indent is applied live from the slider and leaves the menu open, so
        // this only exists to keep the union total.
        this.setSidebarIndentPx(action.px);
        return null;
    }
  }

  /**
   * Locks the curtain, locally first.
   *
   * The lock is a single flag: setting it here makes the sidebar drop the
   * hidden categories and every hint about them immediately, then the server
   * is told. If the server refuses (no passcode) the flag rolls back and the
   * reason is shown, rather than the UI lying until the next refresh.
   */
  async lockHidden(): Promise<void> {
    const session = this.session;
    if (session === null || !this.hiddenAvailable || this.hiddenBusy) return;

    const previous = this.hiddenCategories;
    this.hiddenBusy = true;
    this.lockNotice = null;
    this.hiddenCategories = { ...previous, locked: true };
    try {
      const result = await apiLockHidden(transport, session);
      this.hiddenCategories = result.hiddenCategories;
      this.lockNotice = null;
    } catch (error) {
      this.hiddenCategories = previous;
      this.lockNotice =
        error instanceof ApiError ? error.message : "Could not lock. Nothing was changed.";
    } finally {
      this.hiddenBusy = false;
    }
  }

  /**
   * Unlocks with a passcode. Deliberately not optimistic: unlocking without
   * checking the code would be a cosmetic lock.
   */
  async unlockHidden(passcode: string): Promise<boolean> {
    const session = this.session;
    if (session === null || !this.hiddenAvailable || this.hiddenBusy) return false;

    this.hiddenBusy = true;
    this.lockNotice = null;
    try {
      const result = await apiUnlockHidden(transport, session, passcode);
      this.hiddenCategories = result.hiddenCategories;
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        // A wrong code still reports authoritative state; take it.
        if (error.state !== null) {
          this.hiddenCategories = error.state;
        }
        this.lockNotice = error.code === "wrong_passcode" ? "Wrong passcode." : error.message;
      } else {
        this.lockNotice = "Could not unlock. Check your connection.";
      }
      return false;
    } finally {
      this.hiddenBusy = false;
    }
  }

  /** Sets or clears the passcode. Empty input disables locking entirely. */
  async setHiddenPasscode(passcode: string): Promise<boolean> {
    const session = this.session;
    if (session === null || !this.hiddenAvailable || this.hiddenBusy) return false;

    this.hiddenBusy = true;
    this.lockNotice = null;
    try {
      const result = await apiSetHiddenPasscode(transport, session, passcode);
      this.hiddenCategories = result.hiddenCategories;
      return true;
    } catch (error) {
      this.lockNotice = error instanceof ApiError ? error.message : "Could not save the passcode.";
      return false;
    } finally {
      this.hiddenBusy = false;
    }
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

  /**
   * Favorites or unfavorites one category: optimistically, then against the
   * server.
   *
   * `changed: false` is a success — the server was already in that state — so
   * it is drawn exactly like a change and reported to nobody.
   */
  async setCategoryFavorite(label: string, favorite: boolean): Promise<FavoritesWriteOutcome | null> {
    const session = this.session;
    const id = this.favoriteId(label);
    if (session === null || id === null || !this.favoritesAvailable || this.favoritesBusy) return null;

    this.favoritesBusy = true;
    try {
      const outcome = await applyFavoritesWrite(
        this.favorites,
        withCategoryFavorite(this.favorites, id, favorite),
        (next) => {
          this.favorites = next;
        },
        () => apiSetCategoryFavorite(transport, session, id, favorite),
      );
      this.settleFavorites(outcome);
      return outcome;
    } finally {
      this.favoritesBusy = false;
    }
  }

  /** Switches the favorites view: optimistically, then against the server. */
  async setFavoritesView(view: FavoriteView): Promise<FavoritesWriteOutcome | null> {
    const session = this.session;
    if (session === null || !this.favoritesAvailable || this.favoritesBusy) return null;

    this.favoritesBusy = true;
    try {
      const outcome = await applyFavoritesWrite(
        this.favorites,
        withFavoritesView(this.favorites, view),
        (next) => {
          this.favorites = next;
        },
        () => apiSetFavoritesView(transport, session, view),
      );
      this.settleFavorites(outcome);
      return outcome;
    } finally {
      this.favoritesBusy = false;
    }
  }

  /** One click on the header control: the next view in the cycle. */
  async cycleFavoritesView(): Promise<FavoritesWriteOutcome | null> {
    return this.setFavoritesView(viewAfter(this.favorites.view));
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
    return arrangeByPins(
      visibleGroups(this.allCategories, this.hiddenCategories),
      this.pinView,
      (label) => this.isCategoryPinned(label),
      (id) => this.isFeedPinned(id),
    );
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
    this.loadPrefs();
    // Paint what we had last time before asking the network for anything.
    await this.hydrateSidebar();
    await Promise.all([this.loadSidebar(), this.openStream(READING_LIST, "Reading list")]);
  }

  private diskKey(name: string): string | null {
    const session = this.session;
    return session === null ? null : scopeKey(session.serverUrl, session.email, name);
  }

  private async hydrateSidebar(): Promise<void> {
    const key = this.diskKey("sidebar");
    if (key === null) return;
    const cached = await readCached<SidebarSnapshot>(key);
    if (cached === undefined || this.subscriptions.length > 0) return;
    const snapshot = cached.value;
    this.subscriptions = snapshot.subscriptions;
    this.tags = snapshot.tags;
    this.setCounts(snapshot.counts);
    if (snapshot.api !== undefined) {
      this.hiddenCategories = snapshot.api.hiddenCategories;
      this.favorites = snapshot.api.favorites;
      this.sidebarIndent = this.withLocalIndent(snapshot.api.sidebarIndent);
    }
  }

  private persistSidebar(counts: { id: string; count: number }[]): void {
    const key = this.diskKey("sidebar");
    if (key === null) return;
    void writeCached<SidebarSnapshot>(key, {
      subscriptions: this.subscriptions,
      tags: this.tags,
      counts,
      api: {
        hiddenCategories: this.hiddenCategories,
        favorites: this.favorites,
        sidebarIndent: this.sidebarIndent,
      },
    });
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
    this.favorites = unavailableFavorites();
    this.favoritesBusy = false;
    this.sidebarIndent = { available: false, px: SIDEBAR_INDENT_FALLBACK_PX };
    this.feedBusy = false;
    this.addFeedError = null;
    this.menu = null;
    this.localPins = emptyPins();
    this.bandCollapsed = false;
    this.collapsedCategories = {};
  }

  async loadSidebar(): Promise<void> {
    if (!this.session) return;
    try {
      const [subscriptions, tags, counts] = await Promise.all([
        listSubscriptions(transport, this.session),
        listTags(transport, this.session),
        getUnreadCounts(transport, this.session),
        // Never throws; an install without the extension is not an error.
        this.loadApiState(),
      ]);
      this.subscriptions = subscriptions;
      this.tags = tags;
      this.setCounts(counts);
      this.persistSidebar(counts);
    } catch (error) {
      this.error = message(error);
    }
  }

  /**
   * Reads every extension block: hidden categories, favorites, sidebar indent.
   *
   * One request, because the extension builds all three from the same user
   * configuration and three calls could each see a different snapshot.
   *
   * Deliberately does not touch `error`: a missing extension, a 409 or a 401
   * here must not take over the sidebar, and the GReader calls already report
   * a dead token.
   */
  async loadApiState(): Promise<void> {
    if (!this.session) return;
    try {
      const state = await getApiStateFromServer(transport, this.session);
      this.hiddenCategories = state.hiddenCategories;
      this.favorites = state.favorites;
      this.sidebarIndent = this.withLocalIndent(state.sidebarIndent);
      this.hiddenError = null;
    } catch (error) {
      this.hiddenCategories = unavailableState();
      this.favorites = unavailableFavorites();
      this.sidebarIndent = { available: false, px: SIDEBAR_INDENT_FALLBACK_PX };
      this.hiddenError = message(error);
    }
  }

  /**
   * Reads hidden-categories state alone, for callers that only want that.
   *
   * Kept separate from `loadApiState` because a hidden-categories refresh must
   * not silently overwrite favorites the user just changed.
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

  /**
   * Subscribes to a feed URL, then re-reads the subscription list.
   *
   * No title is sent: FreshRSS takes the feed's own, and inventing one here
   * would leave the sidebar showing a name the server never agreed to. The
   * server's own error text is kept for the form to show — `HttpError` already
   * carries it.
   */
  async addFeed(url: string): Promise<boolean> {
    const session = this.session;
    const feedUrl = url.trim();
    if (session === null || this.feedBusy) return false;
    if (feedUrl === "") {
      this.addFeedError = "Enter a feed URL first.";
      return false;
    }

    this.feedBusy = true;
    this.addFeedError = null;
    try {
      await subscribe(transport, session, feedUrl);
      await this.loadSidebar();
      return true;
    } catch (error) {
      this.addFeedError = message(error);
      return false;
    } finally {
      this.feedBusy = false;
    }
  }

  /** Drops a stale add-feed error, e.g. when the form is reopened or closed. */
  clearAddFeedError(): void {
    this.addFeedError = null;
  }

  /**
   * Unsubscribes a feed, then re-reads the subscription list.
   *
   * If the removed feed was the open stream, the reading list takes its place:
   * leaving the app pointed at a stream that no longer exists would only
   * produce an error banner on the next reload.
   */
  async removeFeed(streamId: string): Promise<boolean> {
    const session = this.session;
    if (session === null || this.feedBusy) return false;

    this.feedBusy = true;
    try {
      await unsubscribe(transport, session, streamId);
      await this.loadSidebar();
      if (this.activeStream === streamId) {
        await this.openStream(READING_LIST, "Reading list");
      }
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    } finally {
      this.feedBusy = false;
    }
  }

  /**
   * Articles already fetched, keyed by stream.
   *
   * Switching category or feed used to wait for a round-trip every time, which is
   * what made the sidebar feel slow. A cached stream paints immediately and is
   * revalidated in the background, so the common case costs nothing.
   */
  private streamCache = new StreamCache(STREAM_CACHE_TTL_MS, STREAM_CACHE_MAX);
  /** Only the newest load may paint; older responses are dropped. */
  private streamToken = 0;
  private inFlight = new Map<string, AbortController>();

  /** Measured, not guessed: the last stream load, and where it came from. */
  lastStreamMs = $state(0);
  lastStreamSource = $state<"cache" | "network">("network");

  private rememberStream(stream: string, items: StreamItem[], continuation: string | undefined): void {
    this.streamCache.set(stream, items, continuation);
    const key = this.diskKey(`stream:${stream}`);
    const prefix = this.diskKey("stream:");
    if (key === null || prefix === null) return;
    void writeCached<DiskStream>(key, { items, continuation }).then(() => pruneStreams(prefix));
  }

  /** Keeps the cache in step after a local edit (read, star, page load). */
  private cacheActiveStream(): void {
    if (this.activeStream !== "") this.rememberStream(this.activeStream, this.items, this.continuation);
  }

  /**
   * Warm a stream before it is opened. Best effort: never throws, never more than
   * a couple of requests in flight.
   */
  prefetchStream(streamId: string): void {
    if (!this.session || streamId === "" || streamId === this.activeStream) return;
    if (this.inFlight.size >= PREFETCH_MAX_INFLIGHT) return;
    if (this.streamCache.fresh(streamId) !== undefined) return;
    if (this.inFlight.has(streamId)) return;
    const session = this.session;
    const controller = new AbortController();
    this.inFlight.set(streamId, controller);
    void getStreamContents(transport, session, streamId, { count: PAGE_SIZE, signal: controller.signal })
      .then((page) => this.rememberStream(streamId, page.items, page.continuation))
      .catch(() => {
        /* prefetch is speculative: a failure is not worth showing anyone */
      })
      .finally(() => {
        if (this.inFlight.get(streamId) === controller) this.inFlight.delete(streamId);
      });
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

  async reloadStream(options: { force?: boolean } = {}): Promise<void> {
    if (!this.session) return;
    const stream = this.activeStream;
    const token = ++this.streamToken;

    let cached = this.streamCache.peek(stream);
    if (cached === undefined) {
      // Never show one stream's articles under another's title, even for the
      // few milliseconds a disk read takes.
      if (this.items.length > 0) {
        this.items = [];
        this.continuation = undefined;
      }
      this.loadingList = true;
      // Not in memory this session: the disk may still have it from last time.
      const key = this.diskKey(`stream:${stream}`);
      const disk = key === null ? undefined : await readCached<DiskStream>(key);
      if (token !== this.streamToken || this.activeStream !== stream) return;
      if (disk !== undefined) {
        this.streamCache.set(stream, disk.value.items, disk.value.continuation);
        // Seeded from disk: paint now, but always revalidate.
        cached = { ...disk.value, at: 0 };
      }
    }
    const fresh = this.streamCache.fresh(stream) !== undefined && cached?.at !== 0;
    if (cached !== undefined) {
      this.items = cached.items;
      this.continuation = cached.continuation;
    } else if (this.items.length > 0) {
      // Switching to a stream we have never loaded: drop the previous stream's
      // articles now. Leaving them on screen under the new title reads as "the
      // click did nothing" until the response lands.
      this.items = [];
      this.continuation = undefined;
    }
    if (fresh && options.force !== true) {
      this.loadingList = false;
      this.error = null;
      this.lastStreamSource = "cache";
      return;
    }

    // A cached stream revalidates silently; only a cold one shows the spinner.
    this.loadingList = cached === undefined;
    this.error = null;
    this.inFlight.get(stream)?.abort();
    const controller = new AbortController();
    this.inFlight.set(stream, controller);
    const started = performance.now();
    try {
      const page = await getStreamContents(transport, this.session, stream, {
        count: PAGE_SIZE,
        signal: controller.signal,
      });
      if (token !== this.streamToken || this.activeStream !== stream) return;
      this.items = page.items;
      this.continuation = page.continuation;
      this.rememberStream(stream, page.items, page.continuation);
      this.lastStreamSource = "network";
      this.lastStreamMs = Math.round(performance.now() - started);
    } catch (error) {
      if (token !== this.streamToken || aborted(error)) return;
      this.error = message(error);
      if (cached === undefined) this.items = [];
    } finally {
      if (this.inFlight.get(stream) === controller) this.inFlight.delete(stream);
      if (token === this.streamToken) this.loadingList = false;
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
        this.cacheActiveStream();
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
        this.cacheActiveStream();
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

  /** The same rule for favorites: reconcile silently, report a real failure. */
  private settleFavorites(outcome: FavoritesWriteOutcome): void {
    if (outcome.kind === "failed") this.error = outcome.message;
  }

  dismissError(): void {
    this.error = null;
  }
}

export const reader = new ReaderState();
