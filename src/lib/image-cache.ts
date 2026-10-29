/**
 * The device's pictures, as the panes see them.
 *
 * Three panes draw a picture — the list's rows and cards, the article pane's
 * lead and the row that opens where it stands — and all three used to hand the
 * webview the publisher's own address and let it ask again on every draw. This
 * is the layer that stops that: the picture is fetched **once**, downscaled to
 * the box the pane draws it in, kept in the library's `images` table, and drawn
 * from there afterwards. A scroll back through a feed then costs no requests at
 * all, and a 64px row is handed 192 pixels instead of a two-megabyte original.
 *
 * What decides is in `lib/images.ts` (how much is held, what goes, how big a copy
 * is worth); this file is the pipeline — the fetch, the downscale, the write, the
 * eviction pass — with the webview it needs injected, so Node can prove it
 * without a canvas or a network.
 *
 * Five rules, in the order they bite:
 *
 * - **Nothing is fetched that the pane is not about to draw.** `draw()` is called
 *   by the element that is being mounted; `preload()` only ever names the card or
 *   two the list has already decided to warm. There is no background crawl of a
 *   feed's pictures.
 * - **The device's copy is the loader, not a second request.** On a miss the pane
 *   is given no address until the fetch settles, so the picture is downloaded
 *   once and then drawn from disk. The publisher's URL is the *fallback* — when
 *   there is no library (a server's articles), when the reader turned keeping
 *   off, when the fetch is refused — and then the pane behaves exactly as it did
 *   before this file existed.
 * - **A picture cannot be downloaded twice at once.** Claims on one key share one
 *   promise, and downloads are capped: four panes showing one feed cost one
 *   request, and opening a post does not start a tenth.
 * - **A picture on screen is never evicted.** Every draw holds its key until the
 *   element goes; a pass that cannot get under the ceiling without taking one
 *   says so instead.
 * - **Nothing here is sync.** A picture is a blob that cannot merge, and
 *   `docs/sync-format.md` says image caches never travel. The library does.
 */
import { transport } from "../api/transport";
import type { LocalStore, PicturePruned } from "../api/local/store";
import {
  PICTURE_MAX_ONE,
  keepsVariant,
  pictureKey,
  picturesOverLimit,
  targetWidth,
  type PictureKeepMode,
  type PictureUsage,
  type PictureVariant,
} from "./images";

/* ---------------------------------------------------------------------------
 * The webview, as five doors
 * ------------------------------------------------------------------------- */

/** A picture's bytes, as the canvas made them. */
export interface PictureBytes {
  blob: Blob;
  /** The engine's own name for the format, so a row can say what it holds. */
  mime: string;
  width: number;
  height: number;
}

/**
 * What the cache needs from the platform it runs on.
 *
 * Injected rather than reached for so the whole pipeline can be proved in Node:
 * the tests hand it a seam that answers with fixed bytes and a counting
 * downloader, and everything above this line — the hit, the dedupe, the write,
 * the eviction, the fallback — is the real code.
 */
export interface PictureSeam {
  /** The publisher's bytes, or null when this device cannot read them. */
  download(url: string): Promise<Blob | null>;
  /** A copy at most `width` pixels wide, or null when the file cannot be decoded. */
  downscale(blob: Blob, width: number): Promise<PictureBytes | null>;
  /** An address the webview can draw without another request. */
  objectUrl(blob: Blob): string;
  /** Give that address back. */
  revoke(url: string): void;
}

/**
 * The real doors: the network, a canvas, and the blob store.
 *
 * The fetch goes through `api/transport`, which is the app's one answer to
 * "which fetch is this" — inside Tauri it is the HTTP plugin, whose request is
 * made by Rust and is therefore neither refused for the webview's origin nor
 * carrying it as a referrer. In a browser tab it is `fetch`, and a publisher
 * that does not allow this origin to read the file simply cannot be cached: the
 * download comes back null and the pane draws the hotlink it always drew. That is
 * the honest limit of the browser build, and it is stated in
 * `docs/article-bodies.md`.
 */
export function webPictureSeam(): PictureSeam {
  return {
    download: async (url) => {
      try {
        const response = await transport(url, {
          method: "GET",
          referrerPolicy: "no-referrer",
          credentials: "omit",
        });
        if (!response.ok) return null;
        return await response.blob();
      } catch {
        // A refused origin, no network, a redirect to nowhere: a miss, not a
        // failure of the reader's library.
        return null;
      }
    },
    downscale: (blob, width) => shrink(blob, width),
    objectUrl: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  };
}

/** A decoded picture, whatever the engine needed to decode it. */
interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function decode(blob: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to an `<img>`: a format the bitmap decoder refuses (an
      // older SVG, a camera's HEIF) still decodes in the webview's own engine.
    }
  }
  const holder = new Image();
  const address = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      holder.onload = () => resolve();
      holder.onerror = () => reject(new Error("undecodable"));
      holder.src = address;
    });
  } catch {
    URL.revokeObjectURL(address);
    return null;
  }
  return {
    source: holder,
    width: holder.naturalWidth,
    height: holder.naturalHeight,
    release: () => URL.revokeObjectURL(address),
  };
}

/**
 * The copy at most `width` pixels wide.
 *
 * Never upscaled, and never larger than the file it came from: a picture that is
 * already small, or already well compressed, is kept as it arrived — re-encoding
 * it would cost quality to save nothing. A format that will not decode is a null,
 * and the caller then keeps the original bytes or nothing at all.
 */
async function shrink(blob: Blob, width: number): Promise<PictureBytes | null> {
  if (blob.size === 0) return null;
  if (blob.type === "image/svg+xml") return null;
  const decoded = await decode(blob);
  if (decoded === null) return null;
  try {
    if (decoded.width === 0 || decoded.height === 0) return null;
    const scale = Math.min(1, width / decoded.width);
    const w = Math.max(1, Math.round(decoded.width * scale));
    const h = Math.max(1, Math.round(decoded.height * scale));
    if (scale === 1 && blob.size <= 64 * 1024) {
      // Small enough already, and at the size it is drawn: nothing to win.
      return { blob, mime: blob.type, width: decoded.width, height: decoded.height };
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(decoded.source, 0, 0, w, h);
    const out = await new Promise<Blob | null>((resolve) => {
      // WebP is 30–50% smaller than JPEG at a photo's quality and every engine
      // the app ships can encode it; `toBlob` answers its own type, which is
      // stored beside the bytes rather than assumed.
      canvas.toBlob((result) => resolve(result), "image/webp", 0.78);
    });
    if (out === null) return null;
    if (out.size >= blob.size) {
      return { blob, mime: blob.type, width: decoded.width, height: decoded.height };
    }
    return { blob: out, mime: out.type || "image/webp", width: w, height: h };
  } finally {
    decoded.release();
  }
}

/* ---------------------------------------------------------------------------
 * Bytes, as a text column
 * ------------------------------------------------------------------------- */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64, by hand, because the store's seam is a table of strings.
 *
 * `btoa` over a `String.fromCharCode(...bytes)` spread dies on a picture of any
 * size (the argument list is a quarter of a megabyte long), and Buffer is not in
 * the webview. Four characters per three bytes, in a loop, costs one pass.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] ?? 0;
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += b === undefined ? "=" : BASE64[(triple >> 6) & 63];
    out += c === undefined ? "=" : BASE64[triple & 63];
  }
  return out;
}

/** The bytes back out of their text column. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const body = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(new ArrayBuffer(Math.floor((body.length * 3) / 4)));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    const value = BASE64.indexOf(char);
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return at === out.length ? out : out.slice(0, at);
}

/* ---------------------------------------------------------------------------
 * The cache
 * ------------------------------------------------------------------------- */

/** What a pane draws, and what to draw when the answer changes. */
export interface PictureDraw {
  /** The address to draw now: a copy in hand, or null while it is fetched. */
  readonly src: string | null;
  /**
   * The address once this picture has settled: the device's copy, or the
   * publisher's own when there is nothing to keep. Never rejects.
   */
  readonly settled: Promise<string | null>;
  /** This pane has finished with the picture. Safe to call twice. */
  readonly release: () => void;
}

export interface PictureCacheDeps {
  /** The library open on this device, or null when there is none. */
  library(): LocalStore | null;
  /** Whether the reader asked this device to keep pictures, and which ones. */
  keeping(): PictureKeepMode;
  /** Bytes allowed on this device. */
  limit(): number;
  /** What is held now, after a write, an eviction or a measurement. */
  measured(usage: PictureUsage): void;
  /** A pass deleted something. */
  cleared?(pruned: PicturePruned): void;
  /** The webview's doors. The real ones unless a test says otherwise. */
  seam?: PictureSeam;
  /** Device pixels per CSS pixel. Read at fetch time, once per picture. */
  density?(): number;
  /** How many downloads may be in flight at once. */
  downloads?: number;
}

export interface PictureCache {
  /** What a pane should draw for this picture now. */
  draw(url: string, variant: PictureVariant, frameWidth?: number): PictureDraw;
  /** Fetch and keep a picture the list is about to draw. Fire and forget. */
  preload(url: string, variant: PictureVariant, frameWidth?: number): void;
  /** Measure the library flat, and make room if it is over the ceiling. */
  settle(writing?: string): Promise<PictureUsage>;
  /** The numbers this cache last reported. */
  usage(): PictureUsage;
  /** Give every address back — the library is going away or changing. */
  detach(): void;
}

/** A picture this cache is holding an address for. */
interface Copy {
  address: string;
  blob: Blob;
}

export function createPictureCache(deps: PictureCacheDeps): PictureCache {
  const seam = deps.seam ?? webPictureSeam();
  const maxDownloads = Math.max(1, deps.downloads ?? 4);

  /** Addresses in hand, by key. */
  const copies = new Map<string, Copy>();
  /** How many panes are drawing each key. */
  const held = new Map<string, number>();
  /** Fetches in flight, so two panes cost one download. */
  const pending = new Map<string, Promise<string | null>>();

  let count = 0;
  let bytes = 0;

  const usage = (): PictureUsage => ({ count, bytes });
  const report = (): void => deps.measured(usage());

  /* --- Downloads, four at a time --------------------------------------- */

  const queue: (() => void)[] = [];
  let running = 0;

  function slot<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        running += 1;
        job()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            const next = queue.shift();
            if (next !== undefined) next();
          });
      };
      if (running < maxDownloads) start();
      else queue.push(start);
    });
  }

  /* --- Keeping and giving back ----------------------------------------- */

  function keep(key: string, blob: Blob): string {
    const known = copies.get(key);
    if (known !== undefined) return known.address;
    const copy: Copy = { address: seam.objectUrl(blob), blob };
    copies.set(key, copy);
    return copy.address;
  }

  function release(key: string): void {
    const heldBy = held.get(key) ?? 0;
    if (heldBy > 1) {
      held.set(key, heldBy - 1);
      return;
    }
    held.delete(key);
    // An address nobody is drawing goes back — unless the picture is still kept,
    // in which case the next draw reads it out of the library again (one cheap
    // row) rather than holding a megabyte of blob for a list nobody is looking at.
    const copy = copies.get(key);
    if (copy !== undefined) {
      seam.revoke(copy.address);
      copies.delete(key);
    }
  }

  function forget(key: string): void {
    if (!held.has(key)) {
      const copy = copies.get(key);
      if (copy !== undefined) {
        seam.revoke(copy.address);
        copies.delete(key);
      }
    }
  }

  /* --- The pipeline ----------------------------------------------------- */

  /** Store a picture, then answer with the address to draw it at. */
  async function settleBytes(
    key: string,
    url: string,
    variant: PictureVariant,
    target: number,
    blob: Blob,
  ): Promise<string | null> {
    const library = deps.library();
    if (library === null) return null;

    const picture = (await seam.downscale(blob, target)) ?? {
      blob,
      mime: blob.type,
      width: 0,
      height: 0,
    };
    const data = toBase64(new Uint8Array(await picture.blob.arrayBuffer()));
    const cost = data.length;
    if (cost === 0) return null;
    // A picture bigger than one post's whole allowance is not kept: the stored
    // copy is normally tens of kilobytes, so this only catches the file that
    // could not be downscaled at all.
    if (cost > PICTURE_MAX_ONE) return null;

    const saved = await library.saveImage({
      key,
      url,
      variant,
      mime: picture.mime,
      width: picture.width,
      height: picture.height,
      data,
    });
    bytes += saved.delta;
    if (saved.added) count += 1;
    report();

    const address = keep(key, picture.blob);
    if (picturesOverLimit(usage(), deps.limit())) await cache.settle(key);
    return address;
  }

  /** The copy on disk, or a fetch that puts one there. Never rejects. */
  async function resolve(
    key: string,
    url: string,
    variant: PictureVariant,
    target: number,
  ): Promise<string | null> {
    const library = deps.library();
    if (library === null) return null;
    try {
      const kept = await library.keptImage(key);
      if (kept !== null) {
        // Drawing is what least-recently-used means: the picture just shown is
        // now the newest in the library. Not awaited — the picture is in hand.
        void library.touchImage(key).catch(() => {});
        const blob = new Blob([fromBase64(kept.data)], { type: kept.mime || "image/webp" });
        return keep(key, blob);
      }
    } catch {
      // A store that cannot answer is a miss, not a failed read: the pane then
      // draws the publisher's own address, exactly as it did before this cache.
    }

    const blob = await slot(() => seam.download(url));
    if (blob === null || blob.size === 0) return null;
    try {
      return await settleBytes(key, url, variant, target, blob);
    } catch {
      return null;
    }
  }

  /** One promise per key: four panes on one feed cost one download. */
  function request(
    key: string,
    url: string,
    variant: PictureVariant,
    target: number,
  ): Promise<string | null> {
    const flight = pending.get(key);
    if (flight !== undefined) return flight;
    const started = resolve(key, url, variant, target).finally(() => {
      pending.delete(key);
    });
    pending.set(key, started);
    return started;
  }

  /** The address the reader asked for, or that same address as the fallback. */
  function passthrough(url: string): PictureDraw {
    return { src: url, settled: Promise.resolve(url), release: () => {} };
  }

  const cache: PictureCache = {
    draw: (url, variant, frameWidth = 0) => {
      if (url === "" || url.startsWith("data:")) return passthrough(url);
      if (deps.library() === null || !keepsVariant(deps.keeping(), variant)) {
        return passthrough(url);
      }
      const key = pictureKey(variant, url);
      const known = copies.get(key);
      const holding = (): (() => void) => {
        held.set(key, (held.get(key) ?? 0) + 1);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          release(key);
        };
      };
      if (known !== undefined) {
        const give = holding();
        void deps.library()?.touchImage(key).catch(() => {});
        return { src: known.address, settled: Promise.resolve(known.address), release: give };
      }
      const give = holding();
      const target = targetWidth(variant, frameWidth, deps.density?.() ?? 1);
      const settled = request(key, url, variant, target).then((address) => address ?? url);
      return {
        src: null,
        settled,
        release: give,
      };
    },

    preload: (url, variant, frameWidth = 0) => {
      if (url === "" || url.startsWith("data:")) return;
      if (deps.library() === null || !keepsVariant(deps.keeping(), variant)) return;
      const key = pictureKey(variant, url);
      if (copies.has(key)) return;
      const target = targetWidth(variant, frameWidth, deps.density?.() ?? 1);
      void request(key, url, variant, target).catch(() => {});
    },

    settle: async (writing) => {
      const library = deps.library();
      if (library === null) return usage();
      try {
        const measured = await library.imageUsage();
        count = measured.count;
        bytes = measured.bytes;
        if (!picturesOverLimit(measured, deps.limit())) {
          report();
          return usage();
        }
        const keep = new Set(held.keys());
        if (writing !== undefined) keep.add(writing);
        const pruned = await library.pruneImages(deps.limit(), { keep });
        count = pruned.count;
        bytes = pruned.bytes;
        for (const key of pruned.keys) forget(key);
        deps.cleared?.(pruned);
      } catch {
        // A store that cannot answer leaves the last numbers alone: a Settings
        // row is not the place to report a database error nobody can act on.
      }
      report();
      return usage();
    },

    usage,

    detach: () => {
      for (const [key, copy] of copies) {
        seam.revoke(copy.address);
        copies.delete(key);
      }
      held.clear();
      pending.clear();
      count = 0;
      bytes = 0;
      report();
    },
  };

  return cache;
}
