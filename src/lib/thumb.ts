/**
 * A post's thumbnail, from whatever the feed actually gave us.
 *
 * Three places an image can be, in the order they are trusted:
 *
 *   1. an enclosure — the feed saying "this post has a picture", so it is
 *      already the right one;
 *   2. a media element (`media:thumbnail`, `media:content`), same idea in
 *      Media RSS clothes;
 *   3. the first `<img>` in the post body, which is a guess, so trackers and
 *      spacer pixels are filtered out before the guess is used.
 *
 * Nothing here fetches: this only decides a URL. Whether the picture loads is
 * the browser's business, and a row with no picture simply has no thumbnail
 * rather than a placeholder box.
 */

export interface ThumbSource {
  summary?: { content: string } | null;
  content?: { content: string } | null;
  alternate?: { href: string }[] | null;
  enclosure?: { href: string; type?: string }[] | null;
  media?: {
    thumbnail?: { url: string }[] | null;
    content?: { url: string; type?: string }[] | null;
  } | null;
}

export type ThumbKind = "enclosure" | "media" | "inline" | "none";

/** The image extensions a WordPress size suffix can hang off. */
const IMAGE_EXT = String.raw`\.(?:jpe?g|png|gif|webp|avif)`;

/** `…-150x150.jpg` → `…` + `.jpg`. Anchored at both ends, so only the last
 *  suffix before the extension is stripped (`a-150x150-300x300.jpg` → `a-150x150`). */
const SIZE_SUFFIX = new RegExp(String.raw`^(.*)-\d+x\d+(${IMAGE_EXT})$`, "i");

/**
 * WordPress puts a small crop of a picture beside the real one — `cat-150x150.jpg`
 * next to `cat.jpg` — and some feeds publish only the crop. A card draws the
 * picture at its full width, so the crop is upscaled into mush; the full-size
 * file is almost always sitting at the same path.
 *
 * Three shapes are handled, and all of them turn up in the wild:
 *
 *   - the name itself ends the URL: `…/2026-10-21-strip-150x150.jpg`;
 *   - the name is the end of a proxied URL, because FreshRSS's ImageCache
 *     extension rewrites every `src` to `piccache.php?url=<rawurlencoded src>`
 *     and `rawurlencode` leaves `-` and `.` alone — so the suffix is still the
 *     tail of the string and the sharpened URL stays inside the proxy;
 *   - the name is followed by a query or fragment: `photo-150x150.jpg?resize=…`.
 *
 * Returns null — meaning "leave the URL exactly as it is" — when there is no
 * size suffix to strip.
 */
export function fullSize(url: string): string | null {
  const whole = SIZE_SUFFIX.exec(url);
  if (whole !== null) return `${whole[1]}${whole[2]}`;
  const cut = url.search(/[?#]/);
  if (cut === -1) return null;
  const named = SIZE_SUFFIX.exec(url.slice(0, cut));
  if (named === null) return null;
  return `${named[1]}${named[2]}${url.slice(cut)}`;
}

export interface Thumb {
  url: string | null;
  kind: ThumbKind;
  /** The picture the feed actually named, when `url` is a sharper variant of it. */
  fallback?: string;
}

const NONE: Thumb = { url: null, kind: "none" };

/** 1×1 "images": analytics beacons, spacer gifs, the usual feed litter. */
const TRACKER = /(?:^|[/._-])(?:1x1|pixel|beacon|spacer|blank|transparent|tracker|analytics)(?:[/._-]|$)/i;

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

function usable(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("data:")) return DATA_IMAGE.test(trimmed) ? trimmed : null;
  if (/^(?:javascript|vbscript|file):/i.test(trimmed)) return null;
  if (TRACKER.test(trimmed)) return null;
  return trimmed;
}

/** Absolute URL for a maybe-relative src, using the post's own link as base. */
export function resolveUrl(src: string, base: string | null): string | null {
  if (src.startsWith("data:")) return src;
  try {
    return new URL(src, base ?? undefined).toString();
  } catch {
    return null;
  }
}

function isImageType(type: string | undefined): boolean {
  return typeof type === "string" && type.toLowerCase().startsWith("image/");
}

/**
 * The first `<img>` in a fragment.
 *
 * A regex, not a parser: this runs per row on HTML we are not going to render
 * here, and the only thing being read is one attribute. `srcset` is preferred
 * over `src` when both exist, because the largest candidate is the sharper
 * thumbnail.
 */
/** One attribute out of a tag, quoted or (legally) unquoted. */
export function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "i");
  const match = re.exec(tag);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The first `<img>` in a fragment.
 *
 * A regex, not a parser: this runs per row on HTML we are not going to render
 * here, and the only thing being read is one attribute. `srcset` is preferred
 * over `src` when both exist, because the largest candidate is the sharper
 * thumbnail.
 */
export function firstImageIn(html: string | null | undefined): string | null {
  if (typeof html !== "string" || html === "") return null;
  const tag = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    const srcset = attr(match[0], "srcset");
    const src = attr(match[0], "src");
    // srcset: take the last (usually largest) candidate's URL.
    const candidate = srcset
      ? srcset
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean)
          .pop()
      : src;
    const clean = usable(candidate ?? null);
    if (clean !== null) return clean;
  }
  return null;
}

/**
 * What a sharpened picture falls back to, when the full-size file is not there
 * after all: the crop the feed named. Remembered per URL so a picture that 404s
 * on the way up does not 404 twice.
 */
const cropOf = new Map<string, string>();

export function cropVariant(url: string): string | null {
  return cropOf.get(url) ?? null;
}

/** A resolved picture, sharpened to full size when the feed named only a crop. */
function sharpen(resolved: string, kind: ThumbKind): Thumb {
  const bigger = fullSize(resolved);
  if (bigger === null) return { url: resolved, kind };
  cropOf.set(bigger, resolved);
  return { url: bigger, kind, fallback: resolved };
}

export function thumbnailOf(item: ThumbSource): Thumb {
  const base = item.alternate?.[0]?.href ?? null;

  for (const enclosure of item.enclosure ?? []) {
    if (enclosure && isImageType(enclosure.type)) {
      const url = usable(enclosure.href);
      if (url !== null) {
        const resolved = resolveUrl(url, base);
        if (resolved !== null) return sharpen(resolved, "enclosure");
      }
    }
  }

  for (const thumb of item.media?.thumbnail ?? []) {
    const url = usable(thumb?.url);
    if (url !== null) {
      const resolved = resolveUrl(url, base);
      if (resolved !== null) return sharpen(resolved, "media");
    }
  }

  for (const content of item.media?.content ?? []) {
    if (content && isImageType(content.type)) {
      const url = usable(content.url);
      if (url !== null) {
        const resolved = resolveUrl(url, base);
        if (resolved !== null) return sharpen(resolved, "media");
      }
    }
  }

  for (const html of [item.content?.content, item.summary?.content]) {
    const found = firstImageIn(html);
    if (found !== null) {
      const resolved = resolveUrl(found, base);
      if (resolved !== null) return sharpen(resolved, "inline");
    }
  }

  return NONE;
}

/**
 * The separate pictures that make up one strip.
 *
 * Comics Kingdom publishes a daily strip as several images labelled
 * "Beetle Bailey - Panel 1", "- Panel 2" and so on. A card that showed the
 * first of them showed a third of the joke, which is why the same layout
 * looked right for a single-picture feed and wrong for these. Only pictures
 * that name themselves as panels are collected, so a post with a photo and an
 * unrelated illustration is left alone, and one panel on its own is just a
 * thumbnail.
 */
const PANEL_ALT = /\bpanel\s*\d+/i;

export function panelsOf(item: ThumbSource): string[] {
  const base = item.alternate?.[0]?.href ?? null;
  const found: string[] = [];
  for (const html of [item.content?.content, item.summary?.content]) {
    if (typeof html !== "string" || html === "") continue;
    const tag = /<img\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tag.exec(html)) !== null) {
      const alt = attr(match[0], "alt");
      if (alt === null || !PANEL_ALT.test(alt)) continue;
      const srcset = attr(match[0], "srcset");
      const candidate = srcset
        ? srcset
            .split(",")
            .map((part) => part.trim().split(/\s+/)[0])
            .filter(Boolean)
            .pop()
        : attr(match[0], "src");
      const url = usable(candidate ?? null);
      if (url === null) continue;
      const resolved = resolveUrl(url, base);
      if (resolved === null) continue;
      // A panel is drawn across the whole card, so a crop is upscaled into mush
      // exactly as a thumbnail's would be: the same sharpening, and the same
      // remembered crop to fall back to when the publisher has no full-size file.
      const sharp = fullSize(resolved);
      if (sharp !== null) cropOf.set(sharp, resolved);
      const use = sharp ?? resolved;
      if (!found.includes(use)) found.push(use);
    }
    if (found.length > 0) break;
  }
  return found.length > 1 ? found : [];
}

/** Every picture the body offers, in order, for a post that is more than one. */
export function imagesOf(item: ThumbSource, limit = 12): string[] {
  const base = item.alternate?.[0]?.href ?? null;
  const found: string[] = [];
  for (const html of [item.content?.content, item.summary?.content]) {
    if (typeof html !== "string" || html === "") continue;
    const tag = /<img\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tag.exec(html)) !== null) {
      const srcset = attr(match[0], "srcset");
      const candidate = srcset
        ? srcset
            .split(",")
            .map((part) => part.trim().split(/\s+/)[0])
            .filter(Boolean)
            .pop()
        : attr(match[0], "src");
      const url = usable(candidate ?? null);
      if (url === null) continue;
      const resolved = resolveUrl(url, base);
      if (resolved === null) continue;
      const sharp = fullSize(resolved);
      if (sharp !== null) cropOf.set(sharp, resolved);
      const use = sharp ?? resolved;
      if (!found.includes(use)) found.push(use);
      if (found.length >= limit) return found;
    }
    if (found.length > 0) break;
  }
  return found;
}
