/**
 * Fetching the feeds this device is subscribed to.
 *
 * In server mode the reader asks FreshRSS for a stream and FreshRSS's own
 * crawler has already done the fetching. A local library has no crawler behind
 * it, so the app is the crawler: this file polls the feeds and writes what they
 * say into the store.
 *
 * Three things shape it.
 *
 * **A wake is not a schedule.** The app is told when it is opened, when the
 * window comes back, and — on iOS — sometimes, in a moment the system picks and
 * never promises. So there is no timer here at all: each feed's row remembers
 * when it was last read, and a wake fetches whatever has gone stale. A launch at
 * 09:00 and a background wake at 09:47 fetch the same feeds in the same order,
 * because the due time lives in the database rather than in a promise about the
 * future. If a wake never comes, nothing breaks; it just happens at the next
 * one.
 *
 * **A poll that changed nothing costs nothing.** The validators the feed
 * declared are stored beside it and sent back as `If-None-Match` /
 * `If-Modified-Since`, so a `304` is the ordinary answer for a feed that has not
 * published since last time. That is the difference between a phone polling
 * thirty feeds on every launch and a phone downloading thirty feeds.
 *
 * **One feed failing is not the poll failing.** Every failure is recorded on the
 * feed that had it — count, message — and the loop carries on to the next feed.
 * A failed poll also spaces the next attempt out (`failures` doubles it), so a
 * site that has been down since Tuesday is not tried on every wake, and the
 * reader is still able to read everything already stored.
 *
 * What this file does not do is decide *when* the app wakes. Launch and resume
 * are the app's events (`auto-sync`, `refresh-on-return` for the server path);
 * on iOS the wake is `BGAppRefreshTask`, which must call `wake("background")`
 * and must not expect to be called at any particular hour. The same call is the
 * whole contract, which is why it lives here rather than in the store.
 */
import { looksLikeFeed, parseFeed } from "../../lib/rss";
import type { FeedRow } from "./schema";
import type { LocalStore } from "./store";

/** The part of a `Response` a poll uses. Declared so a test can fake one. */
export interface FeedResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FeedRequest {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** How the poller reaches the network. `globalThis.fetch` fits as it is. */
export type FeedFetcher = (url: string, request: FeedRequest) => Promise<FeedResponse>;

/**
 * How long a feed is left alone, and how many are fetched per wake.
 *
 * The interval is an hour because that is roughly how often a site publishes
 * anything, and because the reader can open the app ten times in an afternoon
 * without it turning into ten round trips per feed. The cap on feeds per wake is
 * the polite half of the same idea: a library of sixty feeds must not wake the
 * radio sixty times because the app was restarted after a week away, so each
 * wake takes the most stale handful and leaves the rest for the next one.
 *
 * There is no jitter, and it needs none: with a per-feed due time and a bounded
 * number per wake, a wake is already spread across feeds rather than across
 * fetches of the same feed.
 */
export interface RefreshPolicy {
  /** Minutes a successfully read feed is left alone. */
  intervalMinutes: number;
  /** Feeds one wake may fetch, most stale first. */
  maxFeedsPerWake: number;
  /** The longest a feed that keeps failing waits between attempts. */
  maxBackoffMinutes: number;
  /** An attempt that has not answered by then counts as a failure. */
  timeoutMs: number;
}

export const REFRESH_POLICY: RefreshPolicy = {
  intervalMinutes: 60,
  maxFeedsPerWake: 6,
  maxBackoffMinutes: 360,
  timeoutMs: 15_000,
};

/** The most a single failure can multiply the wait by, so the table stays sane. */
const MAX_DOUBLINGS = 6;

/** Seconds between two polls of one feed, given how it has been behaving. */
export function feedIntervalSeconds(
  feed: Pick<FeedRow, "failures">,
  policy: RefreshPolicy = REFRESH_POLICY,
): number {
  const base = policy.intervalMinutes * 60;
  const failures = feed.failures ?? 0;
  if (failures <= 0) return base;
  const doubled = base * 2 ** Math.min(failures, MAX_DOUBLINGS);
  return Math.min(doubled, policy.maxBackoffMinutes * 60);
}

/**
 * When this feed is worth fetching again, in seconds.
 *
 * Zero means now: a feed that has never been attempted has no due time behind
 * it. Otherwise the wait runs from the last attempt, widened by the number of
 * failures in a row — so one rule answers both "this feed is due" and "this feed
 * is broken", and a site that is down is asked once per backoff instead of once
 * per wake.
 */
export function feedDueAt(
  feed: Pick<FeedRow, "fetched_at" | "attempted_at" | "failures">,
  policy: RefreshPolicy = REFRESH_POLICY,
): number {
  // Measured from the last attempt rather than the last success: a feed that has
  // been answering `500` for a day must not be retried on every wake, which is
  // what a due time derived from a stale success would do. A feed never
  // attempted has no due time behind it and is fetched straight away.
  const attempted = Math.max(feed.fetched_at ?? 0, feed.attempted_at ?? 0);
  if (!(attempted > 0)) return 0;
  return attempted + feedIntervalSeconds(feed, policy);
}

export function isFeedDue(
  feed: Pick<FeedRow, "fetched_at" | "attempted_at" | "failures">,
  nowSeconds: number,
  policy: RefreshPolicy = REFRESH_POLICY,
): boolean {
  return nowSeconds >= feedDueAt(feed, policy);
}

/**
 * The feeds one wake should fetch, most stale first.
 *
 * Oldest first rather than in subscription order, because the feed that has been
 * unread the longest is the one most likely to have something new — and because
 * it makes a bounded wake fair: after a week away, the first wake takes the six
 * stalest, the next wake takes the following six, and nothing is starved by
 * sitting at the end of the alphabet.
 */
export function dueFeeds(
  feeds: readonly FeedRow[],
  nowSeconds: number,
  policy: RefreshPolicy = REFRESH_POLICY,
): FeedRow[] {
  return feeds
    .filter((feed) => isFeedDue(feed, nowSeconds, policy))
    .sort((a, b) => feedDueAt(a, policy) - feedDueAt(b, policy) || (a.key < b.key ? -1 : 1))
    .slice(0, Math.max(0, policy.maxFeedsPerWake));
}

/**
 * Why a wake happened.
 *
 * `launch` and `resume` are the app's own events; `background` is the one iOS
 * grants at a time of its choosing; `manual` is a reader asking. The poller
 * treats all four the same on purpose — the only thing that may decide whether a
 * feed is fetched is its own due time — so the reason exists to be reported, not
 * to branch on.
 */
export type WakeReason = "launch" | "resume" | "background" | "manual";

/** One feed that could not be read, and why, in words a reader could be shown. */
export interface RefreshFailure {
  feedUrl: string;
  reason: string;
}

/** What one wake did. Counted, so a caller can say it rather than guess. */
export interface RefreshReport {
  /** What asked for this wake. Recorded for the readout and the suites. */
  wake: WakeReason;
  /** Seconds, when the wake started. */
  at: number;
  /** How many feeds were due, before the per-wake cap. */
  due: number;
  /** How many were actually attempted. */
  attempted: number;
  /** Polls that answered with a feed that had changed (or no validators). */
  changed: number;
  /** Polls answered `304`: the feed has published nothing since last time. */
  notModified: number;
  /** Articles newly stored across every feed. */
  added: number;
  /** Articles handed to the store, including ones it already had. */
  stored: number;
  failures: RefreshFailure[];
  /** True when the caller's signal stopped the loop partway. */
  aborted: boolean;
  /** `offline` when nothing was attempted because there is no network. */
  skipped: "offline" | null;
}

export interface RefreshOptions {
  store: LocalStore;
  fetch: FeedFetcher;
  policy?: RefreshPolicy;
  /** Seconds. Injected so a suite can drive the clock. */
  now?: number;
  /** Asked at each wake; a paused device is not a broken one. */
  online?: () => boolean;
  signal?: AbortSignal;
  /** Why the caller woke it. Defaults to `manual`. */
  wake?: WakeReason;
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A thrown value's message, without trusting that it has one. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  const text = String(error ?? "").trim();
  return text === "" ? "the request failed" : text;
}

/** A feed that is not a feed is a failure worth naming, not an empty success. */
function parseFailure(url: string): RefreshFailure {
  return {
    feedUrl: url,
    reason: `${url} answered with a web page, not a feed`,
  };
}

function statusFailure(url: string, status: number): RefreshFailure {
  if (status === 401 || status === 403) {
    return { feedUrl: url, reason: `${url} refused the request (${status})` };
  }
  if (status === 404 || status === 410) {
    return { feedUrl: url, reason: `${url} is gone (${status})` };
  }
  if (status === 429) {
    return { feedUrl: url, reason: `${url} asked to be fetched less often (429)` };
  }
  return { feedUrl: url, reason: `${url} answered ${status}` };
}

/** The conditional headers for one feed: what it asked us to send back. */
function requestHeaders(feed: FeedRow): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  };
  if (feed.etag !== null && feed.etag !== "") headers["if-none-match"] = feed.etag;
  if (feed.last_modified !== null && feed.last_modified !== "") {
    headers["if-modified-since"] = feed.last_modified;
  }
  return headers;
}

/**
 * Polls every feed that is due, and keeps whatever changed.
 *
 * Feeds are fetched one at a time, in the order {@link dueFeeds} chose. That is
 * slower than a burst of parallel requests and it is the right trade for a
 * poller that runs on a phone: a burst is what makes a wake look like an attack
 * to the sites being read, and the order is the only thing that makes a bounded
 * wake fair. A wake that is worth running for an hour is a bug in the caller,
 * not something this loop should be fast enough to hide.
 *
 * It never throws because of a feed. A network error, a `500`, an HTML page
 * where the feed should be — each becomes one line in `failures` and one
 * increment on that feed's row, and the loop moves on. A failure that does stop
 * the loop is the caller abandoning it (`aborted`) or the store refusing a write,
 * and the store's refusal is a real error worth propagating.
 */
export async function refreshDueFeeds(options: RefreshOptions): Promise<RefreshReport> {
  const policy = options.policy ?? REFRESH_POLICY;
  const at = options.now ?? seconds();
  const report: RefreshReport = {
    wake: options.wake ?? "manual",
    at,
    due: 0,
    attempted: 0,
    changed: 0,
    notModified: 0,
    added: 0,
    stored: 0,
    failures: [],
    aborted: false,
    skipped: null,
  };

  if (options.online !== undefined && !options.online()) {
    // Nothing is attempted and nothing is recorded: being offline is not a
    // failing feed, and counting it as one would push every feed into backoff
    // for the crime of a train tunnel.
    report.skipped = "offline";
    return report;
  }

  const feeds = await options.store.feeds();
  const due = dueFeeds(feeds, at, policy);
  report.due = due.length;

  for (const feed of due) {
    if (options.signal?.aborted) {
      report.aborted = true;
      break;
    }

    report.attempted += 1;
    const outcome = await pollFeed(feed, options, policy, at);
    if (outcome.kind === "aborted") {
      report.aborted = true;
      break;
    }
    if (outcome.kind === "failed") {
      report.failures.push(outcome.failure);
      continue;
    }
    if (outcome.kind === "notModified") {
      report.notModified += 1;
      continue;
    }
    report.changed += 1;
    report.added += outcome.added;
    report.stored += outcome.stored;
  }

  return report;
}

type PollOutcome =
  | { kind: "changed"; added: number; stored: number }
  | { kind: "notModified" }
  | { kind: "failed"; failure: RefreshFailure }
  | { kind: "aborted" };

/**
 * One feed, one attempt, and the store updated with whatever came of it.
 *
 * The articles are written before the row is stamped, so a store that refuses
 * the batch leaves `fetched_at` where it was and the feed is simply due again on
 * the next wake. Stamping first would make a half-written feed look current.
 */
async function pollFeed(
  feed: FeedRow,
  options: RefreshOptions,
  policy: RefreshPolicy,
  at: number,
): Promise<PollOutcome> {
  const controller = new AbortController();
  const state = { timedOut: false };
  // The deadline covers the whole attempt — the request *and* reading its body —
  // because a feed that sends headers and then stalls is the same problem as one
  // that never answers, and a poller that waits forever is a wake that never ends.
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, policy.timeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    return await attempt(feed, options, policy, at, controller.signal, state);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** How a failed request is described, timed out or not. */
function unreachable(url: string, policy: RefreshPolicy, timedOut: boolean): string {
  return timedOut
    ? `${url} did not answer in ${Math.round(policy.timeoutMs / 1000)}s`
    : `${url} could not be reached: `;
}

/** One attempt at one feed, with the request already under a deadline. */
async function attempt(
  feed: FeedRow,
  options: RefreshOptions,
  policy: RefreshPolicy,
  at: number,
  signal: AbortSignal,
  state: { timedOut: boolean },
): Promise<PollOutcome> {
  const url = feed.key;

  let response: FeedResponse;
  try {
    response = await options.fetch(url, { headers: requestHeaders(feed), signal });
  } catch (error) {
    if (options.signal?.aborted) return { kind: "aborted" };
    const reason = state.timedOut
      ? unreachable(url, policy, true)
      : `${unreachable(url, policy, false)}${messageOf(error)}`;
    await options.store.recordFetchFailure(url, { at, error: reason });
    return { kind: "failed", failure: { feedUrl: url, reason } };
  }

  if (response.status === 304) {
    // The validators did their job: the feed is current as of now, and nothing
    // needs to be parsed or stored.
    await options.store.recordFetch(url, {
      at,
      etag: feed.etag,
      lastModified: feed.last_modified,
    });
    return { kind: "notModified" };
  }

  if (response.status < 200 || response.status >= 300) {
    const failure = statusFailure(url, response.status);
    await options.store.recordFetchFailure(url, { at, error: failure.reason });
    return { kind: "failed", failure };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (options.signal?.aborted) return { kind: "aborted" };
    const reason = state.timedOut
      ? unreachable(url, policy, true)
      : `${url} answered but the body could not be read: ${messageOf(error)}`;
    await options.store.recordFetchFailure(url, { at, error: reason });
    return { kind: "failed", failure: { feedUrl: url, reason } };
  }

  if (!looksLikeFeed(body)) {
    const failure = parseFailure(url);
    await options.store.recordFetchFailure(url, { at, error: failure.reason });
    return { kind: "failed", failure };
  }

  const parsed = parseFeed(body, url);
  const written = await options.store.putEntries(
    parsed.entries.map((entry) => ({
      feedUrl: url,
      guid: entry.id,
      title: entry.title === "" ? null : entry.title,
      link: entry.url === "" ? null : entry.url,
      // A feed's author is per-post here, because that is where the name is:
      // the channel's managing editor is not the writer of every article.
      author: entry.author === "" ? null : entry.author,
      // `parseFeed` hands back milliseconds because a browser date is; the
      // schema counts seconds, like every other time in this library.
      published: entry.publishedAt > 0 ? Math.floor(entry.publishedAt / 1000) : null,
      content: entry.content === "" ? null : entry.content,
      enclosure: entry.image === "" ? null : { href: entry.image },
    })),
  );

  await options.store.recordFetch(url, {
    at,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    title: parsed.title === "" ? null : parsed.title,
    siteUrl: parsed.siteUrl === "" ? null : parsed.siteUrl,
  });

  return { kind: "changed", added: written.added, stored: written.stored };
}

export interface RefresherOptions {
  store: LocalStore;
  fetch: FeedFetcher;
  policy?: RefreshPolicy;
  /** Read at each wake, so a reconnect is noticed without a restart. */
  online?: () => boolean;
  /** Seconds. Injected so a suite can drive the clock. */
  now?: () => number;
}

export interface Refresher {
  /**
   * Ask for one wake. Overlapping asks share one run and one report.
   *
   * Launch, a returned window, an iOS background wake and a manual pull can all
   * happen within the same second — a phone unlocked with the app in the
   * foreground is exactly that. Without sharing, each would start its own loop
   * over the same due feeds and the site would be hit twice for nothing. The
   * second caller waits for the answer the first one is already getting.
   */
  wake(reason: WakeReason): Promise<RefreshReport>;
  /** True while a wake is in flight. For a readout, never for a decision. */
  running(): boolean;
}

/**
 * A poller for one store, which can be woken as often as the platform likes.
 *
 * The due time is the only thing that decides whether work happens, so a wake
 * that arrives early returns a report with `attempted: 0` and costs nothing —
 * no timer to reset, no state to keep warm, nothing to go stale while the app is
 * suspended. That is what makes the opportunistic iOS wake safe to wire up: the
 * system may call it at dawn or not at all, and the library is current either
 * way, at the next wake that does arrive.
 */
export function createRefresher(options: RefresherOptions): Refresher {
  let inFlight: Promise<RefreshReport> | null = null;

  return {
    running: () => inFlight !== null,
    wake: (reason: WakeReason): Promise<RefreshReport> => {
      if (inFlight !== null) return inFlight;
      const run = refreshDueFeeds({
        store: options.store,
        fetch: options.fetch,
        policy: options.policy,
        online: options.online,
        now: options.now?.(),
        wake: reason,
      }).finally(() => {
        inFlight = null;
      });
      inFlight = run;
      return run;
    },
  };
}
