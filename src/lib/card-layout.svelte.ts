/**
 * How the posts column draws its cards: one per row, or Pinterest columns.
 *
 * The state is here, not in `ArticleList.svelte`, because two posts columns can
 * be on screen at once (pane two and pane three) and a choice made in one has
 * to reach the other — the same reason the view and the card size live in a
 * store. It is a small module of its own because the storage rules are the part
 * worth testing and they sit next door in `card-prefs.ts`.
 */

import { readCardPrefs, writeCardPrefs } from "./card-prefs";
import { browserStorage } from "./chrome-prefs";
import {
  CARD_LAYOUT_DEFAULT,
  MASONRY_COLUMNS_DEFAULT,
  isCardLayout,
  isMasonryColumns,
  type CardLayout,
  type MasonryColumns,
} from "./list-view";

class CardLayoutState {
  /** `rows` until the toggle is used: the Cards view that already shipped. */
  mode = $state<CardLayout>(CARD_LAYOUT_DEFAULT);

  /** Column count for masonry. Remembered separately from the mode, so
   *  turning masonry off and on again returns the columns that were chosen. */
  columns = $state<MasonryColumns>(MASONRY_COLUMNS_DEFAULT);

  load(): void {
    const saved = readCardPrefs();
    this.mode = saved.mode;
    this.columns = saved.columns;
  }

  get masonry(): boolean {
    return this.mode === "masonry";
  }

  /** The one control: masonry on, or today's cards. */
  toggleMasonry(): void {
    this.setMode(this.mode === "masonry" ? "rows" : "masonry");
  }

  setMode(mode: CardLayout): void {
    if (!isCardLayout(mode) || this.mode === mode) return;
    this.mode = mode;
    writeCardPrefs(browserStorage(), { mode });
  }

  setColumns(columns: MasonryColumns): void {
    if (!isMasonryColumns(columns) || this.columns === columns) return;
    this.columns = columns;
    writeCardPrefs(browserStorage(), { columns });
  }
}

export const cardLayout = new CardLayoutState();

// Read before the first paint: the first frame already draws the cards, and a
// layout loaded in `onMount` would draw rows and then rearrange itself.
cardLayout.load();
