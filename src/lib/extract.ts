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
 *    is smaller than what the feed already sent, the feed wins.
 */

/** Off unless it was turned on: extraction costs a network request per post. */
export const EXTRACT_DEFAULT = false;

/** Below this many characters of text, an extraction is not worth showing. */
const MIN_TEXT = 300;

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

/** Characters of text in a fragment of HTML, for the size comparison below. */
export function textLength(html: string): number {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * The feed's version, or the extracted one when the extraction is worth it.
 *
 * `MIN_TEXT` rejects a paywall stub. The `FEED_RATIO` check rejects an
 * extraction that found less than the feed already had: many feeds ship the full
 * article, and stripping it down to a caption is a regression, not a cleanup.
 */
export function chooseBody(extracted: Extracted | null, feedHtml: string): Body {
  if (extracted === null || extracted.textLength < MIN_TEXT) {
    return { html: feedHtml, source: "feed" };
  }
  const feedText = textLength(feedHtml);
  if (feedText >= MIN_TEXT && extracted.textLength < feedText * 0.6) {
    return { html: feedHtml, source: "feed" };
  }
  return { html: extracted.html, source: "article" };
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
    const doc = new DOMParser().parseFromString(html, "text/html");
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
      html: article.content,
      title: article.title ?? "",
      byline: article.byline ?? "",
      textLength: text.trim().length,
    };
  } catch {
    return null;
  }
}

/**
 * The page, or nothing.
 *
 * In the Tauri window this goes through `plugin-http`, which is not subject to
 * CORS and is already permitted for every http(s) URL. In a plain browser it is
 * an ordinary fetch, which most publishers refuse — that failure is expected and
 * handled by returning null, not by reporting an error.
 */
export async function fetchArticle(url: string, timeoutMs = 8000): Promise<string | null> {
  if (!canExtract(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const doFetch: typeof fetch =
      "__TAURI_INTERNALS__" in globalThis
        ? ((await import("@tauri-apps/plugin-http")).fetch as typeof fetch)
        : globalThis.fetch;
    if (typeof doFetch !== "function") return null;
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
      // Tauri's fetch understands this; the browser ignores it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ connectTimeout: timeoutMs } as any),
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (type !== "" && !type.includes("html")) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_BYTES) return null;
    return text;
  } catch {
    // Timeout, CORS, DNS, offline: all the same answer — use what the feed sent.
    return null;
  } finally {
    clearTimeout(timer);
  }
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

/** Extract a page for one entry, remembering it. Null means "keep the feed's text". */
export async function extractFor(id: string, url: string): Promise<Extracted | null> {
  const remembered = rememberedExtraction(id);
  if (remembered) return remembered;
  const page = await fetchArticle(url);
  if (page === null) return null;
  const extracted = await extractFromHtml(page, url);
  if (extracted) rememberExtraction(id, extracted);
  return extracted;
}
