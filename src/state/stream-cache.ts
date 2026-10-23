import type { StreamItem } from "../api/freshrss";

/** Articles for one stream, plus when they were fetched. */
export interface CachedStream {
  items: StreamItem[];
  continuation?: string;
  at: number;
}

/**
 * Bounded, time-limited cache of stream contents.
 *
 * Kept separate from the reader store so the eviction and freshness rules can be
 * tested without a browser, a component, or a server.
 */
export class StreamCache {
  private entries = new Map<string, CachedStream>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  // Plain fields rather than parameter properties: Node's strip-only TypeScript
  // mode cannot run the latter, and these tests run without a build step.
  constructor(ttlMs = 60_000, max = 20, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
  }

  /** The entry if it is still fresh enough to paint without asking the server. */
  fresh(stream: string): CachedStream | undefined {
    const entry = this.entries.get(stream);
    if (entry === undefined) return undefined;
    return this.now() - entry.at < this.ttlMs ? entry : undefined;
  }

  /** The entry regardless of age: useful to paint first, then revalidate. */
  peek(stream: string): CachedStream | undefined {
    return this.entries.get(stream);
  }

  set(stream: string, items: StreamItem[], continuation?: string): void {
    // Re-inserting moves the key to the end, so the Map order stays least-recent first.
    this.entries.delete(stream);
    this.entries.set(stream, { items, continuation, at: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(stream: string): void {
    this.entries.delete(stream);
  }

  get size(): number {
    return this.entries.size;
  }
}
