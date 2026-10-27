/**
 * RSS and Atom in, the app's own vocabulary out.
 *
 * Local mode has no server to do this part, so this file is the whole of it:
 * take the bytes a feed URL answers with and produce entries that look like the
 * ones a GReader server would have sent. Two consequences shape the code.
 *
 * 1. **A scanner, not a DOM.** Same reason as `opml.ts`: this has to run in
 *    Node for the tests and inside the WebKit view for real, and a full XML
 *    parser would be a dependency for two file formats. Feeds in the wild are
 *    not well-formed enough to deserve one anyway — the scanner reads the
 *    elements it needs and ignores what it does not recognise.
 * 2. **Ids are stable and derived, never random.** A re-fetch of the same feed
 *    has to produce the same ids, or every refresh would look like a hundred new
 *    articles. `guid`/`id` when the feed gives one, the link when it does not,
 *    and a hash of title+date+link as the last resort.
 *
 * What this file does *not* do: fetch, store, or decide what is unread. It turns
 * a document into entries; who asks for the document and what happens to the
 * entries afterwards belongs to the local backend.
 */

export interface ParsedEntry {
  /** Stable across fetches. Never empty. */
  id: string;
  title: string;
  /** The article's own address, when the feed gave one. */
  url: string;
  /** Milliseconds since the epoch, or 0 when the feed carried no usable date. */
  publishedAt: number;
  /** The best body the feed had: `content:encoded` before `description`. */
  content: string;
  author: string;
  /** A lead image worth showing as a thumbnail, if one was declared. */
  image: string;
  /** Raw feed categories/tags, unlabelled: the app's labels are its own. */
  tags: string[];
}

export interface ParsedFeed {
  title: string;
  /** The site's address, not the feed's. */
  siteUrl: string;
  description: string;
  entries: ParsedEntry[];
}

/** Characters an XML text node or attribute can carry, put back. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** `a="1" b='2'` → `{a: "1", b: "2"}`, attribute names lowercased. */
export function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(source);
  while (match !== null) {
    attributes[match[1].toLowerCase()] = unescapeXml(match[3] ?? match[4] ?? "");
    match = pattern.exec(source);
  }
  return attributes;
}

/**
 * The inside of the first `<name>…</name>` in `block`, CDATA unwrapped.
 *
 * Nested elements are kept as markup: a `description` carrying `<p>` and `<img>`
 * is normal, and throwing the tags away would lose the pictures.
 */
function textOf(block: string, name: string): string {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, "i");
  const match = pattern.exec(block);
  if (match === null) return "";
  return unwrap(match[1] ?? "");
}

/** CDATA is data, not markup: unwrap it and leave its contents alone. */
function unwrap(value: string): string {
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let out = "";
  let cursor = 0;
  let match = cdata.exec(value);
  while (match !== null) {
    out += value.slice(cursor, match.index);
    // The body of a CDATA section is already literal: entities in it are text.
    out += match[1] ?? "";
    cursor = match.index + match[0].length;
    match = cdata.exec(value);
  }
  out += value.slice(cursor);
  // A wrapped-in-CDATA body is usually HTML, so keep its tags but still resolve
  // the entities outside the section.
  return unescapeXmlPreservingMarkup(out);
}

/**
 * Entities in HTML bodies: decode the ones that are text, keep `&amp;` last so
 * `&amp;lt;` cannot become `<`.
 */
function unescapeXmlPreservingMarkup(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A date from RSS's RFC-822 or Atom's ISO-8601, in milliseconds. */
export function parseDate(value: string): number {
  const text = value.trim();
  if (text === "") return 0;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  // Some feeds write "GMT" as a trailing word and some write a two-digit year;
  // Date.parse handles neither reliably.
  const cleaned = text
    .replace(/\bUT\b/i, "GMT")
    .replace(/\bEST\b/i, "-0500")
    .replace(/\bEDT\b/i, "-0400")
    .replace(/\bCST\b/i, "-0600")
    .replace(/\bCDT\b/i, "-0500")
    .replace(/\bMST\b/i, "-0700")
    .replace(/\bMDT\b/i, "-0600")
    .replace(/\bPST\b/i, "-0800")
    .replace(/\bPDT\b/i, "-0700");
  const retried = Date.parse(cleaned);
  return Number.isFinite(retried) && retried > 0 ? retried : 0;
}

/** A short, stable, non-cryptographic hash: enough to name an entry that has none. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Every `<tag>…</tag>` block in a document, in order, without its delimiters. */
function blocks(source: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  const found: string[] = [];
  let match = pattern.exec(source);
  while (match !== null) {
    found.push(match[1] ?? "");
    match = pattern.exec(source);
  }
  return found;
}

/** `<link>` in Atom is an element with attributes; in RSS it holds the URL. */
function atomLink(block: string): string {
  const pattern = /<link\b([^>]*?)\/?>/gi;
  let fallback = "";
  let match = pattern.exec(block);
  while (match !== null) {
    const attributes = attributesOf(match[1] ?? "");
    const href = attributes.href ?? "";
    if (href !== "") {
      if (attributes.rel === undefined || attributes.rel === "alternate") return href;
      if (fallback === "") fallback = href;
    }
    match = pattern.exec(block);
  }
  return fallback;
}

/**
 * An image for the entry: an RSS enclosure of an image type, an Atom link with
 * `rel="enclosure"`, or a `media:content` / `media:thumbnail` mid-size picture.
 */
function imageOf(block: string): string {
  for (const match of block.matchAll(/<enclosure\b([^>]*?)\/?>/gi)) {
    const attributes = attributesOf(match[1] ?? "");
    const type = (attributes.type ?? "").toLowerCase();
    const url = attributes.url ?? "";
    if (url !== "" && (type.startsWith("image/") || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url))) return url;
  }
  // Atom says the same thing with a link: rel="enclosure" and an image type.
  for (const match of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attributes = attributesOf(match[1] ?? "");
    if (attributes.rel !== "enclosure") continue;
    const url = attributes.href ?? "";
    const type = (attributes.type ?? "").toLowerCase();
    if (url !== "" && (type.startsWith("image/") || /\/(jpe?g|png|gif|webp|avif)$/i.test(url.split("?")[0] ?? ""))) {
      return url;
    }
  }
  for (const match of block.matchAll(/<media:(?:content|thumbnail)\b([^>]*?)\/?>/gi)) {
    const attributes = attributesOf(match[1] ?? "");
    const url = attributes.url ?? "";
    const medium = (attributes.medium ?? "").toLowerCase();
    if (url !== "" && (medium === "image" || medium === "" || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url))) {
      return url;
    }
  }
  return "";
}

/**
 * The entries of one feed document.
 *
 * RSS 2.0 and Atom 1.0 both, because local mode cannot choose what a site
 * publishes. A document that is neither — an HTML error page, an empty body —
 * returns no entries rather than throwing: the caller asked for articles and
 * there are none, which is a state the list already knows how to show.
 */
export function parseFeed(xml: string, feedUrl = ""): ParsedFeed {
  const source = xml ?? "";
  const isAtom = /<feed\b/i.test(source) && /<entry\b/i.test(source);
  const head = isAtom ? source : source.split(/<item\b/i)[0] ?? source;

  const feed: ParsedFeed = {
    title: textOf(head, "title"),
    siteUrl: isAtom ? atomLink(head) || textOf(head, "link") : textOf(head, "link"),
    description: textOf(head, "description") || textOf(head, "subtitle"),
    entries: [],
  };

  const seen = new Set<string>();
  for (const block of blocks(source, isAtom ? "entry" : "item")) {
    const link = isAtom ? atomLink(block) : textOf(block, "link");
    const declaredId = textOf(block, "guid") || textOf(block, "id");
    const title = textOf(block, "title");
    const content =
      textOf(block, "content:encoded") ||
      textOf(block, "content") ||
      textOf(block, "description") ||
      textOf(block, "summary");
    const publishedAt = parseDate(
      textOf(block, "pubdate") || textOf(block, "published") || textOf(block, "updated") || textOf(block, "date"),
    );

    // The id has to survive a re-fetch. A guid is what the publisher promises is
    // stable; a link is stable in practice; a fingerprint is the fallback for
    // feeds that give neither and would otherwise collide on "".
    const id = declaredId || link || `${feedUrl}#${fingerprint(`${title}\u0000${publishedAt}`)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const tags: string[] = [];
    for (const term of categoryTerms(block)) {
      if (!tags.includes(term)) tags.push(term);
    }

    feed.entries.push({
      id,
      title: title.trim(),
      url: link,
      publishedAt,
      content: content.trim(),
      author: textOf(block, "author") || textOf(block, "dc:creator"),
      image: imageOf(block),
      tags,
    });
  }

  return feed;
}

/**
 * Feed categories, in both dialects: RSS puts the word in the element's body
 * (`<category>Comics</category>`), Atom puts it in a `term` attribute. A feed
 * that uses both is using both, so each element is read for whichever it has.
 */
function categoryTerms(block: string): string[] {
  const terms: string[] = [];
  const pattern = /<category\b([^>]*?)(\/?)>([\s\S]*?)<\/category\s*>|<category\b([^>]*?)\/>/gi;
  let match = pattern.exec(block);
  while (match !== null) {
    if (match[3] !== undefined) {
      const attributes = attributesOf(match[1] ?? "");
      const declared = attributes.term ?? attributes.label ?? "";
      terms.push(declared !== "" ? declared : unescapeXmlPreservingMarkup(match[3]).trim());
    } else {
      const attributes = attributesOf(match[4] ?? "");
      terms.push(attributes.term ?? attributes.label ?? "");
    }
    match = pattern.exec(block);
  }
  return terms.filter((term) => term !== "");
}

/** Whether a document looks like a feed at all, for the "not a feed" message. */
export function looksLikeFeed(body: string): boolean {
  const head = (body ?? "").slice(0, 2000);
  return /<(rss|feed|rdf:rdf)\b/i.test(head);
}
