/**
 * The text a library on this device keeps: the reader's choice, and the wiring.
 *
 * Three things live behind this singleton, and only the third is here: the
 * pipeline is `lib/extract.ts`, the storage is the local store's `extractions`
 * table, and the decisions — what is too big, when the library is over its
 * ceiling, what may not be evicted — are `lib/body-cache.ts`, which has no
 * signals in it and is therefore provable in Node. This file is the reader's
 * answer, the two numbers a panel draws, and the adapter that hands the pipeline
 * a cache.
 *
 * Four rules it keeps.
 *
 * - **It is device-level, not account-level.** One disk has one ceiling, and a
 *   body is fetched once for the machine rather than once per profile: the key is
 *   a plain device key, never the account-scoped one. The rows are keyed per
 *   library (`itemId` carries the feed and the post), so two libraries sharing
 *   the store share only the ceiling.
 * - **Reading is free and unconditional; keeping is the preference.** Turning
 *   keeping off never hides what is already stored — that copy costs nothing to
 *   show, and throwing away a page the reader already paid a request for would be
 *   a strange way to save space.
 * - **The budget is only enforced against bodies.** Eviction deletes extraction
 *   rows and nothing else; a subscription, a read mark, a star and a position are
 *   the library, not a cache.
 * - **A pane's post is never evicted.** The two components that draw an article
 *   say which post they are showing; that id is protected for the pass, and when
 *   honouring it leaves the library over its limit the ceiling gives way instead
 *   of the article on screen.
 */
import {
  BODY_BUDGET_DEFAULT,
  BODY_KEEP_DEFAULT,
  formatBytes,
  isBodyBudget,
  isBodyKeepMode,
  type BodyKeepMode,
} from "../lib/bodies";
import { createBodyCache, type BodyCache } from "../lib/body-cache";
import { setExtractionCache } from "../lib/extract";
import type { ReaderProfile } from "../api/profile";
import type { LocalStore } from "../api/local/store";

/**
 * Where the two choices live.
 *
 * A plain `localStorage` key rather than an account-scoped one: this is a fact
 * about the device's disk, which is the same disk whoever is reading.
 */
const STORAGE_KEY = "hardlyreader.bodies.v1";

/**
 * Whether Settings draws the section at all.
 *
 * Only for a library **on this device**: a reader whose articles live on a server
 * has no ceiling here and nowhere to keep anything, and FreshRSS already keeps
 * what it keeps. A function rather than an expression inside the panel, so the
 * rule can be tested without drawing a sheet.
 */
export function showsSavedText(profile: ReaderProfile | null): boolean {
  return profile !== null && profile.kind === "local";
}

export class BodiesState {
  /** Off, on open, or on open and ahead. */
  mode = $state<BodyKeepMode>(BODY_KEEP_DEFAULT);

  /** Bytes allowed on this device. */
  limit = $state(BODY_BUDGET_DEFAULT);

  /** How many bodies are kept, and what they cost. Drawn as one line. */
  count = $state(0);
  bytes = $state(0);

  /** The one line under the rows: what was cleared, or why nothing was. */
  note = $state<string | null>(null);

  /** The library this device has open, or null on a server's library. */
  private library = $state.raw<LocalStore | null>(null);

  /**
   * Posts a pane is drawing right now.
   *
   * A set rather than a single id because two surfaces can be showing two posts
   * at once — the list's inline reader and the article pane — and a phone with
   * all three panes mounted is the ordinary case, not the odd one.
   */
  private readonly onScreen = new Set<string>();

  /** The cache the pipeline reads and writes, while a library is open. */
  private cache: BodyCache | null = null;

  /** Whether a library on this device is open at all. */
  get attached(): boolean {
    return this.library !== null;
  }

  /** Whether this device keeps the post it opens. */
  get keeping(): boolean {
    return this.library !== null && this.mode !== "off";
  }

  /** Whether the posts ahead of the reader are prepared as well. */
  get ahead(): boolean {
    return this.library !== null && this.mode === "ahead";
  }

  /** The two stored choices, when this device has any. */
  load(): void {
    this.mode = BODY_KEEP_DEFAULT;
    this.limit = BODY_BUDGET_DEFAULT;
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (isBodyKeepMode(saved.mode)) this.mode = saved.mode;
      if (typeof saved.limit === "number" && isBodyBudget(saved.limit)) this.limit = saved.limit;
    } catch {
      // A corrupt preference is not worth a dialog: off and the default ceiling.
    }
  }

  /**
   * Point the keeping at a library, or at none.
   *
   * Called once per session from the view that starts the reader, so a switch of
   * accounts re-binds to the library that is now open. A signed-in reader's
   * library is a server's — its articles are the server's business — and the
   * cache is detached rather than left pointing at a database nothing is
   * answering from.
   */
  bind(store: LocalStore | null): void {
    this.library = store;
    this.onScreen.clear();
    this.note = null;
    this.cache =
      store === null
        ? null
        : createBodyCache({
            library: () => this.library,
            keeping: () => this.mode !== "off",
            limit: () => this.limit,
            onScreen: () => this.onScreen,
            measured: (usage) => {
              this.count = usage.count;
              this.bytes = usage.bytes;
            },
            cleared: (pruned) => {
              this.note =
                pruned.dropped === 0
                  ? "Nothing old enough to clear — more text is being shown than the space allows."
                  : `Cleared ${pruned.dropped === 1 ? "an old article" : `${pruned.dropped} old articles`} to stay inside the space — ${formatBytes(pruned.freed)} freed.`;
            },
          });
    setExtractionCache(this.cache);
    if (store === null) {
      this.count = 0;
      this.bytes = 0;
      return;
    }
    void this.refresh();
  }

  /** Re-measure what is held, and make room if the library is over its ceiling. */
  async refresh(): Promise<void> {
    await this.cache?.settle();
  }

  setMode(mode: BodyKeepMode): void {
    if (!isBodyKeepMode(mode) || this.mode === mode) return;
    this.mode = mode;
    this.note = null;
    this.save();
  }

  setLimit(bytes: number): void {
    if (!isBodyBudget(bytes) || this.limit === bytes) return;
    this.limit = bytes;
    this.save();
    void this.refresh();
  }

  /** A pane is drawing this post: its body is not a candidate for eviction. */
  showing(itemId: string): void {
    this.onScreen.add(itemId);
  }

  /** The pane moved on, or went away. */
  hidden(itemId: string): void {
    this.onScreen.delete(itemId);
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: this.mode, limit: this.limit }));
    } catch {
      // Best effort: the choice still applies for this session.
    }
  }
}

export const bodies = new BodiesState();
