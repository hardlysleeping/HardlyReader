/**
 * The offline cache's settings, and the one place that applies them.
 *
 * The policy itself is `api/local/cache.ts` — a pure answer to "what may go".
 * This module is the living half: the reader's chosen answers, the library they
 * are applied to, and the numbers the settings panel prints.
 *
 * Three rules it keeps.
 *
 * - **It is device policy, not account policy.** A cache limit is a statement
 *   about this machine's disk and this reader's patience, so it is stored under
 *   one device key rather than scoped per login. Two accounts on one phone share
 *   one disk; they should share one ceiling.
 * - **Nothing here is a promise the app cannot keep.** `attach()` is the only way
 *   a library arrives, and until one does the panel is told there is no library
 *   instead of being shown a zero that looks like an empty one. A picture cache
 *   is optional in the same way: `attachPictures()` is how one announces itself,
 *   and the picture switch exists only once one has.
 * - **A failure is a sentence.** Every action ends with a line the panel can
 *   show — what was cleared, how much, or why nothing was — because "Clear
 *   cache" that appears to do nothing is the worst possible answer.
 */
import {
  CACHE_POLICY_DEFAULT,
  CACHE_LIMIT_CHOICES,
  describeCache,
  formatBytes,
  pinnedFeedUrls,
  type CachePolicy,
  type CacheUsage,
} from "../api/local/cache";
import type { LocalEngine } from "../api/local/schema";
import type { LocalStore } from "../api/local/store";

/**
 * The device's key. Not account-scoped on purpose — see the note above.
 *
 * A corrupt value falls back to the defaults rather than refusing to open the
 * panel: a cache setting is not worth a dialog.
 */
const STORAGE_KEY = "hardlyreader.offline.v1";

/** What a picture cache reports about itself. */
export interface PictureUsage {
  bytes: number;
  items: number;
}

/**
 * What a picture cache has to be able to say, for this panel to be honest.
 *
 * The article image cache owns the fetching, the downscaling and the file
 * layout; the settings panel owns none of that. It only needs two answers — how
 * much is stored, and how to drop it — so the two can be built separately and
 * still share one storage readout and one "Clear cache".
 */
export interface OfflinePictureCache {
  usage(): Promise<PictureUsage>;
  clear(): Promise<void>;
}

/** Whether a stored limit is one the panel can show as chosen. */
function isLimit(value: unknown): value is number {
  return typeof value === "number" && CACHE_LIMIT_CHOICES.includes(value) && value >= 0;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Why a store call failed, as a line rather than a stack. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "The cache could not be changed on this device";
}

class OfflineState {
  /** The reader's answers. Written on every change; read at launch. */
  policy = $state<CachePolicy>({ ...CACHE_POLICY_DEFAULT });

  /** What the attached library holds; null when there is no library. */
  usage = $state<CacheUsage | null>(null);

  /** What the picture cache holds, when one is attached. */
  pictures = $state<PictureUsage>({ bytes: 0, items: 0 });

  /** Which engine the library is on: `sqlite`, `indexeddb`, `memory`. */
  engine = $state<LocalEngine | null>(null);

  /** A store call is in flight. The panel disables its one button while true. */
  busy = $state(false);

  /** The last thing that happened, in words. */
  note = $state<string | null>(null);

  /**
   * Raw, not deep: a store is a database handle, and proxying it would wrap its
   * methods. Raw state still tracks reassignment, which is all that is needed —
   * attaching one later re-runs the panel's effect and its numbers.
   */
  private library = $state.raw<LocalStore | null>(null);

  private pictureCache = $state.raw<OfflinePictureCache | null>(null);

  /** Whether a library is open on this device. */
  get hasLibrary(): boolean {
    return this.library !== null;
  }

  /** Whether a picture cache is behind the picture switch. */
  get picturesCached(): boolean {
    return this.pictureCache !== null;
  }

  /** Everything the library occupies, cache and list together. */
  get totalBytes(): number {
    return (this.usage?.totalBytes ?? 0) + this.pictures.bytes;
  }

  /** Only the parts that can be thrown away: copies, not the reader's list. */
  get cacheBytes(): number {
    if (this.usage === null) return this.pictures.bytes;
    return this.usage.articleBytes + this.usage.extractionBytes + this.pictures.bytes;
  }

  /** The ceiling, as a row's value. */
  get limitLabel(): string {
    return this.policy.limitBytes <= 0 ? "No limit" : formatBytes(this.policy.limitBytes);
  }

  load(): void {
    this.policy = { ...CACHE_POLICY_DEFAULT };
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      this.policy = {
        limitBytes: isLimit(saved.limitBytes) ? saved.limitBytes : CACHE_POLICY_DEFAULT.limitBytes,
        keepRead: boolean(saved.keepRead, CACHE_POLICY_DEFAULT.keepRead),
        keepStarred: boolean(saved.keepStarred, CACHE_POLICY_DEFAULT.keepStarred),
        cacheImages: boolean(saved.cacheImages, CACHE_POLICY_DEFAULT.cacheImages),
      };
    } catch {
      // Same rule as every other preference here: a corrupt blob is not a dialog.
    }
  }

  setLimit(bytes: number): void {
    if (!isLimit(bytes)) return;
    this.policy.limitBytes = bytes;
    this.save();
  }

  setKeepRead(keep: boolean): void {
    this.policy.keepRead = keep;
    this.save();
  }

  setKeepStarred(keep: boolean): void {
    this.policy.keepStarred = keep;
    this.save();
  }

  setCacheImages(cache: boolean): void {
    this.policy.cacheImages = cache;
    this.save();
  }

  /**
   * The library to govern.
   *
   * Called by whoever opens a local library, before the panel is ever drawn.
   * `null` detaches, which is a sign-out rather than a wipe: the file on disk is
   * the next sign-in's.
   */
  attach(store: LocalStore | null): void {
    this.library = store;
    this.engine = store === null ? null : store.engine;
    if (store === null) {
      this.usage = null;
      return;
    }
    void this.refresh();
  }

  /** The picture cache, when the build has one. */
  attachPictures(cache: OfflinePictureCache | null): void {
    this.pictureCache = cache;
    if (cache === null) {
      this.pictures = { bytes: 0, items: 0 };
      return;
    }
    void this.refresh();
  }

  /** Re-reads both stores. Cheap: two scans, and only when something asked. */
  async refresh(): Promise<void> {
    const store = this.library;
    if (store === null) {
      this.usage = null;
      this.engine = null;
    } else {
      try {
        this.usage = await store.cacheUsage();
        this.engine = store.engine;
      } catch {
        // A closed or unreadable library is reported as no library, not as an
        // empty one: the difference is whether the panel should offer a clear.
        this.usage = null;
      }
    }

    if (this.pictureCache !== null) {
      try {
        this.pictures = await this.pictureCache.usage();
      } catch {
        this.pictures = { bytes: 0, items: 0 };
      }
    }
  }

  /**
   * Applies the policy now.
   *
   * The pinned feeds are passed in as the reader spells them (`feed/<url>`),
   * because pins are reader state; the conversion lives with the policy so the
   * two spellings are reconciled once.
   */
  async apply(pinnedStreamIds: readonly string[] = []): Promise<void> {
    const store = this.library;
    if (store === null) {
      this.note = "No offline library on this device yet";
      return;
    }
    this.busy = true;
    try {
      const report = await store.pruneCache(this.policy, {
        pinnedFeeds: pinnedFeedUrls(pinnedStreamIds),
      });
      await this.refresh();
      this.note = describeCache(report);
      if (report.overLimit) {
        this.note += " — the rest is starred or pinned";
      }
    } catch (error) {
      this.note = reasonOf(error);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Empties the cache: article bodies, extracted text, pictures.
   *
   * Feeds, folders, titles, summaries, read marks and stars survive, because
   * they are the library. The pictures are asked to clear themselves, so a
   * picture cache built later cannot be left holding bytes this panel said it
   * had dropped.
   */
  async clear(): Promise<void> {
    const store = this.library;
    if (store === null && this.pictureCache === null) {
      this.note = "No offline library on this device yet";
      return;
    }
    this.busy = true;
    try {
      let articles = 0;
      let extractions = 0;
      let before = 0;
      let after = 0;

      if (store !== null) {
        const report = await store.clearCache();
        articles = report.bodies;
        extractions = report.extractions;
        before += report.bytesBefore;
        after += report.bytesAfter;
      }
      if (this.pictureCache !== null) {
        const pictures = this.pictures.bytes;
        await this.pictureCache.clear();
        before += pictures;
      }

      await this.refresh();
      this.note = describeCache({ bodies: articles, extractions, bytesBefore: before, bytesAfter: after, overLimit: false });
    } catch (error) {
      this.note = reasonOf(error);
    } finally {
      this.busy = false;
    }
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.policy));
    } catch {
      // Best effort: the setting still applies for this session.
    }
  }
}

export const offline = new OfflineState();
offline.load();
