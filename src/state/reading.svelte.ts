/**
 * How reading behaves, as opposed to how it looks.
 *
 * Advance-on-scroll is on by default because it was asked for, but a fast
 * trackpad can run through a short feed in seconds, so it is one click to turn
 * off — and turning it off keeps the ↑/↓ buttons and Space-at-end working.
 */

import { isArticleFilter, type ArticleFilter } from "../lib/article-filter";

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

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as { advanceOnScroll?: unknown; articleFilter?: unknown };
      if (typeof saved.advanceOnScroll === "boolean") this.advanceOnScroll = saved.advanceOnScroll;
      if (isArticleFilter(saved.articleFilter)) this.articleFilter = saved.articleFilter;
    } catch {
      // Same rule as the layout: a corrupt preference is not worth a dialog.
    }
  }

  toggleAdvance(): void {
    this.advanceOnScroll = !this.advanceOnScroll;
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
        JSON.stringify({ advanceOnScroll: this.advanceOnScroll, articleFilter: this.articleFilter }),
      );
    } catch {
      // Best effort: the setting still applies for this session.
    }
  }
}

export const reading = new ReadingState();
