/**
 * The offline cache's policy: what stays, what goes, and how big it may get.
 *
 * A local library is the reader's own copy of what a server would otherwise
 * keep for it, and a copy grows: every poll adds a feed's posts, every opened
 * article may leave its extracted body behind. On a desktop that is fine for
 * years; on a phone it is not, and a library that fills the device is worse
 * than one that forgets the oldest thing it can fetch again.
 *
 * The policy is three answers and one number:
 *
 * - `keepRead` — with it off, an article's copy is dropped as soon as the
 *   article has been read. Keeping it is the default: scrolling back through
 *   something already read is ordinary reading, not an accident.
 * - `keepStarred` — a starred post, and every post of a pinned feed, is never
 *   evicted, whatever the limit says. Those are the two marks the reader made
 *   deliberately, and a cache that deletes them is deleting a decision.
 * - `cacheImages` — whether the picture cache stores bytes. It belongs in this
 *   blob rather than beside the pictures so there is one answer to "what is
 *   cached", not two that can disagree.
 * - `limitBytes` — the ceiling on cached article text: bodies and extracted
 *   bodies. `0` means no ceiling. The library's own rows — subscriptions,
 *   titles, summaries, read and star marks — are not cache and are never counted
 *   against it. A limit that threw away the reader's list to save a megabyte
 *   would be answering the wrong question.
 *
 * What is deliberately absent: a "download everything" switch. The reader
 * fetches what it is asked for. A library that pre-emptively mirrored every
 * feed would turn a reader into an archiver, spend the reader's data without
 * being asked, and keep other people's prose far past what reading requires.
 *
 * Everything here is pure — rows in, plan out — so eviction order is provable
 * in Node against both engines instead of by watching a phone fill up.
 *
 * Bytes are *estimated* the same way everywhere: the UTF-8 length of every text
 * value, plus eight bytes for every other value. That is not the file size on
 * disk — SQLite and IndexedDB each add their own overhead — but it is the same
 * number for the same library in both, which is what a limit and a readout
 * need. Say "about" when showing it.
 */
import type { EntryRow, ExtractionRow, FeedRow, FolderRow, PositionRow } from "./schema";

/** One mebibyte, the unit the limit is chosen in. */
export const MB = 1024 * 1024;

/** What the reader has decided the cache may keep. */
export interface CachePolicy {
  /** Ceiling on cached article text in bytes; `0` means no ceiling. */
  limitBytes: number;
  /** Keep the copy of an article after it has been read. */
  keepRead: boolean;
  /** Never evict a starred post, or any post of a pinned feed. */
  keepStarred: boolean;
  /** Let the picture cache store image bytes. */
  cacheImages: boolean;
}

/**
 * The defaults, and the reason for each.
 *
 * 250 MB is roughly ten thousand articles of feed text, or a couple of years of
 * a busy reading list, and is small enough that nobody notices it on a phone.
 * Read copies stay, because a reader scrolls back; stars and pins are protected,
 * because deleting those is deleting a decision. Pictures are on, because a
 * list without them is a list of headlines.
 */
export const CACHE_POLICY_DEFAULT: CachePolicy = {
  limitBytes: 250 * MB,
  keepRead: true,
  keepStarred: true,
  cacheImages: true,
};

/**
 * The ceilings the settings panel offers: no limit, then a doubling ladder.
 *
 * Chosen as a short list rather than a free number because a cache limit is not
 * a value anyone tunes — it is a statement about how much of the device the
 * reader is willing to give up, and five honest answers cover it.
 */
export const CACHE_LIMIT_CHOICES: readonly number[] = [0, 100 * MB, 250 * MB, 500 * MB, 1024 * MB];

/** `1.2 MB`, `340 KB`, `0 B` — a size as a person reads it. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** A ceiling as a row's value: `No limit`, `250 MB`. */
export function formatLimit(bytes: number): string {
  return bytes <= 0 ? "No limit" : formatBytes(bytes);
}

/** How many bytes one text value costs, before the engine's own overhead. */
export function bytesOf(text: string | null | undefined): number {
  if (text === null || text === undefined || text === "") return 0;
  return new TextEncoder().encode(text).length;
}

/** Eight bytes for anything that is not text: a number, a flag or a null. */
const VALUE_OVERHEAD = 8;

function rowBytes(row: Record<string, unknown>, skip: readonly string[] = []): number {
  let total = 0;
  for (const [column, value] of Object.entries(row)) {
    if (skip.includes(column)) continue;
    total += typeof value === "string" ? bytesOf(value) : VALUE_OVERHEAD;
  }
  return total;
}

/** A body worth keeping, as opposed to empty text or no copy at all. */
function hasBody(row: EntryRow): boolean {
  return typeof row.content === "string" && row.content !== "";
}

/**
 * A pinned feed, as the store spells it.
 *
 * Pins are kept as reader stream ids (`feed/<url>`), because that is what the
 * sidebar marks. The library files an article under the feed's URL, so the one
 * has to become the other before a pin can protect anything.
 */
export function pinnedFeedUrls(streamIds: readonly string[]): string[] {
  const urls: string[] = [];
  for (const id of streamIds) {
    const raw = id.startsWith("feed/") ? id.slice("feed/".length) : id;
    if (raw === "") continue;
    let url = raw;
    if (raw.includes("%")) {
      try {
        url = decodeURIComponent(raw);
      } catch {
        url = raw;
      }
    }
    urls.push(url);
  }
  return urls;
}

/** The five tables, as one bundle: everything a cache question reads. */
export interface CacheTables {
  feeds: readonly FeedRow[];
  entries: readonly EntryRow[];
  extractions: readonly ExtractionRow[];
  folders: readonly FolderRow[];
  positions: readonly PositionRow[];
}

/** What the library occupies, and what part of it is cache. */
export interface CacheUsage {
  /** Subscriptions. */
  feeds: number;
  /** Articles in the list, cached or not. */
  items: number;
  /** Articles whose body is stored on this device. */
  cached: number;
  read: number;
  starred: number;
  /** Extractions that produced a body, not the remembered failures. */
  extracted: number;
  /** Bytes of cached article bodies. */
  articleBytes: number;
  /** Bytes of extracted article bodies and their remembered failures. */
  extractionBytes: number;
  /** Bytes of the library itself: subscriptions, list rows, folders, positions. */
  libraryBytes: number;
  /** Everything the library occupies. */
  totalBytes: number;
}

function extractionCost(row: ExtractionRow): number {
  return bytesOf(row.html) + bytesOf(row.error);
}

/**
 * The library's own size, table by table.
 *
 * One pass over rows the caller already read: the panels ask this on open and
 * after a clear, not on every render, so a full scan is the right shape.
 */
export function measureCache(tables: CacheTables): CacheUsage {

  let items = 0;
  let cached = 0;
  let read = 0;
  let starred = 0;
  let articleBytes = 0;
  let libraryBytes = 0;

  for (const row of tables.entries) {
    items += 1;
    if (row.read === 1) read += 1;
    if (row.starred === 1) starred += 1;
    if (hasBody(row)) {
      cached += 1;
      articleBytes += bytesOf(row.content);
    }
    libraryBytes += rowBytes(row, ["content"]);
  }

  let extractionBytes = 0;
  let extracted = 0;
  for (const row of tables.extractions) {
    // A failure with no entry behind it is debris from an article that was
    // already evicted; it costs bytes, so it counts.
    extractionBytes += extractionCost(row);
    if (row.status === "ok" && row.html !== null) extracted += 1;
  }

  for (const row of tables.feeds) libraryBytes += rowBytes(row);
  for (const row of tables.folders) libraryBytes += rowBytes(row);
  for (const row of tables.positions) libraryBytes += rowBytes(row);

  return {
    feeds: tables.feeds.length,
    items,
    cached,
    read,
    starred,
    extracted,
    articleBytes,
    extractionBytes,
    libraryBytes,
    totalBytes: articleBytes + extractionBytes + libraryBytes,
  };
}

/** What applying the policy came to, in the words a row can show. */
export interface CacheReport {
  /** Article bodies dropped. */
  bodies: number;
  /** Extraction rows dropped. */
  extractions: number;
  bytesBefore: number;
  bytesAfter: number;
  /**
   * True when the ceiling could not be met because everything left is
   * protected. The panel says so rather than pretending the limit held.
   */
  overLimit: boolean;
}

/**
 * A report as the sentence a panel can print.
 *
 * It lives here, beside the numbers, because "cleared 12 articles — 4.1 MB
 * freed" is the same sentence whether it came from a prune or a wipe, and two
 * copies of it would drift the first time one of them changed its mind about
 * plural articles.
 */
export function describeCache(report: CacheReport): string {
  const articles = report.bodies;
  const extractions = report.extractions;
  if (articles === 0 && extractions === 0) return "Nothing to clear — the cache is already empty";

  const parts: string[] = [];
  if (articles > 0) parts.push(`${articles} cached article${articles === 1 ? "" : "s"}`);
  if (extractions > 0) parts.push(`${extractions} extracted bod${extractions === 1 ? "y" : "ies"}`);
  const what = parts.length === 1 ? parts[0] : `${parts[0]} and ${parts[1]}`;
  const freed = Math.max(0, report.bytesBefore - report.bytesAfter);
  return `Cleared ${what} — ${formatBytes(freed)} freed`;
}

/** An eviction decided but not yet written. */
export interface EvictionPlan {
  /** Entry keys whose cached body goes. */
  bodies: string[];
  /** Extraction keys that go, including the ones belonging to those bodies. */
  extractions: string[];
  beforeBytes: number;
  afterBytes: number;
  overLimit: boolean;
}

/**
 * Which copies the policy lets go, in the order it lets them go.
 *
 * Three passes, and the order between them is the whole policy:
 *
 * 1. **Read copies, when they are not kept.** `keepRead: false` means the copy
 *    of an article is not wanted after it has been read, so those go at once —
 *    not merely when the limit is reached, which would leave read articles
 *    lying around until the device happened to fill up.
 * 2. **The limit.** Oldest stored first, then by key so two articles stored in
 *    the same second always evict in the same order on every engine. Protected
 *    articles are skipped, never sorted to the end: a protected article is not
 *    a candidate at all.
 * 3. **Leftover extractions.** An extracted body can outlive the feed's own
 *    copy — it was fetched from the article's page and is often the larger of
 *    the two. Once no unprotected body is left, the oldest extractions go,
 *    because opening the article again can fetch its page, while a cached feed
 *    body cannot be recovered once the feed has moved on.
 *
 * If the ceiling still is not met, the plan says so. Nothing protected is
 * sacrificed to make a number look right.
 */
export function planEviction(
  tables: CacheTables,
  policy: CachePolicy,
  pinnedFeeds: readonly string[] = [],
): EvictionPlan {
  const pinned = new Set(pinnedFeeds);
  const extractionFor = new Map(tables.extractions.map((row) => [row.key, row]));

  const protectedRow = (row: EntryRow): boolean =>
    (policy.keepStarred && (row.starred === 1 || pinned.has(row.feed))) ||
    (policy.keepRead && row.read === 1);

  const droppedBodies = new Set<string>();
  const droppedExtractions = new Set<string>();

  let remaining = 0;
  for (const row of tables.entries) if (hasBody(row)) remaining += bytesOf(row.content);
  for (const row of tables.extractions) remaining += extractionCost(row);
  const beforeBytes = remaining;

  const drop = (row: EntryRow): void => {
    droppedBodies.add(row.key);
    remaining -= bytesOf(row.content);
    const extraction = extractionFor.get(row.key);
    if (extraction !== undefined && !droppedExtractions.has(extraction.key)) {
      droppedExtractions.add(extraction.key);
      remaining -= extractionCost(extraction);
    }
  };

  // 1. Read copies, when they are not kept.
  if (!policy.keepRead) {
    for (const row of tables.entries) {
      if (row.read !== 1 || protectedRow(row) || !hasBody(row)) continue;
      drop(row);
    }
  }

  // 2. The limit, oldest first, among what may be evicted at all.
  const limit = policy.limitBytes > 0 ? policy.limitBytes : 0;
  if (limit > 0 && remaining > limit) {
    const candidates = tables.entries
      .filter((row) => hasBody(row) && !protectedRow(row) && !droppedBodies.has(row.key))
      .sort((a, b) => a.stored_at - b.stored_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const row of candidates) {
      if (remaining <= limit) break;
      drop(row);
    }
  }

  // 3. Extractions still standing, oldest first.
  if (limit > 0 && remaining > limit) {
    const leftovers = tables.extractions
      .filter((row) => !droppedExtractions.has(row.key))
      .sort((a, b) => a.extracted_at - b.extracted_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const row of leftovers) {
      if (remaining <= limit) break;
      droppedExtractions.add(row.key);
      remaining -= extractionCost(row);
    }
  }

  return {
    bodies: [...droppedBodies],
    extractions: [...droppedExtractions],
    beforeBytes,
    afterBytes: Math.max(0, remaining),
    overLimit: limit > 0 && remaining > limit,
  };
}

/**
 * Everything the cache holds, on the way out.
 *
 * The blunt version of {@link planEviction}: used by "Clear cache". It drops
 * every body and every extraction and nothing else — subscriptions, titles,
 * summaries, read marks and stars are the library, not the cache, and a wipe
 * that took them would be a data loss wearing a cache's name.
 */
export function planClear(tables: CacheTables): EvictionPlan {
  const bodies = tables.entries.filter(hasBody).map((row) => row.key);
  const extractions = tables.extractions.map((row) => row.key);
  let beforeBytes = 0;
  for (const row of tables.entries) if (hasBody(row)) beforeBytes += bytesOf(row.content);
  for (const row of tables.extractions) beforeBytes += extractionCost(row);
  return { bodies, extractions, beforeBytes, afterBytes: 0, overLimit: false };
}
