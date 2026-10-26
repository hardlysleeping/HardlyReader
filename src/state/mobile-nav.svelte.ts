/**
 * The phone's sliding stack: which pane is underneath, and which one is slid
 * over it.
 *
 * A portrait phone has one width to spend, so the three panes cannot be columns.
 * The walk it ships with (`one-pane.ts`) spends that width one pane at a time
 * and keeps the post list as a drawer pulled down over the article. The stack
 * spends it differently: any two neighbouring panes lie side by side in the
 * *same* width, one screen apart, and moving between them is a slide rather than
 * a swap — which is what makes a feed's posts arrive from the right instead of
 * appearing out of nothing, and what makes the pane you came from visible for
 * the length of the gesture.
 *
 * Two numbers are enough to say where you are, and they are the whole of the
 * state:
 *
 * - `basePane` is the pane the stack rests on: the posts (2) or the article (3).
 *   Never the feeds, because the stack is built around a stream: there is no
 *   "feeds pane" to rest on, there is a list you open over whatever you were
 *   reading.
 * - `overlayPane` is a shallower pane slid over the base — the feeds (1) over
 *   the posts, or the posts (2) over the article — or `null` when the base is
 *   alone.
 *
 * That is deliberately not the same thing as the reader's own state. The reader
 * owns *what* is being read (`reader.activeStream`, `reader.selectedId`); this
 * owns *which pane is in front*, and it is the only thing a gesture, a rotation
 * or a back press may change. Keeping them apart is what makes the promise that
 * a rotation cannot rewrite the chosen layout true by construction: nothing in
 * this module reads an orientation, and nothing outside it writes these fields
 * except through the methods below.
 *
 * No runtime imports, on purpose: the one import here is a type, and it is
 * erased. The module is compiled and imported by `tests/unit/mobile-nav.mjs`
 * without a DOM, and it must stay that cheap.
 */

import type { MobilePortraitMode } from "../lib/panes";

export type { MobilePortraitMode };

/** The three panes, by the number the layout gives them. */
export type MobilePane = 1 | 2 | 3;

/** The pane the stack rests on: the posts or the article, never the feeds. */
export type BasePane = 2 | 3;

/** A pane that can be slid over the base: the one or two levels shallower. */
export type OverlayPane = 1 | 2;

/**
 * Where a back press lands.
 *
 * `overlay` and `article` are layers the stack consumes itself; `app` is the
 * point at which nothing of the reader's is left in front and the shell's own
 * behaviour (leave the app, go back in history) is the honest answer.
 */
export type BackStep = "overlay" | "article" | "app";

/**
 * How far the pane behind the current one peeks past the left edge, in percent
 * of a pane's own width.
 *
 * A sliver, not a half: it is the affordance for the edge swipe — something is
 * there, and it is to the left — and anything wider would be a second column
 * claiming width the current pane is using.
 */
export const PEEK = 24;

/** The width, in CSS pixels, a swipe must start within to belong to the stack. */
export const EDGE = 28;

/** The pane one level shallower than the base, or `null` at the root. */
export function previousPane(base: BasePane): OverlayPane | null {
  return base === 3 ? 2 : 1;
}

/**
 * Whether the phone should be drawing the stack.
 *
 * The single place the question is answered, so the view, the settings panel and
 * the tests cannot disagree about it. All three conditions are needed and each
 * one is load-bearing:
 *
 * - the device is a phone: a desktop window is three columns, and its shape is
 *   the window manager's business;
 * - the frame is upright: turned sideways a phone keeps the desktop three-pane
 *   layout, which is the shape it already had and the one it has room for;
 * - the preference says so: `single` is the walk this app shipped with, and it
 *   stays byte for byte what it was.
 *
 * `portrait` is passed in rather than read from a screen here: this module is
 * imported by tests without a window, and a rotation is a measurement, not a
 * thing this module is allowed to observe.
 */
export function slidesInPortrait(input: {
  device: "phone" | "desktop";
  portrait: boolean;
  mode: MobilePortraitMode;
}): boolean {
  return input.device === "phone" && input.portrait && input.mode === "stack";
}

/**
 * How far a pane sits from the left edge of the stack, in percent of its width.
 *
 * Panes shallower than the one in front sit to the left, one `PEEK` further out
 * for every level between them; panes deeper than it wait a full screen to the
 * right, so arriving is a slide in from the right and leaving is a slide back
 * out to it. Percentages are of the pane's own width, which is the frame's —
 * that is what makes the offsets width-independent and the phone's screen the
 * only number involved.
 */
export function offsetFor(showing: MobilePane, pane: MobilePane): number {
  if (pane === showing) return 0;
  if (pane > showing) return 100 * (pane - showing);
  return -PEEK * (showing - pane);
}

export class MobileNavState {
  /** The pane the stack rests on. Posts until an article is opened. */
  basePane = $state<BasePane>(2);

  /** A shallower pane slid over the base, or `null` for the base alone. */
  overlayPane = $state<OverlayPane | null>(null);

  /** The pane actually in front: the overlay if one is open, else the base. */
  get showing(): MobilePane {
    return this.overlayPane ?? this.basePane;
  }

  /**
   * How many back presses the stack itself has an answer for.
   *
   * The article is a layer (leaving it is the reader's own `closeReader`), and
   * an open overlay is another. The feeds' overlay over the posts is one layer,
   * the posts over an article is one, and both at once is two — which is the
   * number of history entries the view arms while the stack is on screen.
   */
  get depth(): number {
    return (this.overlayPane === null ? 0 : 1) + (this.basePane === 3 ? 1 : 0);
  }

  /** Whether the previous pane is available to slide in. */
  get canOpenPrevious(): boolean {
    return this.overlayPane === null && previousPane(this.basePane) !== null;
  }

  /**
   * Slide the previous pane in over the base: feeds over the list, or the list
   * over the article.
   *
   * False when one is already open — a gesture that names the same layer twice
   * must not stack it on itself — and false at the root the stack cannot go
   * further out from. The caller animates; this only decides.
   */
  openPrevious(): boolean {
    if (this.overlayPane !== null) return false;
    const previous = previousPane(this.basePane);
    if (previous === null) return false;
    this.overlayPane = previous;
    return true;
  }

  /** Put the overlay back where it came from. False when there was none. */
  closeOverlay(): boolean {
    if (this.overlayPane === null) return false;
    this.overlayPane = null;
    return true;
  }

  /**
   * Rest the stack on a pane: the list (2) or the article (3).
   *
   * Landing is a decision, so anything left open goes with the old base — a
   * peek at the posts that stays open over the article you just chose would be
   * hiding the thing you asked for.
   */
  show(pane: BasePane): void {
    if (pane !== 2 && pane !== 3) return;
    this.basePane = pane;
    this.overlayPane = null;
  }

  /**
   * Follow the reader's level: an article open, or not.
   *
   * Called on every *change* of that answer, which is the important part. A feed
   * switch is not a change: `selectedId` is already `null` and stays `null`, so
   * this method is not called and an open feeds overlay is left exactly where it
   * is — which is what makes picking a feed while the list is in front keep the
   * list in front, so you can pick another.
   *
   * When the level does move, the base moves with it and any overlay goes: the
   * article you chose is what you are reading, not something to peek past.
   */
  syncReading(articleOpen: boolean): void {
    const target: BasePane = articleOpen ? 3 : 2;
    if (target === this.basePane) return;
    this.basePane = target;
    this.overlayPane = null;
  }

  /**
   * A post was picked while a shallower pane was in front.
   *
   * The level may not have moved — reading post B with the list peeking over
   * post A is still "an article is open" — so `syncReading` would have nothing
   * to answer, and the list would stay in front of the thing the tap asked for.
   * This is the tap's own answer: the article comes to the front.
   */
  landOnArticle(): void {
    this.basePane = 3;
    this.overlayPane = null;
  }

  /**
   * One layer outward.
   *
   * The order is the stack's whole contract with the back button: an open
   * overlay is the nearest thing in front, so it goes first and the base stays
   * where it was — dismissing a peek returns you to what you were reading. Then
   * the article, which is reported rather than closed here: the article is the
   * reader's, and a nav module that closed it would be a second copy of a
   * decision that already has an owner. At the root there is nothing of the
   * reader's left, so the answer is `app`.
   *
   * `article` does not move `basePane` either. The caller closes the reader and
   * `syncReading(false)` moves the base — one owner per fact.
   */
  back(): BackStep {
    if (this.overlayPane !== null) {
      this.overlayPane = null;
      return "overlay";
    }
    if (this.basePane === 3) return "article";
    return "app";
  }

  /** Back to where a fresh stack starts: the list, nothing over it. */
  reset(): void {
    this.basePane = 2;
    this.overlayPane = null;
  }
}

export const mobileNav = new MobileNavState();
