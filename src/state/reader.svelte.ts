import { SvelteMap } from "svelte/reactivity";

import type { OpmlFeed } from "../lib/opml";
import { addFeedsMessage, parseFeedUrls, type AddFeedsResult } from "../lib/add-feeds";
import { landingItem, step } from "../lib/reading-order";
import { stepIndex } from "../lib/list-view";
import { isNoopDrop, moveInOrder, sortByOrder } from "../lib/feed-order";
import { attemptOrder } from "../lib/stream-cycle";
import { dwellMs, shouldArmDwell, successorId } from "../lib/dwell";
import { SYNC_IDLE, createSyncTracker, type SyncReport, type SyncState } from "../lib/sync-progress";
import { EMPTY_PLACE, parsePlace, placeKey, type Place } from "../lib/place";
import { floods } from "./floods.svelte";
import { theme } from "./theme.svelte";

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
  moveFeed as moveFeedOnServer,
  subscribe,
  unsubscribe,
  type Session,
  type StreamItem,
  type Subscription,
  type Tag,
} from "../api/freshrss";
import {
  LABEL_PREFIX,
  categoryIdForLabel,
  favoriteIdForLabel,
  isHiddenCategory,
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
  setIndent as apiSetIndent,
  setView as apiSetView,
  SIDEBAR_INDENT_FALLBACK_PX,
  SIDEBAR_INDENT_MAX_PX,
  unavailableFavorites,
  unavailableState,
  type FavoriteView,
  type FavoritesState,
  type HiddenCategoriesState,
  type HiddenView,
  reconcilePositions,
  savePositions,
  type PositionsLists,
  type SidebarIndentState,
} from "../api/hardlyread";
import { transport } from "../api/transport";
import { resolveIndent } from "../lib/indent";
import { feedMenu, categoryMenu, type MenuAction, type MenuModel, type Point } from "../lib/contextmenu";
import {
  applyFavoritesWrite,
  nextFavoriteView as viewAfter,
  withCategoryFavorite,
  withFavoritesView,
  type FavoritesWriteOutcome,
} from "./favorites";
import { effectiveView, visibleGroups } from "./hidden";
import { filterByAuthor, filterItems } from "../lib/article-filter";
import { reading } from "./reading.svelte";
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
import { withCategoryHidden, withView, type HiddenWriteOutcome } from "./hidden-write";
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

/**
 * What to say when a lock call fails.
 *
 * `route_not_found` is not the user's problem to decode: it means the deployed
 * extension predates the app's lock route, and the server's own words for that
 * are "Unknown route." — which sounds like the app is broken rather than the
 * server being behind.
 */
export function lockFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === "route_not_found") {
    return "This server's Hardly Read extension has no lock route yet — update the extension on the server.";
  }
  if (error instanceof ApiError) return error.message;
  return "Could not lock. Nothing was changed.";
}

export class ReaderState {
  session = $state<Session | null>(null);

  subscriptions = $state<Subscription[]>([]);
  tags = $state<Tag[]>([]);
  counts = new SvelteMap<string, number>();

  items = $state<StreamItem[]>([]);

  /**
   * The posts the list and continuous reading walk through.
   *
   * Everything that presents or navigates posts reads this, not `items`, or the
   * filter and the ↑/↓ traversal would disagree — you would advance into a post
   * the list is not showing.
   */
  get listItems(): StreamItem[] {
    return filterByAuthor(filterItems(this.items, reading.articleFilter), this.authorFilter);
  }

  /**
   * The author the posts are narrowed to, or null.
   *
   * A filter, not a mode: it narrows the posts already loaded — no request and
   * no re-sort — and it is applied to the list and to ↑/↓ alike through
   * `listItems`. Cleared by the control that set it (the author row's own way
   * back, the field's ×, or turning the toggle off), and never persisted: a
   * narrowed list that came back after a restart would read as a feed that had
   * lost its posts.
   */
  authorFilter = $state<string | null>(null);

  setAuthorFilter(name: string | null): void {
    const trimmed = name === null ? "" : name.trim();
    const next = trimmed === "" ? null : trimmed;
    if (this.authorFilter === next) return;
    this.authorFilter = next;
  }
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
   * Writes are queued instead of dropped.
   *
   * A hide in Strict mode rewrites the priority of every feed in the category,
   * which on a large account takes seconds. The old code refused any second
   * intent while the first was in flight, so the click that would bring the
   * categories back was silently discarded and the reply for the first click
   * repainted the older state — the categories stayed hidden until the user
   * clicked again after the write finished. Now every intent is drawn at once
   * and sent in order, and a token per target makes the newest intent own the
   * screen: a stale reply is discarded rather than drawn.
   */
  private hiddenViewToken = 0;
  private readonly hiddenIdTokens = new Map<number, number>();
  private hiddenChain: Promise<unknown> = Promise.resolve();
  /** Bumped on every intent, so a pending catch-up can tell it is stale. */
  private hiddenWriteGen = 0;
  private hiddenCatchUp: ReturnType<typeof setTimeout> | null = null;

  /** Last lock/unlock message, so a wrong passcode is visible rather than silent. */
  lockNotice = $state<string | null>(null);

  /** Pinned Categories state, from the same `/v1/state` read. */
  favorites = $state<FavoritesState>(unavailableFavorites());
  /** True while a favorite/view write is in flight. */
  favoritesBusy = $state(false);

  /**
   * Pins kept on this device: every feed pin, and category pins when the
   * server has no Pinned Categories to hold them.
   */
  localPins = $state<LocalPins>(emptyPins());

  /**
   * The order the user dragged the feeds into, as a flat list of stream ids.
   *
   * The render source, and per account on this device: the sidebar draws from
   * it before any network exists. FreshRSS itself has no order for feeds inside
   * a category, so the account's copy lives in the adapter's `/v1/positions`
   * document, which follows the drag rather than leading it. Empty until the
   * first drag, which is why the sidebar still reads alphabetically for anyone
   * who never drags anything.
   */
  feedOrder = $state<string[]>([]);

  /**
   * Category ids in the order the user dragged them, top to bottom.
   *
   * Same arrangement as the feeds: FreshRSS has no position for a folder, so
   * the order is this device's to draw and the account's to remember. The pin
   * band still runs first — `arrangeByPins` applies it before the order — so
   * mirroring the list to the server cannot lift a pinned category out of the
   * band. Empty until the first drag: an empty list is not "no order", it is
   * "the alphabet", which is what the sidebar shows.
   */
  categoryOrder = $state<string[]>([]);

  /**
   * The stamp of the arrangement this device holds, in ms; 0 until the first
   * drag. It is what the account's copy is compared against, so it is stored
   * with the order it belongs to rather than recomputed at launch.
   */
  private positionsStamp = 0;

  /**
   * Whether this adapter has `/v1/positions` at all.
   *
   * `missing` is learned once — from the start-time read or from a write that
   * came back 404 — and then no drag sends a request that is known to fail. It
   * resets when the session does, so a server upgraded while the app is closed
   * is picked up on the next launch.
   */
  private positionsRoute: "unknown" | "available" | "missing" = "unknown";

  /**
   * Writes go out in the order the drags happened.
   *
   * Two quick drags fired in parallel can arrive reversed, and the older stamp
   * would then be refused while the newer one is already stored — a 409 the
   * user did nothing to deserve. A chain costs nothing: the sidebar is drawn
   * before any of it starts.
   */
  private positionsChain: Promise<void> = Promise.resolve();

  /** Counts drags, so a refused write can rule out the ones queued behind it. */
  private positionsGeneration = 0;
  /** Every generation up to this one was built from an order that lost. */
  private positionsVoided = 0;

  /**
   * Settles when the start-time read of the account's arrangement has been
   * merged. Nothing on screen waits for it — the sidebar is already drawn from
   * the local copy — but it is awaitable, which is what makes "read once at
   * start" a behaviour a test can observe instead of a hope.
   */
  positionsLanded: Promise<void> = Promise.resolve();

  /** The sidebar band (hidden / lock / pin) folded away, per account. */

  /**
   * Indent chosen in this app. Kept beside the server value instead of over it:
   * the extension's number is the default, a local change wins until cleared.
   */
  localIndentPx = $state<number | null>(null);
  /** Categories folded shut, per account, so a big sidebar stays short. */
  /**
   * In one column, the feed whose posts are unfolded under it.
   *
   * It lives here rather than in the sidebar because the reader replaces the
   * sidebar in that layout: coming back out of an article must land on the feed
   * you were reading, not on a list that has folded itself again.
   */
  expandedFeedId = $state<string | null>(null);

  collapsedCategories = $state<Record<string, boolean>>({});

  /**
   * Sidebar feed indentation. Always holds a usable number: the fallback when
   * the extension is absent, the clamped server value when it is not.
   */
  sidebarIndent = $state<SidebarIndentState>({
    available: false,
    px: SIDEBAR_INDENT_FALLBACK_PX,
    max: SIDEBAR_INDENT_MAX_PX,
  });

  /** Why the last indent write failed, in the server's words. */
  indentError = $state<string | null>(null);

  /** True while a subscribe or unsubscribe is in flight. */
  feedBusy = $state(false);
  /** How far a bulk add has got, so the form can say "Adding 3/12…". */
  feedProgress = $state<{ done: number; total: number } | null>(null);
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
      ? categoryMenu(
          this.hiddenCategories,
          menu.target.label,
          this.isCategoryPinned(menu.target.label),
        )
      : feedMenu(
          menu.target.title,
          menu.confirming,
          this.isFeedPinned(menu.target.id),
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

  /** Whether this category is hidden, per the extension's own state. */
  isCategoryHidden(label: string): boolean {
    return isHiddenCategory(this.hiddenCategories, label);
  }

  /**
   * Whether a category carries the mark — the one mark a category has.
   *
   * One fact, one word: a category is pinned. Where it is stored depends on the
   * server — Pinned Categories keeps it, and with that extension absent the
   * same mark is kept here so the sidebar still works. The extension's own
   * field is still called `favorite`; that is the wire name, not a second
   * meaning.
   */
  isCategoryPinned(label: string): boolean {
    return this.favorites.available ? this.isFavorite(label) : this.localPins.categories.includes(label);
  }

  isFeedPinned(streamId: string): boolean {
    return this.localPins.feeds.includes(streamId);
  }

  /**
   * Which rows the sidebar is showing: all, pinned only, or pinned hidden. This
   * reads the extension's view when it exists — that is a filter over pins, not
   * the storage for a pin, which stays local.
   */
  get pinView(): PinView {
    return this.favorites.available ? this.favorites.view : this.localPins.view;
  }

  /** How many categories carry the mark, for the status strip. */
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

  /**
   * Marks or unmarks a category.
   *
   * One state, written where it can be seen: through Pinned Categories when
   * it is installed, so the FreshRSS website shows the same thing, and on this
   * device when it is not.
   */
  async setCategoryPinned(label: string, pinned: boolean): Promise<void> {
    if (this.favorites.available) {
      await this.setCategoryFavorite(label, pinned);
      return;
    }
    this.updateLocalPins({ categories: withPinned(this.localPins.categories, label, pinned) });
  }

  /**
   * Applies indentation to every feed row, and stores it where the extension
   * keeps it.
   *
   * Dragging a slider produces a value per pixel, so the draw is immediate and
   * the write is debounced: one request per pause, not sixty per drag. The
   * extension owns the setting, so the website's own slider picks up the same
   * number, and this one picks up changes made there on the next read of
   * `/v1/state`.
   *
   * Without the extension there is nowhere to store it, so it stays a local
   * preference — the indent still works on a server that has no extensions.
   */
  setSidebarIndentPx(px: number, flush = false): void {
    const clamped = clampIndentPx(px, this.sidebarIndent.max);
    if (this.sidebarIndent.px !== clamped) {
      this.sidebarIndent = { ...this.sidebarIndent, px: clamped };
      // Kept on every move, not only when the server is out of the picture: a
      // drag that never reaches the server — a request that fails, an app
      // closed inside the debounce — must not leave the setting nowhere.
      this.localIndentPx = clamped;
    }

    if (!this.sidebarIndent.available || this.indentLocalOnly) {
      this.savePrefs();
      return;
    }

    // One write per pause, and one straight away when the pointer is let go:
    // the debounce is for the sixty values in between, not for the last one.
    this.indentUnsent = clamped;
    if (flush) this.flushIndentWrite(clamped);
    else this.scheduleIndentWrite(clamped);
    if (flush) this.savePrefs();
  }

  /**
   * The indent this device set that the server has not accepted yet.
   *
   * Persisted, so a write that never landed — the app closed inside the
   * debounce, a 500, a dropped connection — does not vanish on the next launch:
   * the number is still the reader's, and it is written again as soon as the
   * server answers a state read.
   */
  private indentUnsent: number | null = null;

  /**
   * Set when the server has no write route: the indent stays on this device.
   *
   * Remembered, because forgetting it is what made the number disappear: the
   * server went on reporting its own old value, which then won on every load.
   */
  private indentLocalOnly = false;

  /**
   * True when the indent is this device's alone: no extension to store it, or
   * one whose write route refused. The slider stays usable either way — the
   * indent is a reading preference, not a property of the server.
   */
  get indentDeviceOnly(): boolean {
    return this.indentLocalOnly || !this.sidebarIndent.available;
  }

  private indentTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleIndentWrite(px: number): void {
    if (this.indentTimer !== null) clearTimeout(this.indentTimer);
    const wanted = px;
    this.indentTimer = setTimeout(() => {
      this.indentTimer = null;
      void this.writeIndent(wanted);
    }, 250);
  }

  /**
   * Try the value the server never accepted, now that it is answering again.
   *
   * Called after a state read rather than on a timer: those happen at launch,
   * on every sync and on a change from the website, which is often enough for a
   * setting that is written once per drag.
   */
  private retryUnsentIndent(serverPx: number): void {
    const unsent = this.indentUnsent;
    if (unsent === null || this.indentWriting) return;
    if (!this.sidebarIndent.available || this.indentLocalOnly) return;
    // The write did land and only its answer was lost: nothing left to do.
    if (unsent === serverPx) {
      this.indentUnsent = null;
      this.savePrefs();
      return;
    }
    void this.writeIndent(unsent);
  }

  /** A write is in flight; a retry waits for it rather than racing it. */
  private indentWriting = false;

  /** Write now, and cancel the pending one so it cannot follow with older text. */
  private flushIndentWrite(px: number): void {
    if (this.indentTimer !== null) {
      clearTimeout(this.indentTimer);
      this.indentTimer = null;
    }
    void this.writeIndent(px);
  }

  private async writeIndent(px: number): Promise<void> {
    const session = this.session;
    if (session === null || this.indentWriting) return;
    this.indentWriting = true;
    try {
      const result = await apiSetIndent(transport, session, px);
      // The server clamps; adopt what it stored rather than what was asked for,
      // but never stomp a newer drag that happened while this was in flight.
      if (this.indentUnsent === px) this.indentUnsent = null;
      if (this.sidebarIndent.px === px) {
        this.sidebarIndent = result.sidebarIndent;
      }
      this.localIndentPx = this.sidebarIndent.px;
      this.indentError = null;
      this.savePrefs();
    } catch (error) {
      // A server whose adapter predates the write route answers 404/409. The
      // indent still has to work, so it degrades to this device rather than
      // freezing the slider — and says so instead of looking broken.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        // Stop trying to store it remotely, but keep the control usable.
        this.indentLocalOnly = true;
        this.indentUnsent = null;
        this.localIndentPx = this.sidebarIndent.px;
        this.savePrefs();
        this.indentError = "This server cannot store the indent yet — keeping it on this device.";
        return;
      }
      this.indentError = error instanceof Error ? error.message : String(error);
    } finally {
      this.indentWriting = false;
      this.savePrefs();
    }
  }

  setFeedPinned(streamId: string, pinned: boolean): void {
    this.updateLocalPins({ feeds: withPinned(this.localPins.feeds, streamId, pinned) });
  }

  /** One click on the band's favourites control: the next view in the cycle. */
  async cyclePinView(): Promise<void> {
    const next = nextPinView(this.pinView);
    if (this.favorites.available) {
      await this.setFavoritesView(next);
      return;
    }
    this.updateLocalPins({ view: next });
  }

  setExpandedFeed(id: string | null): void {
    this.expandedFeedId = id;
    this.savePlace();
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

  /**
   * The server's indent, unless the extension is missing.
   *
   * A local override only exists for servers without Sidebar Feed Indent. When
   * the extension is there it is the one store: honouring a stale local number
   * would show one indent in the app and another on the website.
   */
  private withLocalIndent(state: SidebarIndentState): SidebarIndentState {
    // `localOnly` is also true while the last write is still unwritten or
    // failed: what the reader set is what it sees, until the server has it.
    return resolveIndent(
      state,
      this.localIndentPx,
      this.indentLocalOnly || this.indentUnsent !== null || this.indentError !== null,
    );
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
      const order = raw?.order;
      this.feedOrder = Array.isArray(order)
        ? order.filter((entry): entry is string => typeof entry === "string")
        : [];
      const categoryOrder = raw?.categoryOrder;
      this.categoryOrder = Array.isArray(categoryOrder)
        ? categoryOrder.filter((entry): entry is string => typeof entry === "string")
        : [];
      const indent = raw?.indentPx;
      this.localIndentPx =
        typeof indent === "number" && Number.isFinite(indent) ? clampIndentPx(indent) : null;
      this.indentLocalOnly = raw?.indentLocal === true;
      const unsent = raw?.indentUnsent;
      this.indentUnsent =
        typeof unsent === "number" && Number.isFinite(unsent) ? clampIndentPx(unsent) : null;
      if (this.localIndentPx !== null) {
        this.sidebarIndent = { ...this.sidebarIndent, px: this.localIndentPx };
      }
      const collapsed = raw?.collapsed;
      this.collapsedCategories =
        typeof collapsed === "object" && collapsed !== null ? (collapsed as Record<string, boolean>) : {};
      const positionsAt = raw?.positionsAt;
      this.positionsStamp =
        typeof positionsAt === "number" && Number.isFinite(positionsAt) && positionsAt > 0
          ? Math.round(positionsAt)
          : 0;
    } catch {
      this.localPins = emptyPins();
      this.feedOrder = [];
      this.categoryOrder = [];
      this.positionsStamp = 0;
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
          collapsed: this.collapsedCategories,
          indentPx: this.localIndentPx,
          indentLocal: this.indentLocalOnly,
          indentUnsent: this.indentUnsent,
          order: this.feedOrder,
          categoryOrder: this.categoryOrder,
          positionsAt: this.positionsStamp,
        }),
      );
    } catch {
      /* storage full or blocked: preferences just do not persist */
    }
  }

  /* -------------------------------------------------------------------------
   * The arrangement, on the account
   *
   * Local storage stays the render source: what the sidebar draws is what the
   * `categoryOrder`/`feedOrder` arrays say, and a drag changes them and nothing
   * else until the drag is done. The account's `GET`/`PUT /v1/positions` makes
   * a second device agree, which is a different job from drawing the sidebar.
   * Read once at start, written once after a drag — no polling, no per-device
   * clocks, and a server that predates the route costs one 404 and no more.
   * ------------------------------------------------------------------------- */

  /**
   * The two lists this device would send: its own order, cut down to the ids
   * the account actually has.
   *
   * Nothing else travels, and nothing invented: an id that is not in the
   * sidebar is not in the document, because the arrangement is a fact about
   * what the user can see and drag. `null` means there is nothing honest to
   * send — the sidebar has not loaded, so an empty list would say the account
   * has no categories rather than that we have not looked yet.
   */
  private drawnPositions(): PositionsLists | null {
    if (this.subscriptions.length === 0) return null;
    const categoryIds = new Set(this.allCategories.map((group) => group.id));
    const feedIds = new Set(this.subscriptions.map((feed) => feed.id));
    const categories = this.categoryOrder.filter((id) => categoryIds.has(id));
    const feeds = this.feedOrder.filter((id) => feedIds.has(id));
    if (categories.length === 0 && feeds.length === 0) return null;
    return { categories, feeds };
  }

  /**
   * Takes a copy from the account as this device's own: drawn, and stored in
   * the prefs the next start reads before any network call.
   *
   * The shape is spelled out rather than imported: `Positions` lives in
   * `lib/positions`, and a new relative import in this module has to be taught
   * to four suites that transpile it (`reader-state`, `favorites`,
   * `hidden-write`, `menu-render`). It arrives through `../api/hardlyread`,
   * which is already rewritten, and structurally it is the same type.
   */
  private adoptPositions(positions: { updatedAt: number; categories: string[]; feeds: string[] }): void {
    this.categoryOrder = [...positions.categories];
    this.feedOrder = [...positions.feeds];
    this.positionsStamp = positions.updatedAt;
    this.savePrefs();
  }

  /**
   * Reads the account's arrangement once and keeps the newer copy.
   *
   * Behind the first paint on purpose: preferences are loaded and the sidebar
   * is drawn from them, so nothing here is allowed to delay a frame. `404` is
   * an adapter that predates the route — the local order stands and nothing is
   * said, because nothing is wrong. Any other failure is equally quiet: the
   * local arrangement is on screen and it is still true.
   *
   * No write follows this read. If the local copy wins it is already newer than
   * what the server holds, and the next drag sends it up with a newer stamp
   * still — so there is no need to talk to the server twice at launch.
   */
  private async adoptPositionsFromAccount(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    const read = await reconcilePositions(transport, session, {
      updatedAt: this.positionsStamp,
      categories: [...this.categoryOrder],
      feeds: [...this.feedOrder],
    });
    // Signed out, or another account, while the read was in flight.
    if (this.session !== session) return;
    if (read.kind === "missing") {
      this.positionsRoute = "missing";
      return;
    }
    if (read.kind === "failed") return;
    this.positionsRoute = "available";
    if (read.kind === "remote") this.adoptPositions(read.positions);
  }

  /**
   * Sends the arrangement, after the drag has already been drawn and saved.
   *
   * Never before, and never instead of: the arrays are the render source, so a
   * drag costs a repaint and nothing else. Queued rather than fired in
   * parallel, so two drags in a row reach the server in the order they
   * happened and the newest stamp is the last word.
   */
  private sendPositions(): void {
    const session = this.session;
    if (session === null || this.positionsRoute === "missing") return;
    const lists = this.drawnPositions();
    if (lists === null) return;
    const generation = (this.positionsGeneration += 1);
    this.positionsChain = this.positionsChain.then(() => this.writePositions(session, lists, generation));
  }

  private async writePositions(session: Session, lists: PositionsLists, generation: number): Promise<void> {
    if (this.session !== session || this.positionsRoute === "missing") return;
    // A refusal has already ruled against the order this write was built from:
    // sending it now would be the fight the 409 asked us not to have.
    if (generation <= this.positionsVoided) return;
    // What this write is stamped against.
    const previous = this.positionsStamp;
    let write: Awaited<ReturnType<typeof savePositions>>;
    try {
      write = await savePositions(transport, session, lists, previous);
    } catch {
      // Network, auth, a 500: the local order is what the user is looking at
      // and it stays. The next drag sends a newer stamp and carries this one
      // with it, so nothing is retried here.
      return;
    }
    if (this.session !== session) return;
    if (write.kind === "missing") {
      this.positionsRoute = "missing";
      return;
    }
    this.positionsRoute = "available";
    if (write.kind === "stored") {
      this.positionsStamp = Math.max(this.positionsStamp, write.positions.updatedAt);
      this.savePrefs();
      return;
    }

    // Refused: another device arranged this later. Not a fight and not a retry
    // — read the copy that won, adopt it, and drop every drag still queued
    // behind this one: they were built from an order that has just lost, and
    // sending them would take the arrangement back by force. The next drag,
    // after this one is on screen, is the next chance to disagree.
    this.positionsVoided = Math.max(this.positionsVoided, this.positionsGeneration);
    const read = await reconcilePositions(transport, session, { updatedAt: previous, categories: [], feeds: [] });
    if (this.session !== session) return;
    if (read.kind === "remote") this.adoptPositions(read.positions);
  }

  /**
   * Opens the menu for a category row.
   *
   * The hidden state is re-read here rather than trusted: hide/show is the item
   * people reach for from this menu, and a stale `available: false` from a failed
   * state call at sign-in would silently remove it. The read is cheap and the
   * menu is already open by the time it lands.
   */
  openCategoryMenu(label: string, point: Point): void {
    this.menu = { x: point.x, y: point.y, target: { kind: "category", label }, confirming: false };
    // Only when the state is missing: re-reading a state that is already there
    // would put a request behind every right-click.
    if (this.session !== null && !this.hiddenAvailable && !this.hiddenBusy) {
      void this.loadHiddenState();
    }
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
    // Where the menu was: the flood leaves from the point that was clicked, not
    // from the middle of the screen.
    const origin = { x: menu.x, y: menu.y };

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
        if (target.kind !== "category") return null;
        floods.emit(action.hidden ? "hidden" : "revealed", origin);
        return this.setCategoryHidden(target.label, action.hidden);
      case "pin":
        this.menu = null;
        floods.emit(action.pinned ? "pin" : "unpin", origin);
        if (target.kind === "category") {
          await this.setCategoryPinned(target.label, action.pinned);
          return null;
        }
        this.setFeedPinned(target.id, action.pinned);
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
      // Locking hides categories server-side too, so the feed list can change.
      this.hiddenWriteGen += 1;
      this.scheduleHiddenCatchUp();
    } catch (error) {
      this.hiddenCategories = previous;
      this.lockNotice = lockFailure(error);
      // A server that does not know the route is a server whose extension is
      // behind the app. Re-reading its state is how the panel stops offering a
      // passcode it already has, without needing an app restart.
      if (error instanceof ApiError) void this.loadHiddenState();
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
      // No light from here: the band pulses green in place (SidebarBand), which
      // is the app answering rather than the window celebrating.
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        // A wrong code still reports authoritative state; take it.
        if (error.state !== null) {
          this.hiddenCategories = error.state;
        }
        this.lockNotice = error.code === "wrong_passcode" ? "Wrong passcode." : lockFailure(error);
        if (error.code === "route_not_found") void this.loadHiddenState();
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

  /** Hides or shows one category: drawn now, sent in order. */
  async setCategoryHidden(label: string, hidden: boolean): Promise<HiddenWriteOutcome | null> {
    const session = this.session;
    const id = this.categoryId(label);
    if (session === null || id === null || !this.hiddenAvailable) return null;

    const previous = this.hiddenCategories;
    const optimistic = withCategoryHidden(previous, id, hidden);
    if (optimistic === previous) return null;
    this.hiddenCategories = optimistic;

    const token = (this.hiddenIdTokens.get(id) ?? 0) + 1;
    this.hiddenIdTokens.set(id, token);
    this.hiddenWriteGen += 1;

    return this.enqueueHidden(async () => {
      try {
        const result = await apiSetCategoryHidden(transport, session, id, hidden);
        // A newer intent for this category owns the screen; its own reply will
        // settle it, so this one is only good for the error text.
        if (token === this.hiddenIdTokens.get(id)) this.commitHidden(result.hiddenCategories);
        return { kind: "applied", changed: result.changed, state: result.hiddenCategories };
      } catch (error) {
        return this.failHidden(error, token === this.hiddenIdTokens.get(id), previous);
      }
    });
  }

  /** Switches the hidden-categories view: drawn now, sent in order. */
  async setHiddenView(view: HiddenView): Promise<HiddenWriteOutcome | null> {
    const session = this.session;
    if (session === null || !this.hiddenAvailable || this.hiddenCategories.locked) return null;

    const previous = this.hiddenCategories;
    this.hiddenCategories = withView(previous, view);
    const token = ++this.hiddenViewToken;
    this.hiddenWriteGen += 1;

    return this.enqueueHidden(async () => {
      try {
        const result = await apiSetView(transport, session, view);
        if (token === this.hiddenViewToken) this.commitHidden(result.hiddenCategories);
        return { kind: "applied", changed: result.changed, state: result.hiddenCategories };
      } catch (error) {
        return this.failHidden(error, token === this.hiddenViewToken, previous);
      }
    });
  }

  /** Runs hidden writes one at a time, in the order they were asked for. */
  private enqueueHidden<T>(task: () => Promise<T>): Promise<T> {
    const run = this.hiddenChain.then(task, task);
    this.hiddenChain = run.then(
      () => this.scheduleHiddenCatchUp(),
      () => this.scheduleHiddenCatchUp(),
    );
    return run;
  }

  /**
   * Reloads the sidebar once the hidden writes have drained.
   *
   * In Strict mode the extension hides a category by dropping the priority of
   * every feed in it, and the GReader subscription list then stops reporting
   * those feeds. The local rows we drew optimistically are all we have until
   * the server's list is read again, so a "Show" would leave the category with
   * no feeds under it — looking like the unhide had not worked. Light mode only
   * sets the view, so nothing needs re-reading there.
   *
   * Debounced, and skipped if another intent arrived meanwhile: the reply for
   * the newer intent is authoritative and reloading on top of it would fight
   * the optimistic draw.
   */
  private scheduleHiddenCatchUp(): void {
    if (!this.hiddenAvailable || this.hiddenCategories.mode !== "strict") return;
    if (this.hiddenCatchUp !== null) clearTimeout(this.hiddenCatchUp);
    const generation = this.hiddenWriteGen;
    this.hiddenCatchUp = setTimeout(() => {
      this.hiddenCatchUp = null;
      if (generation !== this.hiddenWriteGen) {
        this.scheduleHiddenCatchUp();
        return;
      }
      void this.loadSidebar();
    }, 250);
  }

  /**
   * Draws a state the server just returned.
   *
   * A reply that predates a lock is not allowed to undo it: `locked` is sticky
   * until an explicit unlock answers.
   */
  private commitHidden(state: HiddenCategoriesState): void {
    this.hiddenCategories =
      this.hiddenCategories.locked && !state.locked ? { ...state, locked: true } : state;
  }

  /**
   * The failure half of a hidden write.
   *
   * When a newer intent has already replaced this one, the optimistic state for
   * that newer intent is what the user is looking at, so nothing is drawn — the
   * newer write is still queued and will settle it. Otherwise a failure that
   * carries state reconciles to it, and a stateless failure restores the state
   * from before this write.
   */
  private failHidden(
    error: unknown,
    current: boolean,
    previous: HiddenCategoriesState,
  ): HiddenWriteOutcome {
    if (!current) {
      return { kind: "failed", message: "", state: this.hiddenCategories };
    }

    if (error instanceof ApiError) {
      if (error.state !== null) {
        this.commitHidden(error.state);
        return {
          kind: "reconciled",
          status: error.status,
          code: error.code,
          message: error.message,
          state: error.state,
        };
      }
      this.hiddenCategories = previous;
      this.error = error.message;
      return { kind: "failed", message: error.message, state: previous };
    }

    const message = error instanceof Error ? error.message : String(error);
    this.hiddenCategories = previous;
    this.error = message;
    return { kind: "failed", message, state: previous };
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
        // Name order is the base — FreshRSS returns feeds in its own order and
        // never by hand. A drag adds an arrangement on top of that base, and
        // anything the user has not dragged keeps its alphabet.
        feeds: sortByOrder(
          [...group.feeds].sort((a, b) => a.title.localeCompare(b.title)),
          this.feedOrder,
        ),
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
      this.feedOrder,
      this.categoryOrder,
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
    // The account's copy is read once, behind the first paint: the prefs above
    // are already what the sidebar draws, so this must not be awaited here.
    this.positionsLanded = this.adoptPositionsFromAccount().catch(() => {});
    const place = this.readPlace();
    // Paint what we had last time before asking the network for anything.
    await this.hydrateSidebar();
    const stream = place.streamId ?? READING_LIST;
    const title = place.streamId === null ? "Reading list" : place.streamTitle;
    const [sidebarLanded] = await Promise.all([this.loadSidebar(), this.openStream(stream, title)]);
    // A launch load is a sync: it fetches the sidebar and the open stream. Only
    // when both landed — a failed launch leaves this at zero, which is how auto
    // sync knows to retry at once instead of waiting out an interval.
    if (sidebarLanded && this.error === null) this.lastSyncAt = Date.now();
    if (place.streamId !== null && this.error !== null) {
      // The feed has been deleted or renamed since: land somewhere real rather
      // than leaving a dead stream and an error on screen at sign-in.
      this.error = null;
      await this.openStream(READING_LIST, "Reading list");
      this.savePlace();
      return;
    }
    this.expandedFeedId = place.expandedFeedId;
    // The post is only reopened from what the first page holds; an older one is
    // not worth a request of its own, and the feed is open either way.
    const open = place.articleId === null ? undefined : this.items.find((item) => item.id === place.articleId);
    if (open !== undefined) this.select(open);
    this.savePlace();
  }

  private placeKey(): string | null {
    const session = this.session;
    return session === null ? null : placeKey(session.serverUrl, session.email);
  }

  private readPlace(): Place {
    const key = this.placeKey();
    if (key === null || typeof localStorage === "undefined") return { ...EMPTY_PLACE };
    try {
      return parsePlace(JSON.parse(localStorage.getItem(key) ?? "null"));
    } catch {
      return { ...EMPTY_PLACE };
    }
  }

  /**
   * Called whenever the feed, post or unfolded feed changes. Storage that is
   * full or blocked just means the app opens on the Reading list, so failures
   * are silent by design.
   */
  private savePlace(): void {
    const key = this.placeKey();
    if (key === null || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          streamId: this.activeStream,
          streamTitle: this.activeTitle,
          articleId: this.selectedId,
          expandedFeedId: this.expandedFeedId,
        }),
      );
    } catch {
      /* preferences just do not persist */
    }
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
    this.streamHistory = [];
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
    this.sidebarIndent = { available: false, px: SIDEBAR_INDENT_FALLBACK_PX, max: SIDEBAR_INDENT_MAX_PX };
    this.feedBusy = false;
    this.addFeedError = null;
    this.menu = null;
    this.localPins = emptyPins();
    this.feedOrder = [];
    this.categoryOrder = [];
    this.positionsStamp = 0;
    this.positionsRoute = "unknown";
    this.positionsChain = Promise.resolve();
    this.positionsGeneration = 0;
    this.positionsVoided = 0;
    this.positionsLanded = Promise.resolve();
    this.collapsedCategories = {};
  }

  async loadSidebar(report?: SyncReport): Promise<boolean> {
    if (!this.session) return false;
    const session = this.session;
    const fetchStep = <T>(id: "feeds" | "tags" | "counts", fetchOne: () => Promise<T>): Promise<T> => {
      report?.start(id);
      return fetchOne().then(
        (value) => {
          report?.land(id);
          return value;
        },
        (error: unknown) => {
          report?.fail(id);
          throw error;
        },
      );
    };

    const [feeds, tags, counts] = await Promise.allSettled([
      fetchStep("feeds", () => listSubscriptions(transport, session)),
      fetchStep("tags", () => listTags(transport, session)),
      fetchStep("counts", () => getUnreadCounts(transport, session)),
      // Reports itself: a missing extension is not an error, a failed read is a
      // step that did not land.
      this.loadApiState(report),
    ]);

    const failed = [feeds, tags, counts].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) {
      this.error = message(failed.reason);
      return false;
    }
    if (feeds.status !== "fulfilled" || tags.status !== "fulfilled" || counts.status !== "fulfilled") {
      return false;
    }
    this.subscriptions = feeds.value;
    this.tags = tags.value;
    this.setCounts(counts.value);
    this.persistSidebar(counts.value);
    return true;
  }

  /**
   * Reads every extension block: hidden categories, favorites, sidebar indent.
   *
   * One request, because the extension builds all three from the same user
   * configuration and three calls could each see a different snapshot.
   *
   * Deliberately does not touch `error`: a missing extension, a 409 or a 401
   * here must not take over the sidebar, and the GReader calls already report
   * a dead token. It does report the step to the sync readout, though: a fetch
   * that came back as an error is not a step that landed, whatever the reason.
   */
  async loadApiState(report?: SyncReport): Promise<void> {
    if (!this.session) return;
    report?.start("extension");
    try {
      const state = await getApiStateFromServer(transport, this.session);
      this.hiddenCategories = state.hiddenCategories;
      this.favorites = state.favorites;
      this.sidebarIndent = this.withLocalIndent(state.sidebarIndent);
      this.hiddenError = null;
      this.retryUnsentIndent(state.sidebarIndent.px);
      report?.land("extension");
    } catch (error) {
      this.hiddenCategories = unavailableState();
      this.favorites = unavailableFavorites();
      this.sidebarIndent = { available: false, px: SIDEBAR_INDENT_FALLBACK_PX, max: SIDEBAR_INDENT_MAX_PX };
      this.hiddenError = message(error);
      report?.fail("extension");
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
    const result = await this.addFeeds(url);
    return result.added.length > 0;
  }

  /**
   * Subscribes to every URL in a pasted block, one per line.
   *
   * Sequential rather than parallel on purpose: FreshRSS handles a burst of
   * subscribes badly, and the sidebar is reloaded once at the end instead of
   * once per feed. A failure does not stop the run — the point of pasting a list
   * is to get as many of them in as possible, and the ones that failed are
   * reported with the server's own words so they can be fixed and retried
   * without re-entering the rest.
   */
  async addFeeds(input: string): Promise<AddFeedsResult> {
    const session = this.session;
    if (session === null || this.feedBusy) return { added: [], failed: [] };

    const urls = parseFeedUrls(input);
    if (urls.length === 0) {
      this.addFeedError = "Enter a feed URL first.";
      return { added: [], failed: [] };
    }

    return this.subscribeEach(session, urls.map((url) => ({ url })));
  }

  /**
   * Subscribes to the feeds in an OPML file, keeping their folders.
   *
   * Same rules as pasting a list — sequential, one sidebar reload, failures
   * reported and the rest carried on with — because it is the same burst of
   * requests; only the source differs. The folder travels as the GReader label
   * on the subscribe itself, so a feed is never briefly uncategorised.
   */
  async importOpml(feeds: readonly OpmlFeed[]): Promise<AddFeedsResult> {
    const session = this.session;
    if (session === null || this.feedBusy) return { added: [], failed: [] };
    if (feeds.length === 0) {
      this.addFeedError = "That file has no feeds in it.";
      return { added: [], failed: [] };
    }
    return this.subscribeEach(session, feeds);
  }

  /** The loop both entry points share. */
  private async subscribeEach(
    session: Session,
    entries: readonly { url: string; title?: string; category?: string }[],
  ): Promise<AddFeedsResult> {
    this.feedBusy = true;
    this.addFeedError = null;
    this.feedProgress = { done: 0, total: entries.length };
    const result: AddFeedsResult = { added: [], failed: [] };
    try {
      for (const entry of entries) {
        try {
          await subscribe(transport, session, entry.url, entry.title, entry.category);
          result.added.push(entry.url);
        } catch (error) {
          result.failed.push({ url: entry.url, error: message(error) });
        }
        this.feedProgress = { done: result.added.length + result.failed.length, total: entries.length };
      }
      if (result.added.length > 0) await this.loadSidebar();
      this.addFeedError = addFeedsMessage(result);
      return result;
    } finally {
      this.feedBusy = false;
      this.feedProgress = null;
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
   * Files a feed into a category, in the slot it was dropped on.
   *
   * Two different facts, stored in two different places on purpose:
   *
   * - **Position** inside a category is not FreshRSS's to hold: it keeps no
   *   order for feeds in a folder, so the arrangement is drawn from the local
   *   lists and mirrored to the account's `/v1/positions` document after the
   *   drag. The move is drawn at once and sent afterwards, never waited on.
   * - **Membership** is the server's. A feed that showed under Design here and
   *   under Tech on the website would be a lie that survives until the next
   *   reload, so the move is sent as a real `ac=edit` and rolled back if the
   *   server refuses it.
   */
  async arrangeFeed(streamId: string, category: string, before: string | null): Promise<boolean> {
    const feed = this.subscriptions.find((candidate) => candidate.id === streamId);
    if (feed === undefined || this.feedBusy) return false;

    const currentLabel =
      feed.categories?.find((entry) => entry.id.startsWith(LABEL_PREFIX))?.label ?? null;
    // Uncategorized is the absence of a label, not a label called that.
    const targetLabel = category === "Uncategorized" ? null : category;

    // A total order from the first drag onwards: seeded with what is on screen,
    // so "put this before that" keeps its meaning for feeds that were never
    // dragged and still sit in alphabet order.
    const seeded =
      this.feedOrder.length > 0
        ? this.feedOrder
        : this.allCategories.flatMap((group) => group.feeds.map((entry) => entry.id));

    const sameCategory = currentLabel === targetLabel;
    if (sameCategory && isNoopDrop(seeded, streamId, before)) return true;

    const previousOrder = this.feedOrder;
    const previousCategories = feed.categories;
    this.feedOrder = moveInOrder(seeded, streamId, before);
    this.savePrefs();
    // A drag inside the same category is finished here: drawn, stored, sent.
    if (sameCategory) {
      this.sendPositions();
      return true;
    }

    // Drawn at once, written immediately after: a drag should not wait for a
    // round trip to look like it worked.
    feed.categories =
      targetLabel === null
        ? []
        : [{ id: `${LABEL_PREFIX}${targetLabel}`, label: targetLabel }];

    const session = this.session;
    if (session === null) {
      feed.categories = previousCategories;
      this.feedOrder = previousOrder;
      this.savePrefs();
      return false;
    }

    this.feedBusy = true;
    try {
      await moveFeedOnServer(transport, session, streamId, targetLabel, currentLabel);
      // The feed is filed where the drag put it, so the arrangement that goes
      // with it can follow. The rollback path below sends nothing: the account
      // is never given an order the sidebar is not showing.
      this.sendPositions();
      return true;
    } catch (error) {
      feed.categories = previousCategories;
      this.feedOrder = previousOrder;
      this.savePrefs();
      this.error = message(error);
      return false;
    } finally {
      this.feedBusy = false;
    }
  }

  /**
   * Moves a category to a new position in the sidebar.
   *
   * Nothing is sent. FreshRSS has no order for folders, and the pin band is the
   * extension's, so a position is the same kind of fact as the feed
   * arrangement: this device, this account. There is no round trip to fail and
   * therefore nothing to roll back.
   *
   * The first drag seeds the list with what is currently drawn, so "put it
   * last" means last rather than "the only entry in an empty list, drawn
   * first". Seeding is safe even though the drawn order starts with the pinned
   * band: `arrangeByPins` applies the band before the order, so a seeded pinned
   * id keeps the place the band gives it whatever the list says.
   */
  arrangeCategory(categoryId: string, before: string | null): boolean {
    const seeded =
      this.categoryOrder.length > 0
        ? this.categoryOrder
        : this.categories.map((group) => group.id);
    if (isNoopDrop(seeded, categoryId, before)) return true;
    this.categoryOrder = moveInOrder(seeded, categoryId, before);
    this.savePrefs();
    // Drawn and stored first, sent now: the account's copy follows the drag,
    // never the other way round.
    this.sendPositions();
    return true;
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

  /**
   * A sync, counted step by step.
   *
   * Every fetch this triggers reports back when it starts and when it settles,
   * so the header can name the work in flight and show a real fraction instead
   * of an indefinite spinner. `SYNC_TOTAL` is the number of fetches, which is
   * fixed; the work inside each is not, so there is nothing finer to report
   * honestly. The counting itself lives in `createSyncTracker`, which cannot be
   * pushed past five or moved twice for one step — watch-changes and a manual
   * sync can overlap, and both fetch the same five things.
   */
  sync = $state<SyncState>({ ...SYNC_IDLE });

  private syncTracker = createSyncTracker();

  /** The readout as it stands. Every report from a fetch lands here. */
  private syncReport: SyncReport = {
    start: (id) => (this.sync = this.syncTracker.start(id)),
    land: (id) => (this.sync = this.syncTracker.land(id)),
    fail: (id) => (this.sync = this.syncTracker.fail(id)),
  };

  /**
   * When this window last pulled everything from the server, in ms.
   *
   * A launch load counts: it fetches the sidebar and the open stream, which is
   * the same work a sync does. Automatic sync reads this so it does not
   * re-fetch everything twice in the first second of a launch, while still
   * retrying when the launch fetch failed.
   */
  lastSyncAt = $state(0);

  async refresh(): Promise<void> {
    if (!this.session) return;
    this.sync = this.syncTracker.begin();
    try {
      // Forced: the stream cache is good for a minute, and a sync answered from
      // it would look like nothing happened while the bar still ran to the end.
      // Pressing sync is a request for the server's answer, not this window's.
      await Promise.all([
        this.loadSidebar(this.syncReport),
        this.reloadStream({ force: true, report: this.syncReport }),
      ]);
    } finally {
      // Not `done: total`: a sync that lost a fetch ends short, because that is
      // what happened. One of two overlapping syncs ending does not end the
      // readout either.
      this.sync = this.syncTracker.finish();
      if (this.error === null) this.lastSyncAt = Date.now();
      // The header pulses its own bar when `active` falls; nothing is thrown
      // across the window for a fetch finishing.
    }
  }

  /**
   * Streams left behind, most recent last.
   *
   * One column has no sidebar in view, so "where I just came from" has to be
   * remembered rather than read off the screen: this is what the back control
   * and a right-to-left swipe walk through. Bounded, because it is a way back,
   * not a log.
   */
  streamHistory = $state<{ id: string; title: string }[]>([]);

  /** True while walking back, so the step is not recorded as a new visit. */
  private suppressHistory = false;

  get canGoBackToStream(): boolean {
    return this.streamHistory.length > 0;
  }

  get previousStreamTitle(): string | null {
    return this.streamHistory[this.streamHistory.length - 1]?.title ?? null;
  }

  /** Go back to the feed before this one. False when there is nowhere to go. */
  async previousStream(): Promise<boolean> {
    const previous = this.streamHistory[this.streamHistory.length - 1];
    if (previous === undefined) return false;
    this.streamHistory = this.streamHistory.slice(0, -1);
    this.suppressHistory = true;
    try {
      await this.openStream(previous.id, previous.title);
    } finally {
      this.suppressHistory = false;
    }
    return true;
  }

  async openStream(streamId: string, title: string): Promise<void> {
    if (!this.suppressHistory && this.activeStream !== null && this.activeStream !== streamId) {
      this.streamHistory = [...this.streamHistory, { id: this.activeStream, title: this.activeTitle }].slice(-20);
    }
    if (this.activeStream === streamId && this.items.length > 0) {
      this.activeTitle = title;
      return;
    }
    this.activeStream = streamId;
    this.activeTitle = title;
    this.selectedId = null;
    this.savePlace();
    await this.reloadStream();
  }

  async reloadStream(
    options: { force?: boolean; report?: SyncReport } = {},
  ): Promise<void> {
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
    // The step is reported when its fetch settles, and only then: a sync counts
    // requests answered, not bytes read from a cache.
    let reported = false;
    const settle = (outcome: "land" | "fail"): void => {
      if (reported) return;
      reported = true;
      if (outcome === "land") options.report?.land("posts");
      else options.report?.fail("posts");
    };

    if (fresh && options.force !== true) {
      this.loadingList = false;
      this.error = null;
      this.lastStreamSource = "cache";
      settle("land");
      return;
    }

    // A cached stream revalidates silently; only a cold one shows the spinner.
    this.loadingList = cached === undefined;
    this.error = null;
    this.inFlight.get(stream)?.abort();
    const controller = new AbortController();
    this.inFlight.set(stream, controller);
    const started = performance.now();
    options.report?.start("posts");
    try {
      const page = await getStreamContents(transport, this.session, stream, {
        count: PAGE_SIZE,
        signal: controller.signal,
      });
      // The fetch delivered: the step is done even if a later stream change
      // means this page is not the one drawn.
      settle("land");
      if (token !== this.streamToken || this.activeStream !== stream) return;
      this.items = page.items;
      this.continuation = page.continuation;
      this.rememberStream(stream, page.items, page.continuation);
      this.lastStreamSource = "network";
      this.lastStreamMs = Math.round(performance.now() - started);
    } catch (error) {
      // Whatever the reason — a dead server or a stream the user moved on from —
      // this step did not deliver, so it does not count as done.
      settle("fail");
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

  /**
   * The sidebar's order as a flat list: Reading list, Starred, then each
   * category's feeds in the order shown. Arrow keys and continuous reading both
   * walk this, so what the keyboard calls "the next feed" is exactly the next
   * row the user can see.
   */
  get streamList(): { id: string; title: string }[] {
    const streams = [
      { id: READING_LIST, title: "Reading list" },
      { id: STATE_STARRED, title: "Starred" },
    ];
    for (const category of this.categories) {
      for (const feed of category.feeds) streams.push({ id: feed.id, title: feed.title });
    }
    return streams;
  }

  /**
   * What continuous reading may walk into: the sidebar's order, but without the
   * feeds inside a category the user has folded away.
   *
   * A folded category is a statement that those feeds are out of the way, so
   * scrolling into them would surface rows that are not on screen. Unfolding the
   * category puts them back in the walk, in the position they already occupy.
   */
  get traversalStreams(): { id: string; title: string }[] {
    const streams = [
      { id: READING_LIST, title: "Reading list" },
      { id: STATE_STARRED, title: "Starred" },
    ];
    for (const category of this.categories) {
      if (this.isCategoryCollapsed(category.id)) continue;
      for (const feed of category.feeds) streams.push({ id: feed.id, title: feed.title });
    }
    return streams;
  }

  /** How far the open article has been scrolled, reported by the reader pane. */
  articleAtEnd = $state(false);
  articleAtStart = $state(true);

  setArticleScroll(atStart: boolean, atEnd: boolean): void {
    this.articleAtStart = atStart;
    this.articleAtEnd = atEnd;
  }

  /** Up/Down: the neighbouring feed, keeping the article open if one was. */
  async stepStream(delta: -1 | 1): Promise<void> {
    const streams = this.traversalStreams;
    const index = streams.findIndex((s) => s.id === this.activeStream);
    const target = streams[index + delta];
    if (!target || target.id === this.activeStream) return;
    const wasReading = this.selectedId !== null;
    await this.openStream(target.id, target.title);
    if (wasReading) {
      const visible = this.listItems;
      const first = delta === 1 ? visible[0] : visible[visible.length - 1];
      if (first) this.select(first);
    }
  }

  /** Right/Enter: open the first post of the stream, or the post already chosen. */
  async enter(): Promise<void> {
    if (this.selectedId !== null) return;
    const item = this.listItems[0];
    if (item) this.select(item);
  }

  /** Left: out of the article and back to the posts. */
  back(): boolean {
    if (this.selectedId === null) return false;
    this.closeReader();
    return true;
  }

  async firstStream(): Promise<void> {
    const first = this.streamList[0];
    if (first) await this.openStream(first.id, first.title);
  }

  async lastStream(): Promise<void> {
    const streams = this.streamList;
    const last = streams[streams.length - 1];
    if (last) await this.openStream(last.id, last.title);
  }

  /**
   * Continuous reading. Inside the stream this is the neighbouring post; at the
   * end it crosses into the next feed and lands on its first post.
   *
   * A failed load leaves the open article where it is with the error banner
   * showing, rather than moving to a blank pane.
   */
  async advanceArticle(direction: -1 | 1): Promise<void> {
    if (this.selectedId === null) return;
    const next = step(
      [{ id: this.activeStream, title: this.activeTitle, items: this.listItems }],
      { streamId: this.activeStream, itemId: this.selectedId },
      direction,
    );
    if (next.kind === "item") {
      const item = this.listItems.find((candidate) => candidate.id === next.itemId);
      if (item) this.select(item, direction === -1 ? "bottom" : "top");
      return;
    }
    if (next.kind === "end") await this.crossToNextStream(direction);
  }

  /**
   * Leave this feed for the next one that has something in the current view.
   *
   * Wrapping is the point: the last feed's last post leads into the first
   * feed, and the first feed's first post leads back to the last, so continuous
   * reading has no dead end. The walk is bounded by the number of streams, so
   * "nothing left anywhere" is a definite answer — the unread view when the
   * account is cleared — rather than an endless hunt.
   */
  private async crossToNextStream(direction: -1 | 1): Promise<void> {
    const streams = this.traversalStreams;
    const index = streams.findIndex((s) => s.id === this.activeStream);
    const wasReading = this.selectedId !== null;
    const originId = this.activeStream;
    const originTitle = this.activeTitle;
    const openId = this.selectedId;
    for (const at of attemptOrder(streams.length, index, direction)) {
      const candidate = streams[at];
      if (this.isKnownEmpty(candidate.id)) continue;
      await this.openStream(candidate.id, candidate.title);
      if (this.listItems.length === 0) continue;
      this.traversalEnded = false;
      if (wasReading) {
        const landing = landingItem(
          { id: candidate.id, title: candidate.title, items: this.listItems },
          direction,
        );
        const item = landing === null ? undefined : this.listItems.find((candidate2) => candidate2.id === landing);
        if (item) this.select(item, direction === -1 ? "bottom" : "top");
      }
      return;
    }
    // Nothing anywhere: put the reader back where it was. Hunting through the
    // walk leaves the *last tried* feed open, which would strand the reader in a
    // feed they never asked for just because the unread list ran out.
    if (this.activeStream !== originId) await this.openStream(originId, originTitle);
    const stillOpen = openId !== null ? this.listItems.find((entry) => entry.id === openId) : undefined;
    if (stillOpen) this.selectedId = openId;
    this.traversalEnded = true;
  }

  /**
   * A feed whose unread count is known to be zero cannot land anything in the
   * unread view, so it is stepped over without a request. An unknown count is
   * still tried: guessing there would skip feeds the sidebar has not counted.
   */
  private isKnownEmpty(id: string): boolean {
    if (reading.articleFilter !== "unread") return false;
    return this.counts.get(id) === 0;
  }

  /** `bottom` when the post was entered by scrolling up into it, so the pane
   * opens at its end rather than its title. */
  landingEdge = $state<"top" | "bottom">("top");

  /**
   * True when continuous reading ran out: every stream was tried and none had a
   * post left in the current view. Only reachable in the unread view, because
   * the other views always have something to wrap back to.
   */
  traversalEnded = $state(false);

  private dwellTimer: ReturnType<typeof setTimeout> | null = null;

  /** Arm (or re-arm) the read-after-dwell timer for the open post. */
  private armDwell(item: StreamItem): void {
    this.clearDwell();
    if (
      !shouldArmDwell({
        enabled: reading.autoMarkRead,
        alreadyRead: isRead(item),
        isOpen: this.selectedId === item.id,
      })
    ) {
      return;
    }
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      void this.markAfterDwell(item);
    }, dwellMs(reading.autoMarkSeconds));
  }

  private clearDwell(): void {
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  /**
   * Re-check the timer against the current settings and post.
   *
   * Restarts rather than nudges: switching the preference on starts the clock
   * for the post already open, switching it off takes the clock away without
   * marking anything, and changing the delay re-times the post in hand instead
   * of waiting for the next one.
   */
  syncDwell(): void {
    const item = this.selected;
    if (!item || !reading.autoMarkRead || isRead(item)) {
      this.clearDwell();
      return;
    }
    this.armDwell(item);
  }

  /** The dwell elapsed: mark read, and step off the post if the view drops it. */
  private async markAfterDwell(item: StreamItem): Promise<void> {
    if (this.selectedId !== item.id || !reading.autoMarkRead || isRead(item)) return;
    await this.markRead(item);
  }

  /**
   * Mark the open post read from the reader's own control.
   *
   * In the unread view the post leaves the list the moment it is marked, so the
   * reader lands on the next post instead of staring at one that is no longer
   * in the list it came from. Nothing to land on means the next feed, which is
   * the same journey scrolling would have taken.
   */
  async markRead(item: StreamItem): Promise<void> {
    if (isRead(item) || this.busyItems.get(item.id)) return;
    const next = successorId(this.listItems, item.id);
    await this.setRead(item, true);
    if (this.selectedId !== item.id) return;
    if (this.listItems.some((candidate) => candidate.id === item.id)) return;
    if (next) {
      const candidate = this.listItems.find((entry) => entry.id === next);
      if (candidate) {
        this.select(candidate);
        return;
      }
    }
    await this.crossToNextStream(1);
  }

  /**
   * ↑/↓ with the posts pane in hand: move the selection, not the feed.
   *
   * The list is the filtered, ordered one on screen, so the step lands on what
   * the reader can actually see — and it works the same in all four views,
   * because a view is a way of drawing the list, not a different list.
   */
  async stepItem(delta: -1 | 1): Promise<void> {
    const items = this.listItems;
    const at = this.selectedId === null ? -1 : items.findIndex((item) => item.id === this.selectedId);
    const next = stepIndex(items.length, at, delta);
    if (next === null) return;
    this.select(items[next], delta === 1 ? "top" : "bottom");
  }

  select(item: StreamItem, edge: "top" | "bottom" = "top"): void {
    this.selectedId = item.id;
    this.savePlace();
    this.landingEdge = edge;
    this.traversalEnded = false;
    // Opening a post is not reading it: the dwell timer decides that, and only
    // when the read preference asks for it.
    this.armDwell(item);
  }

  closeReader(): void {
    this.selectedId = null;
    this.savePlace();
    this.clearDwell();
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
  /** The same rule for favorites: reconcile silently, report a real failure. */
  private settleFavorites(outcome: FavoritesWriteOutcome): void {
    if (outcome.kind === "failed") this.error = outcome.message;
  }

  dismissError(): void {
    this.error = null;
  }
}

export const reader = new ReaderState();
