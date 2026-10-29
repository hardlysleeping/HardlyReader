/**
 * The pictures a library on this device keeps: the reader's choice, and the wire.
 *
 * Three things live behind this singleton, and only the third is here: the policy
 * is `lib/images.ts`, the pipeline is `lib/image-cache.ts`, and the storage is the
 * local store's `images` + `image_data` tables. This file is the reader's three
 * answers, the two numbers a Settings row draws, and the Svelte action the panes
 * hang their `<img>` on.
 *
 * Four rules it keeps, and they are the same four the text cache beside it keeps.
 *
 * - **It is device-level, not account-level.** One disk has one ceiling, and the
 *   key is a plain device key: `hardlyreader.pictures.v1`.
 * - **Reading is free and unconditional.** Turning keeping off never hides a
 *   picture already on disk; that copy costs nothing to draw.
 * - **The budget is only enforced against pictures.** A pass deletes `images` and
 *   `image_data` rows and nothing else.
 * - **A picture on screen is never evicted.** `draw()` holds its key until the
 *   element goes, and the pass treats every held key as protected.
 */
import {
  PICTURE_BUDGET_DEFAULT,
  PICTURE_KEEP_DEFAULT,
  isPictureBudget,
  isPictureKeepMode,
  type PictureKeepMode,
  type PictureVariant,
} from "../lib/images";
import { formatBytes } from "../lib/bodies";
import { createPictureCache, type PictureCache, type PictureDraw } from "../lib/image-cache";
import type { LocalStore } from "../api/local/store";

/**
 * Where the two choices live.
 *
 * A plain `localStorage` key rather than an account-scoped one: this is a fact
 * about the device's disk, which is the same disk whoever is reading.
 */
const STORAGE_KEY = "hardlyreader.pictures.v1";

/** A picture that is not cached: the publisher's own address, exactly as before. */
const passthrough = (url: string): PictureDraw => ({
  src: url,
  settled: Promise.resolve(url),
  release: () => {},
});

export class PicturesState {
  /** Off, the list's pictures, or every picture. */
  mode = $state<PictureKeepMode>(PICTURE_KEEP_DEFAULT);

  /** Bytes allowed on this device. */
  limit = $state(PICTURE_BUDGET_DEFAULT);

  /** How many pictures are kept, and what they cost. Drawn as one line. */
  count = $state(0);
  bytes = $state(0);

  /** The one line under the rows: what was cleared, or why nothing was. */
  note = $state<string | null>(null);

  /** The library this device has open, or null on a server's library. */
  private library = $state.raw<LocalStore | null>(null);

  /** The cache the panes read and write, while a library is open. */
  private cache: PictureCache | null = null;

  /** Whether a library on this device is open at all. */
  get attached(): boolean {
    return this.library !== null;
  }

  /** Whether this device keeps any picture at all. */
  get keeping(): boolean {
    return this.library !== null && this.mode !== "off";
  }

  /** The two stored choices, when this device has any. */
  load(): void {
    this.mode = PICTURE_KEEP_DEFAULT;
    this.limit = PICTURE_BUDGET_DEFAULT;
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (isPictureKeepMode(saved.mode)) this.mode = saved.mode;
      if (typeof saved.limit === "number" && isPictureBudget(saved.limit)) this.limit = saved.limit;
    } catch {
      // A corrupt preference is not worth a dialog: the default and its ceiling.
    }
  }

  /**
   * Point the cache at a library, or at none.
   *
   * Called once per session from the view that starts the reader. A signed-in
   * reader's library is a server's — its pictures are the server's business, and
   * a library on a server behaves exactly as it did before this module existed:
   * the cache is detached, every `draw()` hands back the publisher's address, and
   * no request is made that was not already being made.
   */
  bind(store: LocalStore | null): void {
    this.cache?.detach();
    this.library = store;
    this.note = null;
    this.cache =
      store === null
        ? null
        : createPictureCache({
            library: () => this.library,
            keeping: () => this.mode,
            limit: () => this.limit,
            density: () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1),
            measured: (usage) => {
              this.count = usage.count;
              this.bytes = usage.bytes;
            },
            cleared: (pruned) => {
              this.note =
                pruned.dropped === 0
                  ? "Nothing old enough to clear — more pictures are on screen than the space allows."
                  : `Cleared ${pruned.dropped === 1 ? "an old picture" : `${pruned.dropped} old pictures`} to stay inside the space — ${formatBytes(pruned.freed)} freed.`;
            },
          });
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

  setMode(mode: PictureKeepMode): void {
    if (!isPictureKeepMode(mode) || this.mode === mode) return;
    this.mode = mode;
    this.note = null;
    this.save();
  }

  setLimit(bytes: number): void {
    if (!isPictureBudget(bytes) || this.limit === bytes) return;
    this.limit = bytes;
    this.save();
    void this.refresh();
  }

  /**
   * What a pane should draw for one picture.
   *
   * `frameWidth` is the pane's own width in CSS pixels when it has one — the
   * article pane does, a row in the list does not (its box is fixed).
   */
  draw(url: string, variant: PictureVariant, frameWidth = 0): PictureDraw {
    const cache = this.cache;
    if (cache === null) return passthrough(url);
    return cache.draw(url, variant, frameWidth);
  }

  /** Fetch the picture of the card or two the list is about to draw. */
  preload(url: string, variant: PictureVariant, frameWidth = 0): void {
    this.cache?.preload(url, variant, frameWidth);
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

export const pictures = new PicturesState();

/* ---------------------------------------------------------------------------
 * The element
 * ------------------------------------------------------------------------- */

/** What one `<img>` asks the cache for. */
export interface PictureRequest {
  /** The publisher's address. Empty means "no picture". */
  url: string;
  variant: PictureVariant;
  /** The pane's width in CSS pixels, for a copy sized to what it draws. */
  frame?: number;
}

/**
 * The `use:` action every picture in the app hangs on.
 *
 * It is an action rather than a `src` expression because the cache is
 * asynchronous: an `<img>` whose `src` is decided during render can only be given
 * either a network address (a second request, and the very thing this cache
 * exists to stop) or nothing. The action owns the element instead — it holds the
 * picture's key while the element is mounted, draws the copy as soon as the cache
 * can hand one over, and falls back to the publisher's address when it cannot.
 *
 * The fallback is unconditional, so nothing here can leave a hole: a picture that
 * refuses to be fetched, or a device with no library, draws exactly what it drew
 * before.
 */
export function picture(node: HTMLImageElement, input: PictureRequest) {
  let release: (() => void) | null = null;
  let drawn: string | null = null;
  let token = 0;

  const forget = (): void => {
    release?.();
    release = null;
  };

  const apply = (request: PictureRequest): void => {
    const stamp = `${request.variant}\u0000${request.frame ?? 0}\u0000${request.url}`;
    // Svelte calls `update` for every new params object, and a row re-renders on
    // each scroll tick: the same picture asked for twice is not a new draw.
    if (stamp === drawn) return;
    drawn = stamp;
    forget();
    const mine = ++token;

    if (request.url === "") {
      node.removeAttribute("src");
      return;
    }

    const shot = pictures.draw(request.url, request.variant, request.frame ?? 0);
    release = shot.release;

    if (shot.src !== null) {
      if (node.getAttribute("src") !== shot.src) node.setAttribute("src", shot.src);
      return;
    }

    // The cache is fetching it; the element draws nothing until there is
    // something to draw. Then the copy, or the publisher's own address.
    node.removeAttribute("src");
    void shot.settled.then((address) => {
      if (mine !== token || address === null) return;
      if (node.getAttribute("src") !== address) node.setAttribute("src", address);
    });
  };

  apply(input);

  return {
    update: apply,
    destroy: () => {
      token += 1;
      forget();
    },
  };
}
