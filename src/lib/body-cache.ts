/**
 * The device's copies, as the pipeline sees them.
 *
 * `lib/extract.ts` walks three callers through one pipeline (the article pane,
 * the list's inline reader, the queue that prepares the posts ahead) and asks
 * this for the two questions a device can answer: "do you already have this
 * article" and "keep this one". `state/bodies.svelte.ts` supplies the reader's
 * choices and the numbers a panel draws; everything that decides anything —
 * what counts as too big, when the library is over its ceiling, what may not be
 * evicted — is here, in one place, with no signals in it.
 *
 * The order `read()` keeps is the point: **the store first, the memo above it in
 * the pipeline, nothing else below**. A body already on disk is not a page to
 * ask a publisher for, ever again, until the reader presses ¶ to say "as it is
 * now".
 */
import type { BodyPruned, LocalStore } from "../api/local/store";
import { BODY_MAX_POST, bodiesOverLimit, type BodyKeepMode, type BodyUsage } from "./bodies";
import { textLength, type Extracted, type ExtractionCache } from "./extract";

/** What the cache is told, and what it says back. */
export interface BodyCacheDeps {
  /** The library open on this device, or null when there is none. */
  library(): LocalStore | null;
  /** Whether the reader asked this device to keep anything. */
  keeping(): boolean;
  /** Bytes allowed on this device. */
  limit(): number;
  /**
   * Bodies a pane is drawing right now. They survive an eviction pass even when
   * that leaves the library over its ceiling: a blank article is worse than a
   * ceiling nobody honours.
   */
  onScreen(): Iterable<string>;
  /** What is held now, after a write, an eviction or a measurement. */
  measured(usage: BodyUsage): void;
  /** A pass deleted something. */
  cleared?(pruned: BodyPruned): void;
}

export interface BodyCache extends ExtractionCache {
  /** Measure the library flat, and make room if it is over the ceiling. */
  settle(writing?: string): Promise<BodyUsage>;
  /** The numbers this cache last reported. */
  usage(): BodyUsage;
}

/** Bytes, counted the way the budget counts them. */
function sizeOf(html: string): number {
  return new TextEncoder().encode(html).length;
}

export function createBodyCache(deps: BodyCacheDeps): BodyCache {
  let count = 0;
  let bytes = 0;

  const usage = (): BodyUsage => ({ count, bytes });

  function report(): void {
    deps.measured(usage());
  }

  const cache: BodyCache = {
    usage,

    read: async (itemId) => {
      const library = deps.library();
      if (library === null) return null;
      try {
        const row = await library.extraction(itemId);
        if (row === null || row.status !== "ok" || row.html === null) return null;
        // Reading is what least-recently-used means: the copy just opened is now
        // the newest in the library. Not awaited — the article is in hand, and
        // the stamp can land after it.
        void library.touchExtraction(itemId).catch(() => {});
        const extracted: Extracted = {
          html: row.html,
          title: row.title ?? "",
          byline: row.byline ?? "",
          textLength: row.text_length ?? textLength(row.html),
        };
        return extracted;
      } catch {
        // A store that cannot answer is a miss, not a failed read: the pipeline
        // then fetches the page exactly as it would with no cache at all.
        return null;
      }
    },

    write: async (itemId, extracted) => {
      const library = deps.library();
      if (library === null || !deps.keeping()) return;
      const size = sizeOf(extracted.html);
      // A page bigger than the per-post ceiling is a download, not an article:
      // keeping it would spend a tenth of the budget on one press.
      if (size === 0 || size > BODY_MAX_POST) return;
      const saved = await library.saveExtraction({
        itemId,
        html: extracted.html,
        title: extracted.title,
        byline: extracted.byline,
        textLength: extracted.textLength,
      });
      bytes += saved.delta;
      if (saved.added) count += 1;
      report();
      if (bodiesOverLimit(usage(), deps.limit())) await cache.settle(itemId);
    },

    settle: async (writing) => {
      const library = deps.library();
      if (library === null) return usage();
      try {
        const measured = await library.bodyUsage();
        count = measured.count;
        bytes = measured.bytes;
        if (!bodiesOverLimit(measured, deps.limit())) {
          report();
          return usage();
        }
        const keep = new Set(deps.onScreen());
        if (writing !== undefined) keep.add(writing);
        const pruned = await library.pruneBodies(deps.limit(), { keep });
        count = pruned.count;
        bytes = pruned.bytes;
        deps.cleared?.(pruned);
      } catch {
        // A store that cannot answer leaves the last numbers alone. A settings
        // row is not the place to report a database error nobody can act on.
      }
      report();
      return usage();
    },
  };

  return cache;
}
