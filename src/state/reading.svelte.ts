/**
 * How reading behaves, as opposed to how it looks.
 *
 * Advance-on-scroll is on by default because it was asked for, but a fast
 * trackpad can run through a short feed in seconds, so it is one click to turn
 * off — and turning it off keeps the ↑/↓ buttons and Space-at-end working.
 */

import { isArticleFilter, type ArticleFilter } from "../lib/article-filter";
import { clampDwellSeconds, DWELL_SECONDS_DEFAULT } from "../lib/dwell";
import {
  ALIGN_INITIAL,
  ARTICLE_IMAGE_INITIAL,
  INDENT_INITIAL,
  LEADING_INITIAL,
  ROW_SCALE,
  TEXT_SCALE,
  THUMB_SCALE,
  THUMB_SIDE_INITIAL,
  clampScale,
  isLeading,
  isTextAlign,
  isThumbSide,
  stepScale,
  type Leading,
  type TextAlign,
  type ThumbSide,
} from "../lib/reading-layout";
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

  /**
   * Text size in the article, as a multiple of the tuned size.
   *
   * Global and device-local: one setting for every feed, category and post.
   * Per-post sizing would need a decision per post and would make the A−/A+
   * buttons mean something different depending on what is open.
   */
  textScale = $state(TEXT_SCALE.initial);

  /** List rows: title, preview and thumbnail scale together. */
  rowScale = $state(ROW_SCALE.initial);

  /** Line spacing in articles. */
  leading = $state<Leading>(LEADING_INITIAL);

  /** First-line indent for article paragraphs. */
  indentParagraphs = $state(INDENT_INITIAL);

  /** Which way article text hangs. */
  textAlign = $state<TextAlign>(ALIGN_INITIAL);

  /**
   * The picture's own size, multiplied on top of the row scale.
   *
   * Independent of the row because "bigger picture" and "bigger text" are
   * different asks; it rides the row scale so rows still stay in proportion.
   */
  thumbScale = $state(THUMB_SCALE.initial);

  /** Left, right, or off. Off is not the same as "no picture": feeds decide that. */
  thumbSide = $state<ThumbSide>(THUMB_SIDE_INITIAL);

  /** A lead picture above the article text in the reading pane. */
  articleImage = $state(ARTICLE_IMAGE_INITIAL);

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
        textScale?: unknown;
        rowScale?: unknown;
        leading?: unknown;
        indentParagraphs?: unknown;
        textAlign?: unknown;
        thumbScale?: unknown;
        thumbSide?: unknown;
        articleImage?: unknown;
      };
      if (typeof saved.advanceOnScroll === "boolean") this.advanceOnScroll = saved.advanceOnScroll;
      if (isArticleFilter(saved.articleFilter)) this.articleFilter = saved.articleFilter;
      if (typeof saved.autoMarkRead === "boolean") this.autoMarkRead = saved.autoMarkRead;
      if (saved.autoMarkSeconds !== undefined) this.autoMarkSeconds = clampDwellSeconds(saved.autoMarkSeconds);
      if (saved.scrollEffort !== undefined) this.scrollEffort = clampEffort(saved.scrollEffort);
      this.textScale = clampScale(saved.textScale, TEXT_SCALE);
      this.rowScale = clampScale(saved.rowScale, ROW_SCALE);
      if (isLeading(saved.leading)) this.leading = saved.leading;
      if (typeof saved.indentParagraphs === "boolean") this.indentParagraphs = saved.indentParagraphs;
      if (isTextAlign(saved.textAlign)) this.textAlign = saved.textAlign;
      this.thumbScale = clampScale(saved.thumbScale, THUMB_SCALE);
      if (isThumbSide(saved.thumbSide)) this.thumbSide = saved.thumbSide;
      if (typeof saved.articleImage === "boolean") this.articleImage = saved.articleImage;
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

  /** A− / A+ for article text. Returns the value actually applied. */
  stepTextScale(direction: 1 | -1): number {
    const next = stepScale(this.textScale, direction, TEXT_SCALE);
    if (next !== this.textScale) {
      this.textScale = next;
      this.save();
    }
    return next;
  }

  /** The same for list rows, so the two can be sized independently. */
  stepRowScale(direction: 1 | -1): number {
    const next = stepScale(this.rowScale, direction, ROW_SCALE);
    if (next !== this.rowScale) {
      this.rowScale = next;
      this.save();
    }
    return next;
  }

  /** − / + for the picture alone. Returns the value actually applied. */
  stepThumbScale(direction: 1 | -1): number {
    const next = stepScale(this.thumbScale, direction, THUMB_SCALE);
    if (next !== this.thumbScale) {
      this.thumbScale = next;
      this.save();
    }
    return next;
  }

  setThumbSide(side: ThumbSide): void {
    if (!isThumbSide(side) || this.thumbSide === side) return;
    this.thumbSide = side;
    this.save();
  }

  toggleArticleImage(): void {
    this.articleImage = !this.articleImage;
    this.save();
  }

  setLeading(leading: Leading): void {
    if (!isLeading(leading) || this.leading === leading) return;
    this.leading = leading;
    this.save();
  }

  setTextAlign(align: TextAlign): void {
    if (!isTextAlign(align) || this.textAlign === align) return;
    this.textAlign = align;
    this.save();
  }

  toggleIndentParagraphs(): void {
    this.indentParagraphs = !this.indentParagraphs;
    this.save();
  }

  /** Back to 100%, normal spacing, no indent, left. Picture side is a position, not a size, so it stays. */
  resetReadingLayout(): void {
    this.textScale = TEXT_SCALE.initial;
    this.rowScale = ROW_SCALE.initial;
    this.leading = LEADING_INITIAL;
    this.indentParagraphs = INDENT_INITIAL;
    this.textAlign = ALIGN_INITIAL;
    this.thumbScale = THUMB_SCALE.initial;
    this.articleImage = ARTICLE_IMAGE_INITIAL;
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
          textScale: this.textScale,
          rowScale: this.rowScale,
          leading: this.leading,
          indentParagraphs: this.indentParagraphs,
          textAlign: this.textAlign,
          thumbScale: this.thumbScale,
          thumbSide: this.thumbSide,
          articleImage: this.articleImage,
        }),
      );
    } catch {
      // Best effort: the setting still applies for this session.
    }
  }
}

export const reading = new ReadingState();
