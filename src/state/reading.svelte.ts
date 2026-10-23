/**
 * How reading behaves, as opposed to how it looks.
 *
 * Advance-on-scroll is on by default because it was asked for, but a fast
 * trackpad can run through a short feed in seconds, so it is one click to turn
 * off — and turning it off keeps the ↑/↓ buttons and Space-at-end working.
 */

import { isArticleFilter, type ArticleFilter } from "../lib/article-filter";
import { clampDwellSeconds, DWELL_SECONDS_DEFAULT } from "../lib/dwell";
import { clampEffort, EFFORT_DEFAULT } from "../lib/scroll-advance";

const STORAGE_KEY = "hardlyreader.reading.v1";

class ReadingState {
  advanceOnScroll = $state(true);

  /**
   * Which posts the list shows, everywhere.
   *
   * `all` by default: a filter that hides posts on first launch would look like
   * a feed that had lost them.
   */
  articleFilter = $state<ArticleFilter>("all");

  /**
   * Mark a post read after it has been open for `AUTO_MARK_MS`.
   *
   * Off by default and stayed off for the owner: the whole reason he wanted it
   * optional is that scrolling is not reading, and a post flipped past should
   * still be there when he comes back for it.
   */
  autoMarkRead = $state(false);

  /**
   * How long a post must stay open before it counts as read, in seconds.
   *
   * A setting rather than a constant because reading speed is personal: three
   * seconds suits skimming headlines, longer suits prose. It only matters while
   * the ⏱ button is on.
   */
  autoMarkSeconds = $state(DWELL_SECONDS_DEFAULT);

  /**
   * How much wheel travel it takes to leave a post, as a multiplier.
   *
   * 1 keeps the tuned default; below makes posts easier to leave, above holds
   * you in one longer. Both directions scale together.
   */
  scrollEffort = $state(EFFORT_DEFAULT);

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as {
        advanceOnScroll?: unknown;
        articleFilter?: unknown;
        autoMarkRead?: unknown;
        autoMarkSeconds?: unknown;
        scrollEffort?: unknown;
      };
      if (typeof saved.advanceOnScroll === "boolean") this.advanceOnScroll = saved.advanceOnScroll;
      if (isArticleFilter(saved.articleFilter)) this.articleFilter = saved.articleFilter;
      if (typeof saved.autoMarkRead === "boolean") this.autoMarkRead = saved.autoMarkRead;
      if (saved.autoMarkSeconds !== undefined) this.autoMarkSeconds = clampDwellSeconds(saved.autoMarkSeconds);
      if (saved.scrollEffort !== undefined) this.scrollEffort = clampEffort(saved.scrollEffort);
    } catch {
      // Same rule as the layout: a corrupt preference is not worth a dialog.
    }
  }

  toggleAdvance(): void {
    this.advanceOnScroll = !this.advanceOnScroll;
    this.save();
  }

  toggleAutoMarkRead(): void {
    this.autoMarkRead = !this.autoMarkRead;
    this.save();
  }

  setScrollEffort(effort: number): void {
    const next = clampEffort(effort);
    if (this.scrollEffort === next) return;
    this.scrollEffort = next;
    this.save();
  }

  setAutoMarkSeconds(seconds: number): void {
    const next = clampDwellSeconds(seconds);
    if (this.autoMarkSeconds === next) return;
    this.autoMarkSeconds = next;
    this.save();
  }

  setArticleFilter(filter: ArticleFilter): void {
    if (this.articleFilter === filter) return;
    this.articleFilter = filter;
    this.save();
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          advanceOnScroll: this.advanceOnScroll,
          articleFilter: this.articleFilter,
          autoMarkRead: this.autoMarkRead,
          autoMarkSeconds: this.autoMarkSeconds,
          scrollEffort: this.scrollEffort,
        }),
      );
    } catch {
      // Best effort: the setting still applies for this session.
    }
  }
}

export const reading = new ReadingState();
