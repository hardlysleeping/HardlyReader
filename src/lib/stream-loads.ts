/**
 * Who owns a stream load.
 *
 * Switching streams used to be a race: an older request could land after a
 * newer one and paint one stream's articles under another stream's title. Every
 * load now carries a controller and its place in a per-stream generation, and
 * only the newest load for a stream may paint.
 *
 * Speculative fetches (hovering a feed, unfolding a category) are bookkept here
 * too, because the thing worth limiting is how many requests this app has out
 * at once, not how many of them the reader is looking at. A guess never takes
 * a slot from another guess once `maxPrefetch` of them are on their way.
 *
 * This module never performs a request and imports nothing: it only says which
 * requests are still wanted, so the rules can be tested without a browser, a
 * server or a clock.
 */

export interface StreamLoad {
  readonly stream: string;
  /** Increases for every load started; the newest one is the only survivor. */
  readonly token: number;
  readonly controller: AbortController;
}

export class StreamLoads {
  private token = 0;
  private loads = new Map<string, StreamLoad>();
  private speculative = new Map<string, AbortController>();
  private readonly maxPrefetch: number;

  constructor(maxPrefetch = 2) {
    this.maxPrefetch = maxPrefetch;
  }

  /**
   * Start the newest load for a stream.
   *
   * An older load of the *same* stream is aborted: it was started for the same
   * question, so its answer is already superseded. Loads of other streams are
   * left alone — they are dropped when they land, but the work is not wasted,
   * because a landed page is worth caching even after the reader moved on.
   */
  begin(stream: string): StreamLoad {
    this.loads.get(stream)?.controller.abort();
    const load: StreamLoad = {
      stream,
      token: (this.token += 1),
      controller: new AbortController(),
    };
    this.loads.set(stream, load);
    return load;
  }

  /**
   * True while nothing newer has been asked for this stream.
   *
   * This is the paint guard: a response whose load has been superseded is
   * dropped, so a slow answer can never overwrite a fast one.
   */
  current(load: StreamLoad): boolean {
    return this.loads.get(load.stream) === load;
  }

  /** The load has finished, either way: its controller is no longer held. */
  settle(load: StreamLoad): void {
    if (this.current(load)) this.loads.delete(load.stream);
  }

  /** The newest load for a stream, if one is still on its way. */
  inFlight(stream: string): StreamLoad | undefined {
    return this.loads.get(stream);
  }

  get loading(): number {
    return this.loads.size;
  }

  get prefetching(): number {
    return this.speculative.size;
  }

  /**
   * A controller for a guess, or null when the guess is not worth making:
   * the cap is reached, this stream is already being guessed at, or the reader
   * is already fetching it.
   *
   * A load for the stream does not abort an in-flight guess: opening a feed the
   * pointer is resting on is the guess paying off, and the caller rides the
   * request that is already out (see `prefetches` in the reader store).
   */
  startPrefetch(stream: string): AbortController | null {
    if (this.speculative.has(stream) || this.loads.has(stream)) return null;
    if (this.speculative.size >= this.maxPrefetch) return null;
    const controller = new AbortController();
    this.speculative.set(stream, controller);
    return controller;
  }

  /** A guess settled; only the controller that started it may end it. */
  finishPrefetch(stream: string, controller: AbortController): void {
    if (this.speculative.get(stream) === controller) this.speculative.delete(stream);
  }

  /**
   * Abandon everything: every load and every guess.
   *
   * For a session change. The next account's streams share neither the ids nor
   * the answers, and a request signed with the previous token has no business
   * landing after the switch.
   */
  abandonAll(): void {
    for (const load of this.loads.values()) load.controller.abort();
    this.loads.clear();
    for (const controller of this.speculative.values()) controller.abort();
    this.speculative.clear();
  }
}
