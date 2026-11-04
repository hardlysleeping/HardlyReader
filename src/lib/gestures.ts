/**
 * The gestures this app listens for, and how to turn them off.
 *
 * Every one of them is a handler somewhere that already worked: the edge swipe
 * between panes (`MobilePaneStack`), the pull at the top of a list (`pull.ts`),
 * drag-to-scroll (`drag-scroll.ts`), and the long press that opens a row's menu
 * (`LongPressTracker`, `feed-drag.ts`). None of them had an off switch, which on
 * a phone means a gesture you did by accident is a thing the app does anyway.
 *
 * The record lives in `hardlyreader.chrome.v1` beside the rest of "this screen"
 * — device-local, per account, never synced: a phone's thumb is not a desktop's
 * mouse, and one login should not carry the other's habits.
 *
 * Pure, so the answers can be tested without a browser: what a saved record is
 * allowed to say, and what a broken one falls back to.
 */

/**
 * What a pull down from the top of a list means.
 *
 * Two answers, not three. "Back to the feeds" was in the plan and is not here:
 * one step out already has an owner — the bar's `‹`, the edge swipe and the
 * hardware back key all ask `mobileNav.back()` and then close the article or
 * bring the pane behind forward. A pull that repeated that decision would be a
 * fourth opinion about where back goes, and the one place it could disagree is
 * the one place a reader would not expect it to.
 */
export type PullAction = "check" | "off";
export const PULL_ACTIONS: readonly PullAction[] = ["check", "off"];
export const PULL_LABELS: Record<PullAction, string> = {
  check: "Check for new posts",
  off: "Off",
};

/** How long a press has to be held before it is a long press. */
export type LongPressMs = 300 | 400 | 500;
export const LONG_PRESS_CHOICES: readonly LongPressMs[] = [300, 400, 500];

export interface GesturePrefs {
  /** The edge swipe that steps out of a pane, and back into the one behind. */
  paneSwipe: boolean;
  /** The pull at the top of a list: check for new posts, go back, or nothing. */
  pull: PullAction;
  /** Dragging a list or an article with the mouse, like a finger. */
  dragScroll: boolean;
  /** The hold that opens a row's menu, in milliseconds. */
  longPressMs: LongPressMs;
}

/**
 * Today's behaviour, every row.
 *
 * The three that were always on stay on: a settings section that turns working
 * things off by default is a section that changed the app. Nothing is off by
 * default except what was never there.
 */
export const GESTURE_DEFAULTS: GesturePrefs = {
  paneSwipe: true,
  pull: "check",
  dragScroll: true,
  longPressMs: 500,
};

export function isPullAction(value: unknown): value is PullAction {
  return typeof value === "string" && (PULL_ACTIONS as readonly string[]).includes(value);
}

export function isLongPressMs(value: unknown): value is LongPressMs {
  return typeof value === "number" && (LONG_PRESS_CHOICES as readonly number[]).includes(value);
}

/**
 * A saved record, read defensively.
 *
 * Anything missing or wrong takes its default rather than the whole record
 * falling back: a corrupt long press should not also turn the pane swipe back
 * on for someone who turned it off.
 */
export function parseGestures(raw: unknown): GesturePrefs {
  if (typeof raw !== "object" || raw === null) return { ...GESTURE_DEFAULTS };
  const saved = raw as Record<string, unknown>;
  return {
    paneSwipe:
      typeof saved.paneSwipe === "boolean" ? saved.paneSwipe : GESTURE_DEFAULTS.paneSwipe,
    pull: isPullAction(saved.pull) ? saved.pull : GESTURE_DEFAULTS.pull,
    dragScroll:
      typeof saved.dragScroll === "boolean" ? saved.dragScroll : GESTURE_DEFAULTS.dragScroll,
    longPressMs: isLongPressMs(saved.longPressMs)
      ? saved.longPressMs
      : GESTURE_DEFAULTS.longPressMs,
  };
}

/** What the pull says while it is being dragged. */
export function pullLabels(action: PullAction): { label: string; ready: string } {
  if (action === "off") return { label: "", ready: "" };
  return { label: "Pull down to check for new posts", ready: "Release to check for new posts" };
}
