/**
 * Reader view: keep the article, drop the page around it.
 *
 * Feeds carry whatever their publisher chose to send — sometimes the whole
 * piece, sometimes two sentences and a "read more". Extraction fetches the
 * original page and keeps the part that is the article, which is the only way
 * to read a summary-only feed inside the app.
 *
 * Two things are deliberate here:
 *
 * 1. **It can fail, and failing is silent.** No CORS in a browser, a paywall, a
 *    cookie wall, a page that is all JavaScript, a 404 — every one of those ends
 *    with the feed's own text still on screen. A reader that shows an error
 *    instead of the article is worse than one that shows less of the article.
 * 2. **A thin extraction is thrown away.** Readability will happily return the
 *    three sentences of a cookie notice and call it the article; if the result
 *    is smaller than what the feed already sent — or kept none of its pictures —
 *    the feed wins.
 *
 * A failure is also remembered (see `extract-ledger.ts`), with a retry time that
 * depends on what went wrong, so a paywall is not fetched once per post for the
 * rest of time.
 *
 * Pictures are part of the article, so `promoteImages()` runs over Readability's
 * output before it is returned. Readability's own lazy-image pass skips any
 * image whose `src` is non-empty (its guard is `if (elem.src …) return`), so a
 * spacer in `src` survives with the real URL abandoned in `data-original`, and
 * the tag keeps width/height that describe the placeholder rather than the
 * picture. Measured against a stub publisher: of four pictures, one rendered as
 * a 1×1 blank while its real file was never requested, and one was a refused
 * 403 frame showing alt text.
 */

import { ledger, type BodyChoice, type FailureKind } from "./extract-ledger";
import { attr, firstImageIn, resolveUrl } from "./thumb";

/** Off unless it was turned on: extraction costs a network request per post. */
export const EXTRACT_DEFAULT = false;

/** Below this many characters of text, an extraction is not worth showing. */
const MIN_TEXT = 300;

/**
 * A feed with this many pictures and an extraction with none is a gallery that
 * was stripped: three is low enough that a two-thumbnail post still loses to a
 * clean extraction, high enough that a real gallery is not mistaken for a
 * thumbnail.
 */
const GALLERY_MIN = 3;

/** Above this size the page is not an article, it is a download. */
const MAX_BYTES = 3_000_000;

/** Which text ends up on screen, and where it came from. */
export type BodySource = "article" | "feed";

export interface Body {
  html: string;
  source: BodySource;
}

export interface Extracted {
  html: string;
  title: string;
  byline: string;
  /** Characters of text, used to decide whether the extraction is worth it. */
  textLength: number;
}

/** Only a web page can be fetched; `mailto:` and `javascript:` cannot. */
export function canExtract(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The words in a fragment of HTML, one space between them.
 *
 * Tags become a space rather than nothing, so `a</p><p>b` does not fuse into
 * `ab`; entities become a space too, because `&nbsp;` is not a character of the
 * article. `script` and `style` are dropped whole — their contents are not text
 * a reader sees, and counting them lets a cookie banner look like an article.
 */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Characters of text in a fragment of HTML, for the size comparison below. */
export function textLength(html: string): number {
  return plainText(html).length;
}

/**
 * Where a lazy image keeps its real source, in the order they are trusted:
 * `srcset` first because a `w`/`x` descriptor set contains the largest file by
 * construction, then the lazy stand-ins publishers swap in at load time.
 */
const SRCSET_ATTRS = ["srcset", "data-srcset"] as const;
/**
 * The lazy stand-ins publishers swap in at load time. `data-src` and
 * `data-original` are the common pair; `data-lazy-src` is WordPress's
 * `lazy-load` plugin, `data-cfsrc` is Cloudflare's Mirage, and
 * `data-original-src` is the one several magazine themes use. All four mean the
 * same thing, so they are asked in the same place instead of being special-cased
 * per publisher.
 */
const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-cfsrc", "data-original-src"] as const;

/** `&amp;` in an attribute is the URL's `&`; the filter and resolver want the URL. */
function decodeAttr(value: string): string {
  return value.replace(/&amp;/gi, "&");
}

/** The reverse, for writing a URL back into markup. */
function encodeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** One attribute out of a tag, all of it: name, `=` and the value as written. */
function withoutAttr(tag: string, name: string): string {
  const re = new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\u0060]+)`, "i");
  return tag.replace(re, "");
}

/**
 * The candidate a `srcset` would pick at full width: the largest descriptor,
 * not the last one written. `640w` and `2x` are different units but both mean
 * "more pixels", and a set written in descending order would otherwise give the
 * smallest file. A candidate with no descriptor counts as 1x, and a tie keeps
 * the later one, so `a.jpg, b.jpg` ends up as `b.jpg` the way a browser would.
 */
function largestFrom(srcset: string): string | null {
  let best: string | null = null;
  let bestWeight = -Infinity;
  for (const candidate of srcset.split(",")) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    const parsed = Number.parseFloat(descriptor ?? "");
    const weight = Number.isFinite(parsed) ? parsed : 1;
    if (weight >= bestWeight) {
      best = url;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * The filter a row's thumbnail already applies, asked rather than copied: a
 * spacer, a beacon, a `javascript:` or a non-image `data:` source is refused by
 * `thumb.ts`, and a second list of tracker names here would drift from it.
 */
function usableSource(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const accepted = firstImageIn(`<img src="${encodeAttr(trimmed)}">`);
  return accepted === null ? null : decodeAttr(accepted);
}

/**
 * The real picture behind a `<noscript>`.
 *
 * A lazy-loading page ships a placeholder in `src` and puts the markup a browser
 * *without* JavaScript would have seen in `<noscript>` — usually the same `<img>`
 * with its real `src`. A parser has no JavaScript, so that copy is the only one
 * a reader can ever see, and Readability leaves `<noscript>` where it is: the
 * article arrives with a blank frame and no picture at all. Unwrapping the
 * element before parsing is what lets `promoteImages()` find the tag at all.
 *
 * Only a `<noscript>` that holds a picture is unwrapped. The others hold
 * "enable JavaScript" banners and tracking pixels, which are not the article.
 */
export function unwrapNoscriptImages(html: string): string {
  if (typeof html !== "string" || html === "") return html;
  return html.replace(
    /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi,
    (whole: string, inner: string) => (/<(?:img|picture|source)\b/i.test(inner) ? inner : whole),
  );
}

/**
 * The article's pictures, loadable.
 *
 * Readability passes lazy markup through: a page that ships a 1×1 blank in
 * `src` and the real file in `data-src`, `data-srcset` or `data-original` lands
 * in the pane as an invisible dot, and the picture the reader came for is never
 * requested. So each `<img>` (and `<source>`, which wins over its `<img>` when
 * a `<picture>` has both) is reduced to one absolute URL in `src` — or removed
 * when every candidate is a spacer or a tracker, which is the same rule a row's
 * thumbnail follows.
 *
 * Two details that matter in the pane:
 *
 * - `width`/`height` are dropped unless the tag's own `src` is what survived,
 *   because otherwise those numbers describe the placeholder. A `width="1"` left
 *   on a promoted picture is not an aspect-ratio hint but a presentational
 *   `width: 1px` that the article's `height: auto` rule cannot undo, so the real
 *   file arrives and draws one pixel wide.
 * - Nothing is fetched here, so a picture the origin will refuse is still in
 *   the markup; `prepareImages()` in the pane drops it when it fails.
 */
export function promoteImages(html: string, base: string | null): string {
  if (typeof html !== "string" || html === "") return html;
  return html.replace(/<(img|source)\b[^>]*>/gi, (tag, name: string) => {
    /** `fromSrc` marks the one attribute whose dimensions describe the picture. */
    const candidates: { value: string; fromSrc: boolean }[] = [];
    for (const attribute of SRCSET_ATTRS) {
      const value = attr(tag, attribute);
      const largest = value === null ? null : largestFrom(decodeAttr(value));
      if (largest !== null) candidates.push({ value: largest, fromSrc: false });
    }
    for (const attribute of LAZY_ATTRS) {
      const value = attr(tag, attribute);
      if (value !== null) candidates.push({ value: decodeAttr(value), fromSrc: false });
    }
    const src = attr(tag, "src");
    if (src !== null) candidates.push({ value: decodeAttr(src), fromSrc: true });

    let chosen: { url: string; fromSrc: boolean } | null = null;
    for (const candidate of candidates) {
      const usable = usableSource(candidate.value);
      if (usable === null) continue;
      const url = resolveUrl(usable, base);
      if (url === null) continue;
      chosen = { url, fromSrc: candidate.fromSrc };
      break;
    }
    // A tag whose only sources were spacers is not a picture: dropping it is
    // what keeps a blank frame out of the column.
    if (chosen === null) return "";

    let out = tag;
    for (const attribute of [...SRCSET_ATTRS, ...LAZY_ATTRS, "src"]) {
      out = withoutAttr(out, attribute);
    }
    if (!chosen.fromSrc) {
      out = withoutAttr(out, "width");
      out = withoutAttr(out, "height");
    }
    const encoded = encodeAttr(chosen.url);
    // `<source>` has no `src`: a `<picture>` reads its `srcset`, so the one URL
    // goes there, undecorated, and the browser takes it at any density.
    const written = name.toLowerCase() === "source" ? `srcset="${encoded}"` : `src="${encoded}"`;
    return out.replace(/^<[a-z]+\b/i, (open) => `${open} ${written}`);
  })
    // A picture that was alone in its paragraph or figure leaves the box behind,
    // and an empty box with a figure's margins is a hole in the column.
    .replace(/<(p|figure)\b[^>]*>\s*<\/\1>/gi, "");
}

/**
 * Every `<img>` source in a fragment, exactly as written.
 *
 * Used to answer "is the feed's lead picture already in this article?" — the
 * pane used to ask with `html.includes(url)`, which misses the same file behind
 * `&amp;`, a query string, or the larger `srcset` candidate that promotion now
 * picks, and would then draw the picture twice.
 */
export function imageSources(html: string | null | undefined): string[] {
  if (typeof html !== "string" || html === "") return [];
  const found: string[] = [];
  const tag = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    const src = attr(match[0], "src");
    if (src !== null) found.push(decodeAttr(src));
  }
  return found;
}

/**
 * Whether two URLs are the same picture.
 *
 * Feeds hand out the enclosure at one size and the body links the same file at
 * another — `?w=640`, `#top`, and the WordPress/Shopify habit of parking a
 * resized copy beside the original as `photo-1024x683.jpg` — and promotion can
 * pick a larger variant than the one in `src`. Scheme, query and fragment are
 * not what makes a picture, and neither is a size suffix, so host, folder and
 * the name with that suffix removed decide.
 *
 * The suffix shapes are the ones that mean "same file, other pixels": `-1024x683`,
 * `-640w`, `-800h`, `-scaled`, `@2x` — what WordPress, Shopify and the usual
 * CDNs write. A bare number is deliberately not one of them: `cover-2024.jpg` is
 * as likely to be a different photograph as a size, and drawing the lead is the
 * harmless way to be wrong.
 */
const SIZE_SUFFIX = /(?:[-_]\d+x\d+|[-_]\d+[wh]|[-_]scaled|@\d+x)+$/i;

export function sameImage(a: string, b: string): boolean {
  const key = (url: string): string => {
    const raw = decodeAttr(url.trim());
    try {
      const parsed = new URL(raw);
      const name = parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot).toLowerCase().replace(/^\.jpeg$/, ".jpg") : "";
      const folder = parsed.pathname.slice(0, parsed.pathname.length - name.length);
      return `${parsed.host.toLowerCase()}${folder}${stem.replace(SIZE_SUFFIX, "")}${extension}`;
    } catch {
      return raw;
    }
  };
  return a.trim() !== "" && b.trim() !== "" && key(a) === key(b);
}

/**
 * The feed's version, or the extracted one when the extraction is worth it.
 *
 * `MIN_TEXT` rejects a paywall stub. The `FEED_RATIO` check rejects an
 * extraction that found less than the feed already had: many feeds ship the full
 * article, and stripping it down to a caption is a regression, not a cleanup.
 * The same is true of pictures — a feed that carried a gallery and an extraction
 * that kept none of it is a worse article, not a cleaner one — so a feed with
 * several pictures and an extraction with none loses too.
 */
export function chooseBody(extracted: Extracted | null, feedHtml: string): Body {
  if (extracted === null || extracted.textLength < MIN_TEXT) {
    return { html: feedHtml, source: "feed" };
  }
  const feedText = textLength(feedHtml);
  if (feedText >= MIN_TEXT && extracted.textLength < feedText * 0.6) {
    return { html: feedHtml, source: "feed" };
  }
  const feedPictures = imageSources(feedHtml).length;
  if (feedPictures >= GALLERY_MIN && imageSources(extracted.html).length === 0) {
    return { html: feedHtml, source: "feed" };
  }
  return { html: extracted.html, source: "article" };
}

/**
 * What to show, given what the reader asked for on this post.
 *
 * `null` is the automatic rule, which is `chooseBody()`: the feed's text unless
 * the extraction is at least as good. `"feed"` is absolute — it never fetches and
 * never shows a paywall stub, which is the whole point of asking for it. And
 * `"article"` is *not* absolute either: it asks for the extraction to be fetched,
 * but a page that comes back thin still loses to the feed. "Give me the article"
 * is not a request to read a cookie notice.
 */
export function bodyFor(
  choice: BodyChoice | null,
  extracted: Extracted | null,
  feedHtml: string,
): Body {
  if (choice === "feed") return { html: feedHtml, source: "feed" };
  return chooseBody(extracted, feedHtml);
}

/**
 * Run Readability over a page and keep the article.
 *
 * Needs a real DOM, so it cannot run in the Node tests — those cover the
 * decisions above, and a browser harness proved this against real pages.
 *
 * The library is imported on demand: it is the biggest thing this feature adds,
 * and with the setting off nobody should pay for it in the first paint.
 */
export async function extractFromHtml(html: string, url: string): Promise<Extracted | null> {
  if (typeof DOMParser === "undefined") return null;
  try {
    const { Readability } = await import("@mozilla/readability");
    const doc = new DOMParser().parseFromString(unwrapNoscriptImages(html), "text/html");
    // The parser has no way to know the page's own address, and Readability
    // resolves relative links against it — without this, every href in the
    // article would point at the app.
    const base = doc.createElement("base");
    base.setAttribute("href", url);
    doc.head?.prepend(base);

    const article = new Readability(doc, { charThreshold: MIN_TEXT }).parse();
    if (!article?.content) return null;
    const text = article.textContent ?? "";
    return {
      html: promoteImages(article.content, url),
      title: article.title ?? "",
      byline: article.byline ?? "",
      textLength: text.trim().length,
    };
  } catch {
    return null;
  }
}

/** What a page turned out to be: the markup, or the reason there is none. */
export type Page = { html: string } | { failure: FailureKind };

/**
 * The page, or why not.
 *
 * In the Tauri window this goes through `plugin-http`, which is not subject to
 * CORS and is already permitted for every http(s) URL. In a plain browser it is
 * an ordinary fetch, which most publishers refuse — that failure is expected and
 * handled by returning a reason, not by reporting an error.
 *
 * The reason matters, because the ledger keeps it: a 4xx or a non-HTML answer
 * will not change in a hurry, while a timeout or a 5xx may be gone by the next
 * post.
 */
export async function fetchPage(url: string, timeoutMs = 8000): Promise<Page> {
  if (!canExtract(url)) return { failure: "refused" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const doFetch: typeof fetch =
      "__TAURI_INTERNALS__" in globalThis
        ? ((await import("@tauri-apps/plugin-http")).fetch as typeof fetch)
        : globalThis.fetch;
    if (typeof doFetch !== "function") return { failure: "unreachable" };
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
      // Tauri's fetch understands this; the browser ignores it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ connectTimeout: timeoutMs } as any),
    });
    // A server that is merely broken answers 5xx; the publisher has not decided
    // anything, so the page is worth another try sooner than a refusal is.
    if (!response.ok) return { failure: response.status >= 500 ? "unreachable" : "refused" };
    const type = response.headers.get("content-type") ?? "";
    if (type !== "" && !type.includes("html")) return { failure: "refused" };
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_BYTES) return { failure: "refused" };
    const text = await response.text();
    if (text.length > MAX_BYTES) return { failure: "refused" };
    return { html: text };
  } catch {
    // Timeout, CORS, DNS, offline: all the same answer — use what the feed sent.
    return { failure: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The page, or nothing. Kept for callers that only want the markup. */
export async function fetchArticle(url: string, timeoutMs = 8000): Promise<string | null> {
  const page = await fetchPage(url, timeoutMs);
  return "html" in page ? page.html : null;
}

/**
 * Extracted bodies, by entry id, for this session only.
 *
 * Moving between posts and back is the common path — next, next, previous — and
 * refetching the same page each time would make the arrows feel slow. Four is
 * enough for going back and forth without holding a session's worth of other
 * people's articles in memory.
 */
const memo = new Map<string, Extracted>();
const MEMO_MAX = 4;

export function rememberedExtraction(id: string): Extracted | null {
  const hit = memo.get(id);
  if (!hit) return null;
  // Refresh its place in the queue.
  memo.delete(id);
  memo.set(id, hit);
  return hit;
}

export function rememberExtraction(id: string, extracted: Extracted): void {
  memo.set(id, extracted);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

export interface ExtractOptions {
  /**
   * An explicit press, not an automatic fetch: a URL the ledger has parked is
   * asked again. This is what makes "try again" mean anything — otherwise the
   * reader pressing the button a second time would be answered from the ledger
   * without a request ever leaving the app.
   */
  force?: boolean;
}

/**
 * Extract a page for one entry, remembering it and remembering when it refuses.
 *
 * Null means "keep the feed's text" — a parked URL, a refusal or a page with no
 * article in it all end the same way on screen, which is the point.
 */
export async function extractFor(
  id: string,
  url: string,
  options: ExtractOptions = {},
): Promise<Extracted | null> {
  const remembered = rememberedExtraction(id);
  if (remembered) return remembered;
  // Paying a publisher's timeout on every post that links to a page it will
  // never serve is the behaviour this avoids: a parked page is not asked again
  // until its retry time, and only an explicit press gets past that.
  if (!options.force && ledger.parked(url)) return null;
  const extracted = await extractOnce(url);
  if (extracted === null) return null;
  rememberExtraction(id, extracted);
  return extracted;
}

/**
 * Pages being extracted right now, by URL.
 *
 * Two callers can want the same page in the same moment — the queue preparing
 * the posts ahead, and the pane for the post the reader has just opened — and a
 * publisher should not be asked twice for one article. The second caller waits on
 * the first request instead of starting one: one fetch, one parse, one ledger
 * entry, and the article lands for both at once.
 */
const running = new Map<string, Promise<Extracted | null>>();

function extractOnce(url: string): Promise<Extracted | null> {
  const going = running.get(url);
  if (going !== undefined) return going;
  const started = extractPage(url).finally(() => running.delete(url));
  running.set(url, started);
  return started;
}

/** One page, from request to article, with what the ledger learns from it. */
async function extractPage(url: string): Promise<Extracted | null> {
  const page = await fetchPage(url);
  if ("failure" in page) {
    ledger.record(url, page.failure);
    return null;
  }
  const extracted = await extractFromHtml(page.html, url);
  if (extracted === null || extracted.textLength < MIN_TEXT) {
    // The page arrived and it was not an article: a cookie wall, a paywall stub,
    // a JavaScript shell. Same markup tomorrow, so it is parked for a day.
    ledger.record(url, "thin");
    return null;
  }
  ledger.forgive(url);
  return extracted;
}
