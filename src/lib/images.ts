/**
 * What a library on this device keeps of the pictures it has drawn.
 *
 * Every picture in the posts column is an `<img>` pointed straight at the
 * publisher. That is why a list is cheap to draw and expensive to re-draw: the
 * first scroll fetches forty thumbnails from forty origins, and the second
 * scroll fetches them again, because nothing was kept. A picture this device has
 * already shown is a picture it should not have to ask for twice — and a 64px
 * row has no use for the 2 MB original it was handed either.
 *
 * So two things happen at fetch: the picture is **downscaled to the box the pane
 * draws it in**, and the result is **kept**. `lib/image-cache.ts` is the adapter
 * that does it; this file is the policy — how much a device holds, what goes when
 * it is full, and how big a copy is worth keeping — so every number below can be
 * argued with in a test that never opens a browser.
 *
 * Three things it deliberately is not:
 *
 * - **Not part of the sync document.** A picture is a blob that cannot merge;
 *   the library travels and each device keeps its own copies.
 *   `docs/sync-format.md` says so, and this cache does not change the format.
 * - **Not the bodies cache.** Two caches with two ceilings and two answers,
 *   because text and pictures are different sizes, are wanted at different
 *   moments, and are drawn by different panes. `lib/bodies.ts` is the other one.
 * - **Not a hotlink.** A picture that cannot be fetched (a server that refuses
 *   the app, a browser that refuses the read) is drawn from the publisher exactly
 *   as it was before this existed. Nothing here may leave a hole.
 */
import { formatBytes } from "./bodies";

/**
 * When a picture is kept.
 *
 * Three answers, in the vocabulary of the text cache beside it — off, the list's
 * own pictures, or every picture including the article's — because the two rows
 * sit together in Settings and are read together.
 *
 * **Off is not "no pictures".** The pictures are drawn exactly where they are
 * drawn today, from the publisher's own address, on every re-draw. Off means
 * this device keeps no copy.
 *
 * **Thumbnails is the default**, and it is the one that pays: the list's
 * pictures are what a scroll costs, they are drawn at 64px, and the file behind
 * them is usually twenty times that. The article's lead picture is fetched once
 * when the post is opened, so it is the cheaper half to leave alone.
 */
export type PictureKeepMode = "off" | "thumbs" | "all";

export const PICTURE_KEEP_DEFAULT: PictureKeepMode = "thumbs";

/** The three answers, in the order they are offered. */
export const PICTURE_KEEP_MODES: readonly PictureKeepMode[] = ["off", "thumbs", "all"];

export const PICTURE_KEEP_LABELS: Record<PictureKeepMode, string> = {
  off: "Off",
  thumbs: "Thumbnails",
  all: "Everything",
};

/** What each answer does, for the button's own title. */
export const PICTURE_KEEP_TITLES: Record<PictureKeepMode, string> = {
  off: "Keep no pictures — every draw fetches them from the publisher again",
  thumbs: "Keep the list's pictures, at the size the row draws them",
  all: "Keep the list's pictures and the article's own lead picture",
};

export function isPictureKeepMode(value: unknown): value is PictureKeepMode {
  return value === "off" || value === "thumbs" || value === "all";
}

/**
 * The two copies a picture can have.
 *
 * `thumb` is the row's: a 64px square at the default scale. `full` is the
 * article pane's lead, drawn at the width the pane has. They are separate rows
 * because the same URL is drawn in both places at wildly different sizes, and
 * serving a 1200px file to a 64px box is the waste this cache exists to stop.
 */
export type PictureVariant = "thumb" | "full";

/** Whether this answer keeps this copy at all. */
export function keepsVariant(mode: PictureKeepMode, variant: PictureVariant): boolean {
  if (mode === "off") return false;
  return mode === "all" || variant === "thumb";
}

/* ---------------------------------------------------------------------------
 * The sizes a copy is drawn at
 * ------------------------------------------------------------------------- */

/**
 * The box a row draws its picture in, in CSS pixels, at the default scale.
 *
 * `ArticleList`'s `.thumb` is `64px * var(--row-scale) * var(--thumb-scale)`, so
 * the reader can make it larger; the cache cannot follow every scale and keep one
 * copy per URL, so it keeps the largest box the list offers (96px) at the largest
 * density that matters (2×) — 192 pixels. A thumb at 192px is 5–20 KB as WebP,
 * where the original behind it is often 500 KB.
 */
export const THUMB_BOX = 64;

/** Never wider than this, whatever the row scale: the widest a thumb is drawn. */
export const THUMB_TARGET = 192;

/** The article pane a frame has not been measured yet: a sane width to fetch. */
export const FULL_TARGET_DEFAULT = 1200;

/** Past this a lead picture is not a picture, it is a poster: no pane is this wide. */
export const FULL_TARGET_MAX = 1600;

/** Below this the copy would be drawn up, which is worse than the original. */
export const FULL_TARGET_MIN = 320;

/**
 * The width a copy is worth storing, in pixels.
 *
 * A thumb is one number because a row is one box. A lead picture is the pane's
 * width at the device's density, capped — `fittedWidth()` never draws a picture
 * wider than the frame it fits in (`lib/image-fit.ts`), so the frame is the
 * ceiling and the copy can be stored at it rather than at the file's own size.
 * `frameWidth` of 0 means the pane has not measured itself yet.
 */
export function targetWidth(variant: PictureVariant, frameWidth = 0, dpr = 1): number {
  if (variant === "thumb") return THUMB_TARGET;
  const density = Number.isFinite(dpr) && dpr > 1 ? Math.min(dpr, 2) : 1;
  const drawn = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth * density : 0;
  if (drawn === 0) return FULL_TARGET_DEFAULT;
  return Math.min(FULL_TARGET_MAX, Math.max(FULL_TARGET_MIN, Math.round(drawn)));
}

/**
 * How much bigger than the target a file has to be before re-encoding is worth it.
 *
 * A file at 1.1× the box is drawn at the box and thrown away at 10%: the decode
 * is paid, the encode is paid, and a photograph loses a little of itself for a
 * saving nobody can measure. Fifteen per cent is the width of "close enough".
 */
export const SHRINK_FLOOR = 1.15;

/**
 * What a fetched file is worth re-encoding to, and whether it is worth it at all.
 *
 * The rule the cache lives by is **never upscale and never bother for a rounding
 * error**: a 600px strip drawn in a 1400px pane is not a bigger comic, and a
 * 200px file asked to be a 192px thumb is already the right file. `natural` is
 * null when the file has not been decoded yet — then the target is attempted and
 * the canvas's own failure is the answer, because a format that cannot decode is
 * one that has to be kept as it arrived.
 *
 * `width` is what the stored copy is made at, not a request the publisher is
 * asked to honour: a feed's `<img>` names one file, and the cache's saving comes
 * from what it keeps of it.
 */
export interface FetchSize {
  /** The width the copy should be made at. */
  readonly width: number;
  /** Whether the file should be decoded and re-encoded at all. */
  readonly downscale: boolean;
  /** Why it is kept as it arrived. `null` when it is being downscaled. */
  readonly why: "unknown" | "small" | "close" | null;
}

export function fetchSize(
  natural: { readonly width: number; readonly height: number } | null,
  target: number,
): FetchSize {
  const width = Number.isFinite(target) && target > 0 ? Math.max(1, Math.round(target)) : 1;
  if (natural === null || !(natural.width > 0) || !(natural.height > 0)) {
    return { width, downscale: true, why: "unknown" };
  }
  const file = Math.round(natural.width);
  if (file <= width) return { width: file, downscale: false, why: "small" };
  if (file <= width * SHRINK_FLOOR) return { width: file, downscale: false, why: "close" };
  return { width, downscale: true, why: null };
}

/**
 * The key one copy is stored under.
 *
 * The address and the variant, in that order — the URL is already the identity of
 * a picture, and a hash of it would add an asynchronous step to a lookup the list
 * needs synchronously, in exchange for nothing a database key needs. The variant
 * is in the key so the two copies of one picture are two rows.
 */
export function pictureKey(variant: PictureVariant, url: string): string {
  return `${variant}\n${url}`;
}

/* ---------------------------------------------------------------------------
 * Whether an address may be kept at all
 * ------------------------------------------------------------------------- */

/**
 * Why an address is not worth a row.
 *
 * - `empty` — nothing to draw, so nothing to keep.
 * - `inline` — a `data:` URI. The bytes are already in the article's markup; a
 *   copy on disk would be a second copy of something that never needed a request.
 * - `local` — a `blob:` address, which is this device's own memory already.
 * - `scheme` — anything that is not `http` or `https`: a `file:` on the desktop
 *   app, an extension's `chrome-extension:`, a stray `javascript:` in a feed's
 *   markup. None of them is a publisher's picture and none of them is fetched.
 */
export type PictureRefusal = "empty" | "inline" | "local" | "scheme";

export interface PictureVerdict {
  /** Whether this address may be fetched and kept. */
  readonly keep: boolean;
  /** Why not, when it may not. `null` when it may. */
  readonly why: PictureRefusal | null;
}

const KEEP: PictureVerdict = { keep: true, why: null };

/** An absolute URL's scheme, lowercased, or null for a relative address. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Whether this address is a picture this device could keep.
 *
 * Deliberately **not** a same-origin test. It is tempting — the app's own icons
 * are served from the app's own origin and the browser already caches them — but
 * a reader running the PWA on the same host as their FreshRSS has a publisher
 * whose pictures share that origin too, and refusing them would switch the cache
 * off for exactly the setup it was built for. A URL that arrives here has already
 * been chosen as a picture by the list; the scheme is the only thing this can
 * judge without fetching it.
 */
export function mayKeepPicture(url: string): PictureVerdict {
  const address = typeof url === "string" ? url.trim() : "";
  if (address === "") return { keep: false, why: "empty" };
  const scheme = SCHEME.exec(address)?.[1].toLowerCase() ?? null;
  if (scheme === "data") return { keep: false, why: "inline" };
  if (scheme === "blob") return { keep: false, why: "local" };
  if (scheme !== null && scheme !== "http" && scheme !== "https") {
    return { keep: false, why: "scheme" };
  }
  // A protocol-relative address (`//cdn.example/x.png`) has no scheme of its own
  // and is http(s) by the page's own answer: kept.
  return KEEP;
}

/* ---------------------------------------------------------------------------
 * The budget
 * ------------------------------------------------------------------------- */

/**
 * How many picture bytes one device holds.
 *
 * 200 MB is a few thousand thumbnails at 10 KB plus a few hundred lead pictures,
 * which is a library read for months; the panel offers a smaller and a larger
 * answer for a phone and for someone who reads comics. The picture cache is
 * bigger than the text cache on purpose: a body is prose, a picture is a
 * photograph, and the same number of them costs twenty times as much.
 */
export const PICTURE_BUDGET_DEFAULT = 200 * 1024 * 1024;

/**
 * The answers the panel offers, in MiB. The middle one is the default.
 *
 * No answer here repeats one of the text cache's three (8, 24, 64): the two rows
 * sit in the same section, and two buttons saying "64 MB" one under the other
 * would leave the reader guessing which ceiling they are setting.
 */
export const PICTURE_BUDGET_CHOICES_MB: readonly number[] = [100, 200, 500];

/**
 * Past this one picture is not kept, whatever the ceiling.
 *
 * The copy stored is the downscaled one, so this is nearly never reached; it is
 * the guard for the case where a picture cannot be downscaled (an SVG, a format
 * the engine cannot decode) and the original would otherwise be kept whole. Two
 * megabytes is a large photograph and a tenth of a small device's whole budget.
 */
export const PICTURE_MAX_ONE = 2 * 1024 * 1024;

export function isPictureBudget(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 1 * 1024 * 1024 && bytes <= 2048 * 1024 * 1024;
}

/** One kept picture, as the budget sees it: no bytes of its own, only what eviction needs. */
export interface PictureRecord {
  readonly key: string;
  readonly bytes: number;
  /** Seconds, the last time this picture was drawn. What "least recently used" means. */
  readonly usedAt: number;
  /** Seconds, when it was fetched. Breaks ties between two pictures drawn once. */
  readonly storedAt: number;
}

/** What the device is holding, and what is about to go. */
export interface PictureUsage {
  readonly count: number;
  readonly bytes: number;
}

export interface PictureEviction {
  /** The pictures to delete, least recently used first. */
  readonly drop: readonly string[];
  /** Bytes that deleting them frees. */
  readonly freed: number;
  /** What is left when they are gone. */
  readonly remaining: number;
  /**
   * True when everything left is a picture the pane is drawing. A budget that
   * cannot be met without taking the picture on screen says so instead of doing
   * it: a list with one over-limit picture beats a list with a hole in it.
   */
  readonly overLimit: boolean;
}

/**
 * Oldest first: least recently drawn, then least recently fetched, then by key.
 *
 * The key is not a preference, it is a tie-break. Two pictures stamped with the
 * same second are otherwise ordered by whatever the engine returned, and an
 * eviction order that changes between two runs of the same library is not a
 * policy. IndexedDB and SQLite return rows in different orders; this makes them
 * agree.
 */
function lruFirst(a: PictureRecord, b: PictureRecord): number {
  if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
  if (a.storedAt !== b.storedAt) return a.storedAt - b.storedAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export interface PictureEvictionOptions {
  /** Bytes allowed on disk. */
  readonly limitBytes: number;
  /**
   * Pictures that must survive this pass: what a pane is drawing right now, and
   * whatever was just written. A picture nobody is looking at has no claim.
   */
  readonly keep?: Iterable<string>;
}

/**
 * Which pictures to delete to get back under the limit.
 *
 * Least recently drawn first, and only down to the limit: deleting one picture
 * more than the ceiling needs is a picture the reader pays for twice. `keep` is
 * honoured even when honouring it leaves the library over the limit — see
 * `overLimit`.
 */
export function planPictureEviction(
  records: readonly PictureRecord[],
  options: PictureEvictionOptions,
): PictureEviction {
  const limit = Math.max(0, options.limitBytes);
  const safe = new Set(options.keep ?? []);
  let total = 0;
  for (const record of records) total += Math.max(0, record.bytes);

  const drop: string[] = [];
  let remaining = total;
  for (const record of [...records].sort(lruFirst)) {
    if (remaining <= limit) break;
    if (safe.has(record.key)) continue;
    const bytes = Math.max(0, record.bytes);
    if (bytes === 0) {
      // An empty row costs nothing to keep and frees nothing to drop.
      continue;
    }
    drop.push(record.key);
    remaining -= bytes;
  }

  return {
    drop,
    freed: total - remaining,
    remaining,
    overLimit: remaining > limit,
  };
}

/**
 * Why a picture was not worth a row at the moment it arrived.
 *
 * - `empty` — the downscale answered with nothing, so there is nothing to write.
 * - `one` — past `PICTURE_MAX_ONE`: a file that could not be downscaled and is
 *   larger than one post's whole allowance. It is drawn from the publisher.
 * - `ceiling` — larger than the whole budget. Writing it would mean evicting
 *   every other picture to hold one, and the next pass would evict it again; the
 *   hotlink costs one request and no churn.
 */
export type PictureAdmissionRefusal = "empty" | "one" | "ceiling";

/**
 * What to do with a picture that has just been fetched.
 *
 * The budget is not only a rule about what to delete — it is a rule about what to
 * write. Two answers come out of it, and both are cheaper than writing first and
 * tidying afterwards: **do not write this at all** (it can never fit), or **make
 * room before writing it** (`reserve` is the number of bytes the library must be
 * brought down to first, which is the ceiling minus this picture's cost).
 */
export interface PictureAdmission {
  /** Whether this picture may be written. */
  readonly store: boolean;
  /** Why not, when it may not. `null` when it may. */
  readonly why: PictureAdmissionRefusal | null;
  /**
   * Bytes the library must be brought down to *before* the write, so that the
   * picture lands inside the ceiling rather than over it. 0 when it already fits.
   */
  readonly reserve: number;
}

/**
 * Whether a picture of this size may be kept, and what must go first.
 *
 * `usage` is what the device holds now. The reserve is computed from the ceiling
 * and the newcomer rather than from the shortfall, because a pass that prunes to
 * "the limit minus this picture" leaves exactly the room this picture needs and
 * never deletes one more than that — the same "only as many as the ceiling needs"
 * rule `planPictureEviction()` follows.
 */
export function admitPicture(
  cost: number,
  usage: PictureUsage,
  limitBytes: number,
): PictureAdmission {
  if (!Number.isFinite(cost) || cost <= 0) return { store: false, why: "empty", reserve: 0 };
  if (cost > PICTURE_MAX_ONE) return { store: false, why: "one", reserve: 0 };
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
  if (cost > limit) return { store: false, why: "ceiling", reserve: 0 };
  const held = Number.isFinite(usage.bytes) && usage.bytes > 0 ? usage.bytes : 0;
  if (held + cost <= limit) return { store: true, why: null, reserve: 0 };
  return { store: true, why: null, reserve: limit - cost };
}

/**
 * One line for the panel: what is held, out of what may be.
 *
 * The same shape as `describeBodies`, because the two lines are read one under
 * the other: the count in the reader's words, then the measurement, then the
 * ceiling they chose.
 */
export function describePictures(usage: PictureUsage, limitBytes: number): string {
  const limit = formatBytes(limitBytes);
  if (usage.count === 0) return `No saved pictures — up to ${limit} can be kept`;
  const held = formatBytes(usage.bytes);
  const pictures = usage.count === 1 ? "1 picture" : `${usage.count} pictures`;
  return `${pictures}, ${held} of ${limit}`;
}

/** Whether a write has taken the library past its ceiling. */
export function picturesOverLimit(usage: PictureUsage, limitBytes: number): boolean {
  return usage.bytes > limitBytes;
}

/* ---------------------------------------------------------------------------
 * What the list warms, and in what order
 * ------------------------------------------------------------------------- */

/** One picture the list has decided to fetch before it is drawn. */
export interface PictureWish {
  readonly url: string;
  readonly variant: PictureVariant;
}

/**
 * How many pictures of the card ahead are warmed at once.
 *
 * Two: the card's own picture and the one after it in a strip. A card the reader
 * steps onto should never be blank, and a comic's second panel is a flip away —
 * but a long feed must not pull forty files because it was scrolled past, and a
 * thumb is 5–20 KB, so two is a cost a phone can carry and a third is not.
 */
export const PRELOAD_AHEAD_DEFAULT = 2;

/**
 * The order pictures are fetched in: every thumbnail before any full-size copy.
 *
 * The list's pictures are what a scroll costs, and they are the cheap half — a
 * 192px WebP against a 1400px lead. So when a card has several panels, or when a
 * pane asks for both copies of one address, the thumbs go first and the lead
 * picture waits for them: a blank row is a hole in the list, a blank lead is one
 * picture that fills in a moment later.
 *
 * Three things it does besides ordering, because they are all the same question:
 * the same address twice is one wish (the cache dedupes in flight anyway, but
 * there is no reason to queue it twice), an address that may not be kept is not
 * warmed at all, and the list is **cut** at `limit` rather than reordered past it
 * — the first pictures in reading order are the ones nearest the reader.
 */
export function thumbnailFirst(
  wishes: readonly PictureWish[],
  limit: number = PRELOAD_AHEAD_DEFAULT,
): PictureWish[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (cap === 0) return [];
  const seen = new Set<string>();
  const thumbs: PictureWish[] = [];
  const fulls: PictureWish[] = [];
  for (const wish of wishes) {
    if (!mayKeepPicture(wish.url).keep) continue;
    const key = pictureKey(wish.variant, wish.url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (wish.variant === "thumb") thumbs.push({ url: wish.url, variant: wish.variant });
    else fulls.push({ url: wish.url, variant: wish.variant });
  }
  return [...thumbs, ...fulls].slice(0, cap);
}
