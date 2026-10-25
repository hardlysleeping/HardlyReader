/**
 * How reading behaves, as opposed to how it looks.
 *
 * Advance-on-scroll is on by default because it was asked for, but a fast
 * trackpad can run through a short feed in seconds, so it is one click to turn
 * off — and turning it off keeps the ↑/↓ buttons and Space-at-end working.
 */

import { isArticleFilter, type ArticleFilter } from "../lib/article-filter";
import {
  CARD_SIZE_DEFAULT,
  CURVE_DEFAULT,
  FLUSH_THUMB_DEFAULT,
  clampCurve,
  GRID_COLUMNS_DEFAULT,
  isCardSize,
  isGridColumns,
  isListView,
  isRowEnd,
  LIST_VIEW_DEFAULT,
  ROW_END_DEFAULT,
  type RowEnd,
  type CardSize,
  type GridColumns,
  type ListView,
} from "../lib/list-view";
import { clampDwellSeconds, DWELL_SECONDS_DEFAULT } from "../lib/dwell";
import {
  ALIGN_INITIAL,
  ARTICLE_IMAGE_INITIAL,
  LEADING_INITIAL,
  ROW_SCALE,
  TEXT_SCALE,
  STEP_INITIAL,
  THUMB_SCALE,
  IMAGE_SCALE,
  FLIP_EDGE,
  clampFlipEdge,
  THUMB_SIDE_INITIAL,
  clampScale,
  isLeading,
  isStepPercent,
  isTextAlign,
  isThumbSide,
  stepScale,
  type Leading,
  type StepPercent,
  type TextAlign,
  type ThumbSide,
} from "../lib/reading-layout";
import { clampEffort, EFFORT_DEFAULT } from "../lib/scroll-advance";
import { EXTRACT_DEFAULT } from "../lib/extract";

const STORAGE_KEY = "hardlyreader.reading.v1";

/** How read state is decided: by you, or by a clock while the post is open. */
export type MarkReadMode = "manual" | "auto";

/** Both options, and nothing else: a corrupt value falls back to manual. */
export function isMarkReadMode(value: unknown): value is MarkReadMode {
  return value === "manual" || value === "auto";
}

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
   * The shape of the posts column: regular rows, one-line list, cards or grid.
   *
   * Global and device-local like the rest of reading, because it is how you
   * read, not a property of a feed. `regular` is the default, so the column
   * looks the way it always did until it is told otherwise.
   */
  listView = $state<ListView>(LIST_VIEW_DEFAULT);

  /**
   * Whether a tapped row is read in the posts column itself.
   *
   * Off by default: the column is a list, and a tap that swaps it for a page is
   * not what a list is for unless you ask. On, the article takes the column
   * (and the article column beside it) and the toolbar's back button returns
   * the list — reading without leaving the list's place in the frame.
   */
  readInPane = $state(false);

  /**
   * How a regular row's end is shaped: `half` turns the bottom corners and runs
   * the accent along the foot, `pill` is both right-hand corners as they were.
   * Device-local like every other reading setting, and reversible so the look
   * that shipped before this existed is never lost.
   */
  rowsEnd = $state<RowEnd>(ROW_END_DEFAULT);

  /**
   * How far each shape's end turns, in pixels — the pill's right-hand corners and
   * the foot's bottom ones. Kept apart because they are two shapes, not one
   * setting with two names, and stored with the rest of the reading preferences
   * so a chosen curve is there next time.
   */
  curvePill = $state(CURVE_DEFAULT.pill);
  curveHalf = $state(CURVE_DEFAULT.half);

  /** The picture fills the row's corner in the footed shape, or sits inside it. */
  flushThumb = $state(FLUSH_THUMB_DEFAULT);

  /** Tiles per row in the grid; `auto` is the grid's own judgement. */
  gridColumns = $state<GridColumns>(GRID_COLUMNS_DEFAULT);

  /** How tall a card's picture is. `auto` is the height cards always had. */
  cardSize = $state<CardSize>(CARD_SIZE_DEFAULT);

  /**
   * Whether a post is marked read without being asked.
   *
   * Manual is the default: opening a post is not
   * reading it, and a post flipped past should still be there when he comes
   * back. The automatic option stays, because it is a real preference — just
   * not the one to start with.
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

  /** Which way article text hangs. */
  textAlign = $state<TextAlign>(ALIGN_INITIAL);

  /**
   * The picture's own size, multiplied on top of the row scale.
   *
   * Independent of the row because "bigger picture" and "bigger text" are
   * different asks; it rides the row scale so rows still stay in proportion.
   */
  thumbScale = $state(THUMB_SCALE.initial);

  /**
   * Pictures in the article, against the automatic fit. Saved with the rest of
   * the reading settings: it is how this reader likes to read, not a property of
   * one post, so it holds from article to article and across runs.
   */
  imageScale = $state(IMAGE_SCALE.initial);

  /** Left, right, or off. Off is not the same as "no picture": feeds decide that. */
  thumbSide = $state<ThumbSide>(THUMB_SIDE_INITIAL);

  /**
   * How wide a card's flip edge is, as a percentage of the card's width.
   *
   * A multi-picture card turns a page when its edge is tapped; everything in the
   * middle opens the post. How much of the card is "the edge" is a taste, and a
   * narrow pane makes a fifth of the card very little to hit, so it is a setting
   * rather than a constant.
   */
  flipEdge = $state(FLIP_EDGE.initial);

  /**
   * Reader view: fetch the original page and show only the article.
   *
   * Global and device-local like the rest of reading — one choice for every
   * feed. Off by default: it costs a request per post and some publishers
   * refuse the fetch, and a fresh install should read what the feed sent rather
   * than wait on a page that may never arrive.
   */
  extract = $state(EXTRACT_DEFAULT);

  /** A lead picture above the article text in the reading pane. */
  articleImage = $state(ARTICLE_IMAGE_INITIAL);

  /**
   * Percent per press, for every size control in the panel.
   *
   * One number for text, rows and pictures: three steps that disagree would mean
   * the same gesture moved different amounts depending on which row it was in.
   */
  stepPercent = $state<StepPercent>(STEP_INITIAL);

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as {
        advanceOnScroll?: unknown;
        articleFilter?: unknown;
        listView?: unknown;
        readInPane?: unknown;
        rowsEnd?: unknown;
        curvePill?: unknown;
        curveHalf?: unknown;
        flushThumb?: unknown;
        gridColumns?: unknown;
        cardSize?: unknown;
        markReadMode?: unknown;
        autoMarkRead?: unknown;
        autoMarkSeconds?: unknown;
        scrollEffort?: unknown;
        textScale?: unknown;
        rowScale?: unknown;
        leading?: unknown;
        textAlign?: unknown;
        thumbScale?: unknown;
        imageScale?: unknown;
        thumbSide?: unknown;
        flipEdge?: unknown;
        articleImage?: unknown;
        stepPercent?: unknown;
        extract?: unknown;
      };
      if (typeof saved.advanceOnScroll === "boolean") this.advanceOnScroll = saved.advanceOnScroll;
      if (isArticleFilter(saved.articleFilter)) this.articleFilter = saved.articleFilter;
      if (isListView(saved.listView)) this.listView = saved.listView;
      if (typeof saved.readInPane === "boolean") this.readInPane = saved.readInPane;
      if (isRowEnd(saved.rowsEnd)) this.rowsEnd = saved.rowsEnd;
      if (saved.curvePill !== undefined) this.curvePill = clampCurve(saved.curvePill);
      if (saved.curveHalf !== undefined) this.curveHalf = clampCurve(saved.curveHalf);
      if (typeof saved.flushThumb === "boolean") this.flushThumb = saved.flushThumb;
      if (isGridColumns(saved.gridColumns)) this.gridColumns = saved.gridColumns;
      if (isCardSize(saved.cardSize)) this.cardSize = saved.cardSize;
      // An explicit choice of mode is honoured; the old bare `autoMarkRead`
      // boolean is not read at all. It was a single icon next to the star, and
      // it stayed on without being meant to — automatic
      // marking is now something you have to pick twice (the setting or the
      // button), and manual is what a fresh install gets.
      if (isMarkReadMode(saved.markReadMode)) this.autoMarkRead = saved.markReadMode === "auto";
      if (saved.autoMarkSeconds !== undefined) this.autoMarkSeconds = clampDwellSeconds(saved.autoMarkSeconds);
      if (saved.scrollEffort !== undefined) this.scrollEffort = clampEffort(saved.scrollEffort);
      this.textScale = clampScale(saved.textScale, TEXT_SCALE);
      this.rowScale = clampScale(saved.rowScale, ROW_SCALE);
      if (isLeading(saved.leading)) this.leading = saved.leading;
      if (isTextAlign(saved.textAlign)) this.textAlign = saved.textAlign;
      this.thumbScale = clampScale(saved.thumbScale, THUMB_SCALE);
      this.imageScale = clampScale(saved.imageScale, IMAGE_SCALE);
      if (typeof saved.flipEdge === "number") this.flipEdge = clampFlipEdge(saved.flipEdge);
      if (isThumbSide(saved.thumbSide)) this.thumbSide = saved.thumbSide;
      if (typeof saved.articleImage === "boolean") this.articleImage = saved.articleImage;
      if (isStepPercent(saved.stepPercent)) this.stepPercent = saved.stepPercent;
      // Absent, or not a boolean, means off: a prefs blob written before this
      // setting existed must not switch extraction on by accident.
      if (typeof saved.extract === "boolean") this.extract = saved.extract;
    } catch {
      // Same rule as the layout: a corrupt preference is not worth a dialog.
    }
  }

  toggleAdvance(): void {
    this.advanceOnScroll = !this.advanceOnScroll;
    this.save();
  }

  /** Reader view is one global switch, so it stays where it was left. */
  setExtract(on: boolean): void {
    if (this.extract === on) return;
    this.extract = on;
    this.save();
  }

  toggleExtract(): void {
    this.setExtract(!this.extract);
  }

  toggleAutoMarkRead(): void {
    this.setAutoMarkRead(!this.autoMarkRead);
  }

  /** The setting behind the ⏱ button, one place for both. */
  setAutoMarkRead(on: boolean): void {
    if (this.autoMarkRead === on) return;
    this.autoMarkRead = on;
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

  setListView(view: ListView): void {
    if (!isListView(view) || this.listView === view) return;
    this.listView = view;
    this.save();
  }

  /**
   * Read in the posts column, or in the article column beside it.
   *
   * Only Rows offers this: the other three views answer "scan many
   * posts", and a page inside one of them would be a second kind of card.
   */
  toggleReadInPane(): void {
    this.readInPane = !this.readInPane;
    this.save();
  }

  /**
   * The other end of a row: half a turn, or the full pill it used to be.
   *
   * One press, two looks, and the choice is saved — "drop the option" later
   * means going back to `pill`, not hunting for the CSS that made it.
   */
  setRowsEnd(next: RowEnd): void {
    if (!isRowEnd(next) || this.rowsEnd === next) return;
    this.rowsEnd = next;
    this.save();
  }

  toggleRowsEnd(): void {
    this.setRowsEnd(this.rowsEnd === "half" ? "pill" : "half");
  }

  /** The turn of one shape, in pixels. Clamped, and saved as it is dragged. */
  setCurve(which: RowEnd, px: number): void {
    const value = clampCurve(px);
    if (which === "pill") {
      if (this.curvePill === value) return;
      this.curvePill = value;
    } else {
      if (this.curveHalf === value) return;
      this.curveHalf = value;
    }
    this.save();
  }

  /** The picture fills the corner, or sits inside it. */
  toggleFlushThumb(): void {
    this.flushThumb = !this.flushThumb;
    this.save();
  }

  /** Both back to what each shape came with. */
  resetCurves(): void {
    this.curvePill = CURVE_DEFAULT.pill;
    this.curveHalf = CURVE_DEFAULT.half;
    this.save();
  }

  /** Tiles per row, for the grid. */
  setGridColumns(columns: GridColumns): void {
    if (!isGridColumns(columns) || this.gridColumns === columns) return;
    this.gridColumns = columns;
    this.save();
  }

  /** Card picture height, for the cards. */
  setCardSize(size: CardSize): void {
    if (!isCardSize(size) || this.cardSize === size) return;
    this.cardSize = size;
    this.save();
  }

  setArticleFilter(filter: ArticleFilter): void {
    if (this.articleFilter === filter) return;
    this.articleFilter = filter;
    this.save();
  }

  /** A− / A+ for article text. Returns the value actually applied. */
  stepTextScale(direction: 1 | -1): number {
    const next = stepScale(this.textScale, direction, TEXT_SCALE, this.stepPercent);
    if (next !== this.textScale) {
      this.textScale = next;
      this.save();
    }
    return next;
  }

  /** The same for list rows, so the two can be sized independently. */
  stepRowScale(direction: 1 | -1): number {
    const next = stepScale(this.rowScale, direction, ROW_SCALE, this.stepPercent);
    if (next !== this.rowScale) {
      this.rowScale = next;
      this.save();
    }
    return next;
  }

  /** − / + for the picture alone. Returns the value actually applied. */
  stepThumbScale(direction: 1 | -1): number {
    const next = stepScale(this.thumbScale, direction, THUMB_SCALE, this.stepPercent);
    if (next !== this.thumbScale) {
      this.thumbScale = next;
      this.save();
    }
    return next;
  }

  /** ⊖ / ⊕ for the pictures in an article. Returns the value applied. */
  stepImageScale(direction: 1 | -1): number {
    const next = stepScale(this.imageScale, direction, IMAGE_SCALE, this.stepPercent);
    if (next !== this.imageScale) {
      this.imageScale = next;
      this.save();
    }
    return next;
  }

  /** How far one press moves every size control. */
  setStepPercent(percent: StepPercent): void {
    if (!isStepPercent(percent) || this.stepPercent === percent) return;
    this.stepPercent = percent;
    this.save();
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


  /** Back to 100%, normal spacing, no indent, left. Picture side is a position, not a size, so it stays. */
  /** The card runner's edge as a percentage of the card, clamped and saved. */
  setFlipEdge(percent: number): void {
    const next = clampFlipEdge(percent);
    if (next === this.flipEdge) return;
    this.flipEdge = next;
    this.save();
  }

  resetReadingLayout(): void {
    this.textScale = TEXT_SCALE.initial;
    this.rowScale = ROW_SCALE.initial;
    this.leading = LEADING_INITIAL;
    this.textAlign = ALIGN_INITIAL;
    this.thumbScale = THUMB_SCALE.initial;
    this.imageScale = IMAGE_SCALE.initial;
    this.flipEdge = FLIP_EDGE.initial;
    this.articleImage = ARTICLE_IMAGE_INITIAL;
    this.stepPercent = STEP_INITIAL;
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
          listView: this.listView,
          readInPane: this.readInPane,
          rowsEnd: this.rowsEnd,
          curvePill: this.curvePill,
          curveHalf: this.curveHalf,
          flushThumb: this.flushThumb,
          gridColumns: this.gridColumns,
          cardSize: this.cardSize,
          markReadMode: this.autoMarkRead ? "auto" : "manual",
          autoMarkSeconds: this.autoMarkSeconds,
          scrollEffort: this.scrollEffort,
          textScale: this.textScale,
          rowScale: this.rowScale,
          leading: this.leading,
          textAlign: this.textAlign,
          thumbScale: this.thumbScale,
          imageScale: this.imageScale,
          thumbSide: this.thumbSide,
          flipEdge: this.flipEdge,
          articleImage: this.articleImage,
          stepPercent: this.stepPercent,
          extract: this.extract,
        }),
      );
    } catch {
      // Best effort: the setting still applies for this session.
    }
  }
}

export const reading = new ReadingState();
