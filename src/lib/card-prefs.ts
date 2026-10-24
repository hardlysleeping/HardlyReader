/**
 * Reading and writing how the cards arrange themselves.
 *
 * The rules live here rather than in the runes module for the same reason
 * `chrome-prefs.ts` does: the interesting cases are a first run, a relaunch,
 * corrupt JSON and no storage at all, and those can be checked without a
 * compiler or a browser.
 *
 * It has its own key, not a field in `hardlyreader.reading.v1`. That blob is
 * rewritten whole by `ReadingState.save()` on every text size change, from a
 * file this module does not own, so a second writer would be dropped the first
 * time someone pressed A+. Chrome's own preferences went through exactly that
 * and moved to a key of their own for the same reason; this is a card-shaped
 * preference that only the posts column reads, so it can start there.
 */

import { browserStorage } from "./chrome-prefs";
import {
  CARD_LAYOUT_DEFAULT,
  MASONRY_COLUMNS_DEFAULT,
  isCardLayout,
  isMasonryColumns,
  type CardLayout,
  type MasonryColumns,
} from "./list-view";

export const CARD_PREFS_KEY = "hardlyreader.cards.v1";

export interface CardPrefs {
  /** `rows` is today's Cards; `masonry` is the column pick. */
  mode: CardLayout;
  /** How many columns masonry draws: 2, 3 or 4. */
  columns: MasonryColumns;
}

export const CARD_PREFS_DEFAULT: CardPrefs = {
  mode: CARD_LAYOUT_DEFAULT,
  columns: MASONRY_COLUMNS_DEFAULT,
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** One read of the one key, so the two fields cannot disagree about it. */
export function readCardPrefs(storage: StorageLike | undefined = browserStorage()): CardPrefs {
  if (!storage) return { ...CARD_PREFS_DEFAULT };
  try {
    const raw = storage.getItem(CARD_PREFS_KEY);
    if (raw === null) return { ...CARD_PREFS_DEFAULT };
    const saved = JSON.parse(raw) as { mode?: unknown; columns?: unknown };
    return {
      // Unknown or missing means rows: a fresh install and an old blob both
      // get the Cards view that shipped, never a layout nobody asked for.
      mode: isCardLayout(saved.mode) ? saved.mode : CARD_PREFS_DEFAULT.mode,
      columns: isMasonryColumns(saved.columns) ? saved.columns : CARD_PREFS_DEFAULT.columns,
    };
  } catch {
    // Corrupt JSON, or storage throwing: both quiet defaults are safe.
    return { ...CARD_PREFS_DEFAULT };
  }
}

/** Writes one field without dropping the other: they share one key. */
export function writeCardPrefs(
  storage: StorageLike | undefined,
  patch: Partial<CardPrefs>,
): void {
  if (!storage) return;
  try {
    const current = readCardPrefs(storage);
    const next: CardPrefs = {
      mode: isCardLayout(patch.mode) ? patch.mode : current.mode,
      columns: isMasonryColumns(patch.columns) ? patch.columns : current.columns,
    };
    storage.setItem(CARD_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the choice still applies for this session.
  }
}
