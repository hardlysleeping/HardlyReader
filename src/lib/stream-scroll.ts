/**
 * Where each stream was left.
 *
 * Coming back to a feed should put the reader where they stopped reading it,
 * not at the top of the list. The place stored for the whole app holds one
 * stream — the one that was open last — which is enough across launches but not
 * within a session, where switching between three feeds would otherwise lose
 * the other two positions on every switch.
 *
 * Bounded and least-recently-used, like the stream cache: this is a way back to
 * the last few streams, not a log of everywhere the reader has ever been.
 */
export class StreamScroll {
  private entries = new Map<string, number>();
  private readonly max: number;

  constructor(max = 40) {
    this.max = max;
  }

  /** Remember where a stream is scrolled to. Re-remembering makes it recent. */
  remember(stream: string, top: number): void {
    if (stream === "") return;
    this.entries.delete(stream);
    this.entries.set(stream, Math.max(0, Math.round(top)));
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * The offset a stream was left at, or undefined for a stream never left.
   *
   * Zero and undefined are different answers: zero is a stream that was read
   * from the top, undefined is one this session has no opinion about.
   */
  recall(stream: string): number | undefined {
    const top = this.entries.get(stream);
    if (top === undefined) return undefined;
    // Reading a stream makes it recent, so a feed the reader keeps returning to
    // is not evicted by feeds they merely passed through.
    this.entries.delete(stream);
    this.entries.set(stream, top);
    return top;
  }

  forget(stream: string): void {
    this.entries.delete(stream);
  }

  /** Drop every position: another account's streams are not these streams. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
