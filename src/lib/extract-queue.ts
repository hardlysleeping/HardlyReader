/**
 * The posts ahead, fetched before they are asked for.
 *
 * Opening a post fetches its page, and until that page lands the pane shows what
 * the feed sent — for a summary-only feed, two sentences and a "read more".
 * Walking a stream with ↓ then costs one page per press, in front of the reader,
 * every time. So the handful of posts just after the one being read are fetched
 * quietly while the reader is still on this one, and by the time ↓ arrives the
 * article is already in the memo `extractFor()` reads first.
 *
 * Three rules decide what is prepared, and the reader owns all three:
 *
 * 1. **Reading order.** The queue follows the list's own order, starting just
 *    past the post in hand — the same array ↑/↓ walks, so a prepared post is
 *    always one the reader can step to. Nothing behind the cursor is fetched:
 *    it was on screen, so it is either already remembered or was not wanted.
 * 2. **Visible first.** With nothing open, the queue starts at the post the
 *    reader is looking at rather than at the top of the stream — otherwise
 *    scrolling a page down would leave three prepared posts a screenful behind.
 *    The caller decides where it starts, because only the list knows its
 *    viewport.
 * 3. **On at all.** A post is prepared only when the pane would fetch it —
 *    `wantsPage()`: the account switch, or a per-post "article" choice, and
 *    never a per-post "feed" choice. Extraction that is off fetches nothing,
 *    which is the whole reason it is off.
 *
 * And two things it must never do: hold up a stream load, and pay a publisher
 * twice. The first is why nothing here is awaited from a paint — a plan is set
 * and forgotten. The second is why the plan skips what the ledger has parked,
 * why it never includes the post being read (the pane is already fetching that
 * one), and why a prepared page is fetched *through* `extractFor()`: one memo,
 * one ledger, one place that decides whether a page is worth asking for again.
 *
 * The plan is pure and the queue takes its fetching as an argument, so both can
 * be tested without a browser or a clock. The one singleton at the bottom is the
 * wiring the app uses.
 */

import { canExtract, extractFor, rememberedExtraction, type Extracted } from "./extract";
import { ledger, type BodyChoice } from "./extract-ledger";

/**
 * How far ahead of the reader the queue looks.
 *
 * `MEMO_MAX` in `extract.ts` holds four extractions, and one of those four is
 * the post in hand, so three is what fits: a fourth prepared post would push the
 * one being read out of the memo and cost a refetch on the way back to it. The
 * reader's own pace decides the rest — a page takes a second or two and a post
 * takes longer than that to read, so three is ahead, not behind.
 */
export const AHEAD = 3;

/** Speculative article fetches never exceed this many at once. */
const MAX_INFLIGHT = 2;

/**
 * How many prepared ids the queue remembers.
 *
 * Only ids, never text: this is the answer to "have I already fetched this one",
 * and it has to outlive the four-slot memo, or a cursor that moves back and forth
 * would refetch a page the app already had — a cost the ledger cannot absorb,
 * because a page that worked is not parked.
 */
const MAX_PREPARED = 500;

/** One post the queue could prepare. `url` is "" when the post has no page. */
export interface PrepCandidate {
  readonly id: string;
  readonly url: string;
}

/** What the queue is asked for: a few posts after a place in the list. */
export interface PrepWish {
  /** The posts in reading order — `reader.listItems`, not `items`. */
  readonly items: readonly PrepCandidate[];
  /**
   * The first post to prepare, as an index into `items`.
   *
   * The caller knows where the reader is and which posts are on screen, so it
   * says where to begin: the post *after* the one in hand (the pane is already
   * fetching that one), or the first post on screen when nothing is open.
   */
  readonly start: number;
  /** How many to prepare. Defaults to `AHEAD`. */
  readonly ahead?: number;
  /** Whether the pane would fetch this post's page at all. */
  readonly wanted: (candidate: PrepCandidate) => boolean;
  /** Whether the page is already on hand. */
  readonly ready: (candidate: PrepCandidate) => boolean;
  /** Whether the ledger has parked this page. */
  readonly parked: (candidate: PrepCandidate) => boolean;
}

/**
 * Whether a post's page is worth fetching, given what the reader asked for.
 *
 * The pane's own rule, written once so the queue cannot disagree with it: the
 * account switch means every post, a per-post "article" means this one, and a
 * per-post "feed" means never — not even when the switch is on, because the
 * reader has already said this particular extraction is worse than the feed.
 *
 * When the setting grows a per-feed answer, it grows here first.
 */
export function wantsPage(choice: BodyChoice | null, extractOn: boolean): boolean {
  return (extractOn || choice === "article") && choice !== "feed";
}

/**
 * Which posts to prepare, in the order to prepare them.
 *
 * Pure: the answer depends only on the wish. Everything that costs something —
 * the network, the clock, the memo — arrives as a predicate, so this can be
 * asked a thousand times in a test without a page being fetched.
 */
export function planQueue(wish: PrepWish): PrepCandidate[] {
  const ahead = Math.max(0, wish.ahead ?? AHEAD);
  const plan: PrepCandidate[] = [];
  if (ahead === 0) return plan;
  const start = Math.max(0, wish.start);
  for (let index = start; index < wish.items.length && plan.length < ahead; index += 1) {
    const candidate = wish.items[index];
    // A post with no `http(s)` link has nothing to fetch, and one the reader
    // asked to keep on the feed has nothing worth fetching: neither takes a
    // slot another post could use.
    if (candidate === undefined || candidate.url === "") continue;
    if (!wish.wanted(candidate)) continue;
    if (wish.ready(candidate) || wish.parked(candidate)) continue;
    plan.push(candidate);
  }
  return plan;
}

/** What the queue needs from the extraction pipeline. */
export interface QueueRunner {
  /** Fetch one page and remember it, or null when there is no article in it. */
  extract(id: string, url: string): Promise<Extracted | null>;
  /** Whether a page is already on hand, which is what makes opening instant. */
  ready(id: string): boolean;
  /** Whether the ledger has parked this page — a request it would refuse too. */
  parked(url: string): boolean;
}

/**
 * A plan, worked through a couple at a time.
 *
 * Nothing here reports anything. A prepared page that fails is the same page the
 * reader would have failed to get, and the pane already knows how to show less
 * of the article instead of an error, so a speculative failure has no one to
 * tell. The only observable effect of the queue is that opening a post is
 * quicker than it would have been.
 */
export class ExtractionQueue {
  private queue: PrepCandidate[] = [];
  private readonly inflight = new Map<string, Promise<Extracted | null>>();
  private readonly prepared = new Set<string>();
  private readonly runner: QueueRunner;
  private readonly maxInflight: number;

  constructor(runner: QueueRunner, maxInflight = MAX_INFLIGHT) {
    this.runner = runner;
    this.maxInflight = maxInflight;
  }

  /**
   * Replace the plan.
   *
   * Replaced rather than appended, because a new plan is a new answer to "what
   * comes next" — after a step, a filter change or a stream load the old one is
   * about posts the reader is no longer walking towards. What is already out is
   * left alone: `fetchPage()` owns its own timeout and cannot be recalled, and
   * the answer is worth keeping either way, since the memo is what makes the
   * post instant when the reader does arrive at it.
   */
  setPlan(next: readonly PrepCandidate[]): void {
    this.queue = next.filter(
      (candidate) =>
        candidate.url !== "" && !this.prepared.has(candidate.id) && !this.inflight.has(candidate.id),
    );
    this.pump();
  }

  /**
   * Plan and start, answering "ready" and "parked" from what the queue knows.
   *
   * The one call the app makes: the list hands over its posts and where the
   * reader is, and says what the pane would fetch. Nothing is returned and
   * nothing is awaited — a caller that had to wait would be a caller that blocks
   * a feed.
   */
  prepare(
    items: readonly PrepCandidate[],
    start: number,
    wanted: (candidate: PrepCandidate) => boolean,
  ): void {
    this.setPlan(
      planQueue({
        items,
        start,
        wanted,
        ready: (candidate) => this.runner.ready(candidate.id) || this.prepared.has(candidate.id),
        parked: (candidate) => this.runner.parked(candidate.url),
      }),
    );
  }

  /** A page for this post that is already on its way, if there is one. */
  pending(id: string): Promise<Extracted | null> | null {
    return this.inflight.get(id) ?? null;
  }

  get busy(): number {
    return this.inflight.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.inflight.size < this.maxInflight) {
      const next = this.queue.shift();
      if (next === undefined) return;
      if (this.prepared.has(next.id) || this.inflight.has(next.id)) continue;
      const settling = this.runner
        .extract(next.id, next.url)
        // `extractFor()` answers a failure with null; anything thrown past it is
        // still not worth showing, and must not take the queue down with it.
        .catch(() => null)
        .then((result) => {
          this.inflight.delete(next.id);
          if (result !== null) this.remember(next.id);
          this.pump();
          return result;
        });
      this.inflight.set(next.id, settling);
    }
  }

  private remember(id: string): void {
    this.prepared.add(id);
    while (this.prepared.size > MAX_PREPARED) {
      const oldest = this.prepared.values().next().value;
      if (oldest === undefined) break;
      this.prepared.delete(oldest);
    }
  }
}

/**
 * The app's queue.
 *
 * `ready` is the memo today. When extractions live on disk as well, that is the
 * one predicate to widen — a page that is on disk is already instant, so planning
 * it would be a request for nothing.
 *
 * A prepared id stays remembered across an account switch, where entry ids can
 * mean a different post. The cost of that is one missed preparation, never a
 * wrong article: the pane still fetches what the reader opens.
 */
export const articleQueue = new ExtractionQueue({
  extract: (id, url) => extractFor(id, url),
  ready: (id) => rememberedExtraction(id) !== null,
  parked: (url) => ledger.parked(url),
});

/** A post as the queue sees it: its id, and its page when the link is one. */
export function candidateFor(id: string, link: string): PrepCandidate {
  return { id, url: canExtract(link) ? link : "" };
}
