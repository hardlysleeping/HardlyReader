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

export interface Thumb {
  url: string | null;
  kind: ThumbKind;
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

export function thumbnailOf(item: ThumbSource): Thumb {
  const base = item.alternate?.[0]?.href ?? null;

  for (const enclosure of item.enclosure ?? []) {
    if (enclosure && isImageType(enclosure.type)) {
      const url = usable(enclosure.href);
      if (url !== null) {
        const resolved = resolveUrl(url, base);
        if (resolved !== null) return { url: resolved, kind: "enclosure" };
      }
    }
  }

  for (const thumb of item.media?.thumbnail ?? []) {
    const url = usable(thumb?.url);
    if (url !== null) {
      const resolved = resolveUrl(url, base);
      if (resolved !== null) return { url: resolved, kind: "media" };
    }
  }

  for (const content of item.media?.content ?? []) {
    if (content && isImageType(content.type)) {
      const url = usable(content.url);
      if (url !== null) {
        const resolved = resolveUrl(url, base);
        if (resolved !== null) return { url: resolved, kind: "media" };
      }
    }
  }

  for (const html of [item.content?.content, item.summary?.content]) {
    const found = firstImageIn(html);
    if (found !== null) {
      const resolved = resolveUrl(found, base);
      if (resolved !== null) return { url: resolved, kind: "inline" };
    }
  }

  return NONE;
}
