/**
 * One page drawn from several accounts, and the way back for every mark made on it.
 *
 * The registry answers *whose* an account is. This answers the other half of the
 * same question: when Pane 2 draws rows from three accounts in one column, what is a
 * row's identity, and how does marking it read end up on the account it came from.
 *
 * **The account is carried by the id, not looked up beside it.** Two accounts
 * subscribed to the same feed emit the *same* GReader item id — `tag:google.com,
 * 2005:reader/item/<hash>` is derived from the feed entry, not from the account that
 * fetched it. So a `Map<itemId, slug>` filled while serving a page would let the
 * second account overwrite the first, and a mark intended for A would land on B: the
 * exact failure HR-103 exists to prevent. Composing the slug into the id makes that
 * impossible to express — `a1b2c3d4/tag:google.com,2005:reader/item/abc` belongs to
 * one account and says so, and a backend is never handed the prefix.
 *
 * **A refusal is total.** Every id is checked before a single call goes out. Sending
 * the ids that resolve and throwing on the one that does not would leave a feed half
 * marked and an error on screen, which is worse than a refusal the caller can retry.
 *
 * **A merged stream has no continuation.** Pages from two accounts interleave by
 * date, so "the next page" is not one account's next page — it is a page of each,
 * re-merged, and the second page of account A may be older than the first page of B.
 * Deep scroll into a merged view needs per-account cursors carried alongside the
 * rows, which the reader does not have yet; until then the merged view reads the
 * first page of each account and says so rather than pretending to page.
 *
 * **One unreachable account does not blank the page.** The failures are returned
 * beside the rows (`MergedContents.failures`) so the column can draw what answered
 * and name what did not. Only when every account failed does `stream` throw, because
 * an empty page and a broken page must not look the same.
 *
 * **`enabled` decides what is read, never what may be written.** An account turned
 * off for the merged view is still signed in (`AccountRegistry.enabled`), and a row
 * from it can still be on screen from a saved list or a search. Its marks go home.
 *
 * What this is not: a `ReaderBackend`. It has no `subscribe`, no `fetchNew`, no
 * capability probe and no queue — you do not subscribe inside a merged view, and
 * there is no single session to crawl or flush. Writes are the reader's decision
 * delegated by slug (`markRead`, `markStarred`), not a broadcast.
 */
import type { ReaderBackend } from "./backend";
import type { StreamContents, StreamItem } from "./freshrss";
import type { AccountRegistry } from "./registry";
import type { ReaderProfile } from "./profile";

/** Slugs are 8 hex characters today; the shape is asserted so an id can be trusted. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The separator between a slug and the id its backend spelled. Never in a slug. */
export const AGGREGATE_SEPARATOR = "/";

/** One row's identity: the account, then the id the provider gave it. */
export function composeId(slug: string, itemId: string): string {
  return `${slug}${AGGREGATE_SEPARATOR}${itemId}`;
}

/**
 * The account and the provider's own id, or `null` when this is not a composed id.
 *
 * `null` rather than a throw because this is asked on drawing paths (which row is
 * whose) as well as on write paths; the write path is what refuses.
 */
export function splitId(composed: string): { slug: string; itemId: string } | null {
  const at = composed.indexOf(AGGREGATE_SEPARATOR);
  if (at <= 0 || at >= composed.length - 1) return null;
  const slug = composed.slice(0, at);
  if (!SLUG_SHAPE.test(slug)) return null;
  return { slug, itemId: composed.slice(at + 1) };
}

/** An id that does not name an account this window can write to. */
export class UnknownAccountError extends Error {
  readonly slug: string;
  readonly itemId: string | null;

  constructor(composed: string) {
    const split = splitId(composed);
    super(
      split
        ? `No account "${split.slug}" is signed in here, so "${split.itemId}" cannot be marked.`
        : `"${composed}" does not name an account, so it cannot be marked.`,
    );
    this.name = "UnknownAccountError";
    this.slug = split?.slug ?? "";
    this.itemId = split?.itemId ?? null;
  }
}

/** An account whose page could not be read, and why, for the strip beside the rows. */
export interface AccountFailure {
  slug: string;
  label: string;
  message: string;
}

/** A merged page: the rows that answered, plus the accounts that did not. */
export interface MergedContents extends StreamContents {
  failures: AccountFailure[];
}

/** What a fan-out write did, per account. */
export interface WriteOutcome {
  sent: string[];
  failed: AccountFailure[];
}

/** What a fan-out refresh did, per account. */
export interface RefreshOutcome {
  refreshed: string[];
  failed: AccountFailure[];
}

/** The four reasons `fetchNew` accepts, spelled once. */
export type RefreshWake = "launch" | "resume" | "background" | "manual";

/**
 * The order the merged column is drawn in: newest first, and a stable tiebreak so
 * two items published in the same second do not swap places between renders.
 */
function rank(item: StreamItem): number {
  if (item.timestampUsec) {
    const usec = Number(item.timestampUsec);
    if (Number.isFinite(usec)) return usec;
  }
  return (item.published ?? 0) * 1_000_000;
}

/**
 * Merges pages that have already been read, composing each item's id with its slug.
 *
 * Pure, and exported, because the order and the dedupe are the part worth testing
 * without a network or a registry in the way.
 */
export function mergePages(
  id: string,
  pages: { slug: string; contents: StreamContents }[],
): StreamContents {
  const seen = new Set<string>();
  const items: StreamItem[] = [];
  let updated: number | undefined;

  for (const { slug, contents } of pages) {
    if (contents.updated !== undefined) {
      updated = updated === undefined ? contents.updated : Math.max(updated, contents.updated);
    }
    for (const item of contents.items ?? []) {
      const composed = composeId(slug, item.id);
      if (seen.has(composed)) continue;
      seen.add(composed);
      items.push({ ...item, id: composed });
    }
  }

  items.sort((left, right) => {
    const byTime = rank(right) - rank(left);
    if (byTime !== 0) return byTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  return { id, updated, items };
}

/** The reading UI's window onto every signed-in account. */
export class AccountAggregate {
  private readonly accounts: AccountRegistry;

  constructor(accounts: AccountRegistry) {
    this.accounts = accounts;
  }

  /** The accounts a merged view reads, in the order Pane 1 draws them. */
  readers(): { slug: string; profile: ReaderProfile; backend: ReaderBackend }[] {
    const out: { slug: string; profile: ReaderProfile; backend: ReaderBackend }[] = [];
    for (const profile of this.accounts.enabled()) {
      const backend = this.accounts.backend(profile.slug);
      if (backend) out.push({ slug: profile.slug, profile, backend });
    }
    return out;
  }

  /**
   * One page of `streamId` from every enabled account, merged.
   *
   * Answers `failures` beside the rows; throws only when *nothing* answered.
   */
  async stream(
    streamId: string,
    options?: Parameters<ReaderBackend["stream"]>[1],
  ): Promise<MergedContents> {
    const readers = this.readers();
    const settled = await Promise.allSettled(
      readers.map(async (reader) => ({
        slug: reader.slug,
        contents: await reader.backend.stream(streamId, options),
      })),
    );

    const answered: { slug: string; contents: StreamContents }[] = [];
    const failures: AccountFailure[] = [];
    settled.forEach((result, index) => {
      const reader = readers[index];
      if (result.status === "fulfilled") {
        answered.push(result.value);
        return;
      }
      failures.push({
        slug: reader.slug,
        label: reader.profile.label,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    if (answered.length === 0) {
      const first = failures[0];
      throw new Error(
        first
          ? `No account could be read: ${first.label} — ${first.message}`
          : "No account is signed in.",
      );
    }

    return { ...mergePages(streamId, answered), failures };
  }

  /** Marks items read or unread, each on the account its id names. */
  async markRead(itemIds: string[], read: boolean): Promise<WriteOutcome> {
    return this.delegate(itemIds, (backend, ids) => backend.setRead(ids, read));
  }

  /** Stars or unstars items, each on the account its id names. */
  async markStarred(itemIds: string[], starred: boolean): Promise<WriteOutcome> {
    return this.delegate(itemIds, (backend, ids) => backend.setStarred(ids, starred));
  }

  /**
   * Brings every enabled account up to date: fetch what has been published, then
   * send whatever that account queued while its server was unreachable.
   *
   * **One account at a time, in Pane 1's order.** A phone that started a local
   * crawl and three network flushes at the same instant would be a burst on the
   * radio at the exact moment the reader is trying to draw, and the local crawl is
   * the expensive one — running it beside a flurry of small writes is how a launch
   * sync comes to feel slow. Sequential also makes the failure order readable: the
   * first account that fails is the first one in the list, not whichever promise
   * settled first.
   *
   * **A failure is one account's, never the set's.** Everything after it still
   * runs; that is the whole reason this exists rather than a `Promise.all` at the
   * call site.
   *
   * **`flush` is forced.** The reason for pressing sync — or for the timer firing —
   * is that the thing which was down may be up again, and a backoff left over from
   * the outage is a wait whose reason has changed.
   *
   * `except` is for the account the reader is already refreshing itself, so a
   * focused account is not fetched twice and its progress bar keeps one owner.
   */
  async refreshAll(
    wake: RefreshWake = "manual",
    options: { except?: string } = {},
  ): Promise<RefreshOutcome> {
    const refreshed: string[] = [];
    const failed: AccountFailure[] = [];

    for (const profile of this.accounts.enabled()) {
      if (options.except !== undefined && profile.slug === options.except) continue;
      const backend = this.accounts.backend(profile.slug);
      if (!backend) continue;
      // A server crawls on its own and a library on this device does not; a
      // backend with neither a fetch nor a queue has nothing to do here and is
      // not counted as refreshed, because nothing was asked of it.
      if (backend.fetchNew === undefined && backend.flush === undefined) continue;
      try {
        if (backend.fetchNew !== undefined) await backend.fetchNew({ wake });
        if (backend.flush !== undefined) await backend.flush(true);
        refreshed.push(profile.slug);
      } catch (error) {
        failed.push({
          slug: profile.slug,
          label: profile.label,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { refreshed, failed };
  }

  /**
   * Groups the ids by account, refuses the whole call if any id is not addressable,
   * then sends each group to its own backend **without** the slug prefix.
   */
  private async delegate(
    itemIds: string[],
    send: (backend: ReaderBackend, ids: string[]) => Promise<void>,
  ): Promise<WriteOutcome> {
    const groups = new Map<string, { backend: ReaderBackend; ids: string[] }>();

    for (const composed of itemIds) {
      const split = splitId(composed);
      const backend = split ? this.accounts.backend(split.slug) : null;
      if (!split || !backend) throw new UnknownAccountError(composed);
      const group = groups.get(split.slug) ?? { backend, ids: [] };
      group.ids.push(split.itemId);
      groups.set(split.slug, group);
    }

    const slugs = [...groups.keys()];
    const settled = await Promise.allSettled(
      slugs.map(async (slug) => send(groups.get(slug)!.backend, groups.get(slug)!.ids)),
    );

    const sent: string[] = [];
    const failed: AccountFailure[] = [];
    settled.forEach((result, index) => {
      const slug = slugs[index];
      if (result.status === "fulfilled") {
        sent.push(slug);
        return;
      }
      failed.push({
        slug,
        label: this.accounts.get(slug)?.label ?? slug,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    return { sent, failed };
  }
}
