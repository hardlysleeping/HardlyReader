/**
 * What a library on this device keeps of the pages it has read.
 *
 * A feed's XML carries a summary, sometimes the whole piece, and nothing else: no
 * address for the post, no article as the publisher wrote it, and no text at all
 * for a feed that sends two sentences and a "continue reading". So a library made
 * only of feed XML is a library of what the feed chose to say — and the pane's
 * article is fetched again every time it is opened, which is why a post read on
 * one device is not a post read on the other.
 *
 * This is the policy for the copy that is fetched and kept: how much text the
 * device holds, and what goes when it is full. Nothing here touches the network
 * or a database, so every number below can be argued with in a test.
 *
 * Two things it deliberately is not:
 *
 * - **Not part of the sync document.** Bodies grow without bound; a document that
 *   carried them would be a document nobody could sync. The library travels, the
 *   copies stay on the device that fetched them, and a second device fetches what
 *   it wants to read.
 * - **Not a picture cache.** Pictures are a separate, larger problem with their
 *   own file sizes and their own budget.
 */

/**
 * When a body is kept.
 *
 * Three answers, because there are three sensible readers: one who does not want
 * anything fetched in the background at all, one who is happy for the post they
 * just opened to be kept, and one who would rather the next few posts were already
 * on disk when they get there.
 *
 * Off is the default. Keeping a body costs a request to the publisher per post,
 * and a fresh install should spend nobody's bandwidth before it is asked to.
 */
export type BodyKeepMode = "off" | "open" | "ahead";

export const BODY_KEEP_DEFAULT: BodyKeepMode = "off";

/** The three answers, in the order they are offered. */
export const BODY_KEEP_MODES: readonly BodyKeepMode[] = ["off", "open", "ahead"];

/**
 * The three words, fixed.
 *
 * "Ahead" rather than "on open and ahead" because the mode is a superset of the
 * one before it — the panel says so in one line under the row rather than
 * spelling it twice in a button.
 */
export const BODY_KEEP_LABELS: Record<BodyKeepMode, string> = {
  off: "Off",
  open: "On open",
  ahead: "Ahead",
};

/** What each answer does, for the button's own title. */
export const BODY_KEEP_TITLES: Record<BodyKeepMode, string> = {
  off: "Keep no article text — the feed's own text is all this device holds",
  open: "Keep the article of every post you open",
  ahead: "Keep the post you open, and prepare the next few in the list too",
};

export function isBodyKeepMode(value: unknown): value is BodyKeepMode {
  return value === "off" || value === "open" || value === "ahead";
}

/* ---------------------------------------------------------------------------
 * The budget
 * ------------------------------------------------------------------------- */

/**
 * How much text one device holds, and the sizes the panel offers.
 *
 * 24 MB is roughly two thousand articles of prose — months of reading, and small
 * enough that no laptop or phone notices it. The per-post ceiling is what stops a
 * single page that is really a book (or an HTML table dump) from taking a tenth of
 * the budget in one press: past it the body is simply not kept, and the post reads
 * from the feed as it did before.
 */
export const BODY_BUDGET_DEFAULT = 24 * 1024 * 1024;

/** The answers the panel offers, in MiB. The middle one is the default. */
export const BODY_BUDGET_CHOICES_MB: readonly number[] = [8, 24, 64];

/** Past this a page is not an article, it is a download. */
export const BODY_MAX_POST = 2 * 1024 * 1024;

export function isBodyBudget(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 1 * 1024 * 1024 && bytes <= 512 * 1024 * 1024;
}

/** One kept body, as the budget sees it: no text, only what eviction needs. */
export interface BodyRecord {
  readonly itemId: string;
  readonly bytes: number;
  /** Seconds, the last time this body was read. What "least recently used" means. */
  readonly usedAt: number;
  /** Seconds, when it was fetched. Breaks ties between two bodies read once. */
  readonly storedAt: number;
}

/** What the device is holding, and what is about to go. */
export interface BodyUsage {
  readonly count: number;
  readonly bytes: number;
}

export interface BodyEviction {
  /** The bodies to delete, least recently used first. */
  readonly drop: readonly string[];
  /** Bytes that deleting them frees. */
  readonly freed: number;
  /** What is left when they are gone. */
  readonly remaining: number;
  /**
   * True when everything left is something a pane is showing. A budget that
   * cannot be met without throwing away the post on screen says so instead of
   * doing it: one over-limit library beats a blank article.
   */
  readonly overLimit: boolean;
}

/**
 * Oldest first: least recently used, then least recently fetched, then by id.
 *
 * The id is not a preference, it is a tie-break. Two bodies stamped with the same
 * second are otherwise ordered by whatever the engine returned, and an eviction
 * order that changes between two runs of the same library is not a policy.
 */
function lruFirst(a: BodyRecord, b: BodyRecord): number {
  if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
  if (a.storedAt !== b.storedAt) return a.storedAt - b.storedAt;
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

export interface EvictionOptions {
  /** Bytes allowed on disk. */
  readonly limitBytes: number;
  /**
   * Bodies that must survive this pass: what a pane is drawing right now, and
   * whatever was just written. Only ever a set of ids — a body no one is looking
   * at has no claim on the budget.
   */
  readonly keep?: Iterable<string>;
}

/**
 * Which bodies to delete to get back under the limit.
 *
 * Least recently used first, and only down to the limit: deleting one body more
 * than the budget needs is a page the reader pays for twice. `keep` is honoured
 * even when honouring it leaves the library over the limit — see `overLimit`.
 */
export function planBodyEviction(
  records: readonly BodyRecord[],
  options: EvictionOptions,
): BodyEviction {
  const limit = Math.max(0, options.limitBytes);
  const safe = new Set(options.keep ?? []);
  let total = 0;
  for (const record of records) total += Math.max(0, record.bytes);

  const drop: string[] = [];
  let remaining = total;
  for (const record of [...records].sort(lruFirst)) {
    if (remaining <= limit) break;
    if (safe.has(record.itemId)) continue;
    const bytes = Math.max(0, record.bytes);
    if (bytes === 0) {
      // An empty body costs nothing to keep and frees nothing to drop.
      continue;
    }
    drop.push(record.itemId);
    remaining -= bytes;
  }

  return {
    drop,
    freed: total - remaining,
    remaining,
    overLimit: remaining > limit,
  };
}

/* ---------------------------------------------------------------------------
 * Words
 * ------------------------------------------------------------------------- */

/** Bytes as a reader would say them: "0 B", "940 B", "1.2 MB", "24 MB". */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, Math.round(bytes));
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${tidy(kb)} KB`;
  return `${tidy(kb / 1024)} MB`;
}

/**
 * One decimal below ten, whole numbers above it — and no ".0" on a round number.
 *
 * "24 MB" is the ceiling the reader chose and "24.0 MB" reads like a measurement
 * of something else; "1.2 MB" is a measurement and keeps its decimal.
 */
function tidy(value: number): string {
  if (value >= 10) return String(Math.round(value));
  return String(Number(value.toFixed(1)));
}

/**
 * One line for the panel: what is held, out of what may be.
 *
 * Never a percentage — "24 MB" is the thing the reader chose, and a number that
 * only means something against another number is the sort of status line that
 * teaches nobody anything.
 */
export function describeBodies(usage: BodyUsage, limitBytes: number): string {
  const limit = formatBytes(limitBytes);
  if (usage.count === 0) return `No saved text — up to ${limit} can be kept`;
  const held = formatBytes(usage.bytes);
  const articles = usage.count === 1 ? "1 article" : `${usage.count} articles`;
  return `${articles}, ${held} of ${limit}`;
}

/** Whether a write has taken the library past its ceiling. */
export function bodiesOverLimit(usage: BodyUsage, limitBytes: number): boolean {
  return usage.bytes > limitBytes;
}
