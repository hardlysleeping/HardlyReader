/**
 * The split family: up to four readers on screen, and which one a press lands in.
 *
 * Modes 1/2/3 give a pane a *role* — feeds, posts, article — so there is one of
 * each and a fourth would be a fourth kind of nothing. This is the other way to
 * run the app: every pane is a whole reader with a stream of its own, the reader
 * that came with the account is the first of them, and the one holding the focus
 * is where the sidebar's next press goes.
 *
 * Two rules decide the shape of this file:
 *
 * - **One account, several readers.** The first pane *is* `reader` — the
 *   account's own — so the sidebar, the extension state, the unread counts and
 *   the remembered place keep working exactly as they did. The panes beside it
 *   are `ReaderState`s born from it (`seedFrom`) sharing its stream cache, so two
 *   panes on one feed cost one request.
 * - **The arrangement is the user's.** Which panes exist, what each is reading,
 *   where each is scrolled and which one has the focus are written down per
 *   account, and a restart puts all of it back.
 */

import { READING_LIST } from "../api/freshrss";
import { readAccountValue, writeAccountValue, type AccountIdentity } from "../lib/account-key";
import {
  SPLIT_BASE,
  canClose,
  canSplit,
  insertAfter,
  newPane,
  readSave,
  removePane,
  saveShape,
  type SplitPaneRecord,
  type SplitSave,
} from "../lib/split";
import { ReaderState, reader } from "./reader.svelte";

/** One pane on screen: a name of its own, and the reader behind it. */
export interface SplitView {
  id: string;
  reader: ReaderState;
}

const PANE_BASE = "hardlyreader:pane";

/** Storage that may be absent: a private window refuses it, and that is not a failure. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class SplitState {
  /**
   * Whether the family is the layout on screen.
   *
   * Kept apart from `layout.mode` on purpose: the modes are roles and their
   * buttons own the window's width, while this one divides the frame it has.
   * Nothing here calls `fitWindowTo`.
   */
  active = $state(false);

  /** The panes, left to right. The first one is always the account's reader. */
  views = $state<SplitView[]>([]);

  /** The pane the next press belongs to. */
  focusedId = $state<string | null>(null);

  /** A pane counter, so a closed pane's id is never handed to a later one. */
  private nextId = 1;

  /** One load chain: the panes are opened in order, so a restore is not four requests at once. */
  private loads: Promise<unknown> = Promise.resolve();

  /** Who these panes are reading as; the arrangement's own key is scoped to it. */
  private get account(): AccountIdentity | null {
    return reader.identity;
  }

  get count(): number {
    return this.views.length;
  }

  /** The reader a press belongs to — the focused pane, or the account's own. */
  get focused(): ReaderState {
    const view = this.views.find((entry) => entry.id === this.focusedId);
    return view?.reader ?? this.views[0]?.reader ?? reader;
  }

  /** The focused pane's stream, for a sidebar that has to say which row is open. */
  get focusedStream(): string {
    return this.focused.activeStream;
  }

  /** The panes as they are written down. */
  get panes(): SplitPaneRecord[] {
    return this.views.map((view) => this.recordOf(view));
  }

  /** What one pane is holding, read off its reader rather than kept in step by hand. */
  private recordOf(view: SplitView): SplitPaneRecord {
    const store = view.reader;
    return {
      id: view.id,
      streamId: store.activeStream,
      streamTitle: store.activeTitle,
      selectedId: store.selectedId,
      listScroll: store.liveScroll.list,
      articleScroll: store.liveScroll.article,
    };
  }

  private name(): string {
    const id = `pane-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  /**
   * A reader born from the account's own.
   *
   * It shares the stream cache (one feed, one fetch), copies the account state it
   * has to draw — feeds, counts, hidden, pins, orders, indent — and tells the
   * split when its scroll moved, because a pane's place in its own list is part
   * of the arrangement. Its sibling readers are wired both ways so a post marked
   * read in one pane is marked read in all of them.
   */
  private makeReader(): ReaderState {
    const store = new ReaderState({ cache: reader.streamCacheRef, pane: true });
    store.seedFrom(reader);
    store.onPanePlace = () => this.save();
    return store;
  }

  /** Every reader hears every other one: a read or a star is the account's, not a pane's. */
  private wire(): void {
    const all = [reader, ...this.views.map((view) => view.reader)];
    for (const a of all) {
      for (const b of all) {
        if (a !== b) a.attachMirror(b);
      }
    }
  }

  private unwire(): void {
    for (const view of this.views) {
      if (view.reader === reader) continue;
      reader.detachMirror(view.reader);
      view.reader.detachMirror(reader);
      for (const other of this.views) {
        if (other.reader === view.reader) continue;
        other.reader.detachMirror(view.reader);
        view.reader.detachMirror(other.reader);
      }
    }
  }

  /**
   * Opens a pane's stream, after the pane before it.
   *
   * Four panes on a cold cache are four `stream/contents` calls and the API has
   * no batch read, so they are opened one after another rather than all at once:
   * each pane shows its own skeleton, and the one you are looking at is not
   * queued behind three you are not.
   */
  private queue(view: SplitView, streamId: string, title: string, selectedId: string | null, scroll: number): void {
    const store = view.reader;
    if (store === reader) {
      // The account's own reader is already where it is; only a remembered
      // selection has to be put back.
      this.restoreSelection(store, selectedId, scroll);
      return;
    }
    this.loads = this.loads.then(async () => {
      // A pane closed while its turn was waiting has nothing to load.
      if (!this.views.some((entry) => entry.id === view.id)) return;
      store.activeTitle = title;
      await store.openStream(streamId, title);
      this.restoreSelection(store, selectedId, scroll);
      this.save();
    });
  }

  /** Puts a pane back on the post and the line it was left at. */
  private restoreSelection(store: ReaderState, selectedId: string | null, scroll: number): void {
    if (scroll > 0) store.listScrollRestore = scroll;
    if (selectedId === null) return;
    // From what the first page holds: an older post is not worth a request of
    // its own, and the pane opens on its stream either way.
    const item = store.items.find((entry) => entry.id === selectedId);
    if (item !== undefined) store.select(item);
  }

  /**
   * Turns the family on.
   *
   * The pane you are reading in stays exactly where it is — it is the account's
   * reader, so nothing is copied — and a second pane opens beside it on the
   * Reading list: a place with something in it, rather than a copy of the feed
   * you are already looking at.
   */
  enter(): void {
    if (this.active) return;
    this.views = [{ id: this.name(), reader }];
    this.focusedId = this.views[0].id;
    this.active = true;
    this.save();
    this.addPane();
  }

  /**
   * Turns the family off, on the pane that had the focus.
   *
   * Leaving must not lose your place: the focused pane's stream comes back to
   * the account's own reader, so the layout you return to is the one you were
   * reading in rather than whichever pane came first.
   */
  async leave(): Promise<void> {
    if (!this.active) return;
    const focused = this.focused;
    const stream = focused.activeStream;
    const title = focused.activeTitle;
    const selected = focused.selectedId;
    this.unwire();
    this.views = [];
    this.focusedId = null;
    this.active = false;
    this.save();
    if (focused !== reader) {
      if (stream !== reader.activeStream || reader.items.length === 0) await reader.openStream(stream, title);
      const item = selected === null ? undefined : reader.items.find((entry) => entry.id === selected);
      if (item !== undefined) reader.select(item);
      else if (selected !== null) reader.closeReader();
    }
  }

  /** Adds a pane to the right of the focused one, on the reading list. */
  addPane(): void {
    if (!this.active || !canSplit(this.views.length)) return;
    const store = this.makeReader();
    const view: SplitView = { id: this.name(), reader: store };
    const records = insertAfter(this.panes, this.focusedId, newPane(view.id, READING_LIST, "Reading list"));
    // `insertAfter` decides where it goes; the readers are matched to it by id,
    // because the account's own reader is already one of them.
    const byId = new Map<string, ReaderState>([[view.id, store]]);
    for (const known of this.views) byId.set(known.id, known.reader);
    this.views = records
      .map((record) => {
        const known = byId.get(record.id);
        return known === undefined ? null : { id: record.id, reader: known };
      })
      .filter((entry): entry is SplitView => entry !== null);
    this.focusedId = view.id;
    this.wire();
    this.queue(view, READING_LIST, "Reading list", null, 0);
    this.save();
  }

  /** Closes one pane. The family keeps two, and the focus goes to the right. */
  closePane(id: string): void {
    if (!canClose(this.views.length)) return;
    if (!this.views.some((view) => view.id === id)) return;
    const next = removePane(this.panes, id, this.focusedId);
    const keep = new Set(next.panes.map((record) => record.id));
    this.unwire();
    this.views = this.views.filter((view) => keep.has(view.id));
    this.focusedId = next.focusedId;
    this.wire();
    this.save();
  }

  /** A press lands in this pane: it owns the keyboard and the sidebar's next click. */
  focus(id: string): void {
    if (this.focusedId === id) return;
    if (!this.views.some((view) => view.id === id)) return;
    this.focusedId = id;
    this.save();
  }

  /** A feed, a category or a stream chosen in the sidebar: it replaces the focused pane's. */
  async openInFocused(streamId: string, title: string): Promise<void> {
    const store = this.focused;
    await store.openStream(streamId, title);
    this.save();
  }

  /** Puts the list back on screen after a post: the pane, not the account. */
  closePost(id: string): void {
    const view = this.views.find((entry) => entry.id === id);
    if (view === undefined) return;
    view.reader.closeReader();
    this.save();
  }

  /** Writes the arrangement down. Cheap, small, and silent when storage refuses. */
  save(): void {
    const store = storage();
    if (store === null) return;
    const account = this.account;
    const shape = saveShape(this.active, this.active ? this.panes : [], this.focusedId);
    try {
      writeAccountValue(store, SPLIT_BASE, account, JSON.stringify(shape));
    } catch {
      // A full or blocked store means the arrangement is this session's. Nothing
      // else in the app depends on it.
    }
  }

  /** What was written down, if anything: the split's own document for this account. */
  read(): SplitSave | null {
    const store = storage();
    if (store === null) return null;
    return readSave(readAccountValue(store, SPLIT_BASE, this.account));
  }

  /**
   * Puts a whole arrangement back, after the account has started reading.
   *
   * Called once, from the view that mounts per session. It restores the focus
   * and the panes straight away — titles and skeletons — and lets the streams
   * arrive one at a time behind them, so a restart shows the shape it left
   * immediately instead of four blank columns for as long as the first fetch
   * takes.
   */
  restore(): void {
    if (this.active) return;
    const saved = this.read();
    if (saved === null || !saved.active || saved.panes.length < 2) {
      if (saved !== null && saved.active) this.save();
      return;
    }
    // The first stored pane is the account's reader: it is already open on the
    // stream the remembered place put it on, and re-opening it would spend a
    // request to arrive where it is.
    const [first, ...rest] = saved.panes;
    this.views = [{ id: first.id, reader }];
    this.focusedId = saved.focusedId === first.id ? first.id : null;
    this.nextId = 1 + saved.panes.length;
    for (const record of rest) {
      const store = this.makeReader();
      const view: SplitView = { id: record.id, reader: store };
      this.views = [...this.views, view];
      this.queue(view, record.streamId, record.streamTitle, record.selectedId, record.listScroll);
      if (saved.focusedId === record.id) this.focusedId = record.id;
    }
    if (this.focusedId === null) this.focusedId = this.views[0].id;
    this.active = true;
    this.wire();
    this.save();
  }

  /** Forgets the arrangement: over the ordinary layout, nothing is waiting to come back. */
  clear(): void {
    this.unwire();
    this.views = [];
    this.focusedId = null;
    this.active = false;
    this.save();
  }
}

export const split = new SplitState();
