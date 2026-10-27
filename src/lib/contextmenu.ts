/**
 * Context-menu primitives for the feed sidebar.
 *
 * Three separate concerns, all pure so they can be exercised without a DOM:
 *
 * 1. `LongPressTracker` turns a touch pointerdown into a single action after
 *    500 ms, unless the finger wanders or lifts first. A mouse never arms: it
 *    has a right button, and the `contextmenu` event is the better trigger.
 * 2. `isMenuKey` / `anchorForRect` are the keyboard route (`Shift+F10` and the
 *    dedicated context-menu key) that every right-click user expects but that
 *    is easy to forget exists.
 * 3. `categoryMenu` decides the items and their wording, in the extension's own
 *    words (`Hide` / `Show`, view `hidden` / `revealed` / `only`).
 *
 * `placeMenu` lives here too, so the component measures and calls rather than
 * doing geometry inside event handlers.
 */
import { categoryIdForLabel, isHiddenCategory, type HiddenCategoriesState } from "../api/hardlyread";
import type { HiddenAuthority } from "../state/hidden";
import { pinWords } from "./theme";

/* ---------------------------------------------------------------------------
 * Long press
 * ------------------------------------------------------------------------- */

export const LONG_PRESS_MS = 500;

/**
 * How far a finger may drift before the gesture counts as a drag or a scroll.
 * The card asks for a cancel on `pointermove`; cancelling on the first pixel of
 * jitter would make the gesture unusable on a real touchscreen, so movement is
 * measured against a tolerance instead.
 */
export const LONG_PRESS_TOLERANCE_PX = 10;

export interface PointerSample {
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Timer seam, so the delay can be tested without waiting for it. */
export interface Timer {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

export const realTimers: Timer = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clear: (handle) => globalThis.clearTimeout(handle),
};

/** Only touch and pen get a long press. */
export function armsLongPress(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

export class LongPressTracker {
  private timer: number | null = null;
  private origin: Point | null = null;

  private readonly fire: (point: Point) => void;
  private readonly timers: Timer;
  private readonly delay: number;
  private readonly tolerance: number;

  constructor(
    fire: (point: Point) => void,
    timers: Timer = realTimers,
    delay = LONG_PRESS_MS,
    tolerance = LONG_PRESS_TOLERANCE_PX,
  ) {
    this.fire = fire;
    this.timers = timers;
    this.delay = delay;
    this.tolerance = tolerance;
  }

  /** Arms on pointerdown. Returns false when the pointer cannot long-press. */
  start(event: PointerSample): boolean {
    this.cancel();
    if (!armsLongPress(event.pointerType)) return false;

    this.origin = { x: event.clientX, y: event.clientY };
    this.timer = this.timers.set(() => {
      const point = this.origin;
      this.timer = null;
      this.origin = null;
      if (point !== null) this.fire(point);
    }, this.delay);
    return true;
  }

  /** Cancels once the pointer has moved far enough to be a drag, not a press. */
  move(event: PointerSample): void {
    if (this.origin === null) return;
    const dx = event.clientX - this.origin.x;
    const dy = event.clientY - this.origin.y;
    if (Math.hypot(dx, dy) > this.tolerance) this.cancel();
  }

  /** Lifting, leaving or a browser-cancelled pointer always cancels. */
  cancel(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    this.origin = null;
  }

  get armed(): boolean {
    return this.timer !== null;
  }
}

/* ---------------------------------------------------------------------------
 * Keyboard trigger and anchor
 * ------------------------------------------------------------------------- */

export interface MenuKeyEvent {
  key: string;
  shiftKey: boolean;
}

/**
 * The two ways a keyboard asks for a context menu. `Apps` is the legacy name
 * Windows reports for the dedicated key, so it is accepted alongside the
 * standard `ContextMenu` value.
 */
export function isMenuKey(event: MenuKeyEvent): boolean {
  if (event.key === "ContextMenu" || event.key === "Apps") return true;
  return event.key === "F10" && event.shiftKey;
}

export interface RowRect {
  left: number;
  top: number;
  bottom: number;
}

/** A keyboard-triggered menu hangs under the row, at its text rather than its edge. */
export function anchorForRect(rect: RowRect): Point {
  return { x: rect.left + 12, y: rect.bottom };
}

/* ---------------------------------------------------------------------------
 * Placement
 * ------------------------------------------------------------------------- */

export const MENU_MARGIN_PX = 8;

export interface Size {
  width: number;
  height: number;
}

/**
 * Keeps the menu on screen: it grows down-right from the anchor when there is
 * room, flips above or to the left of it when there is not, and is clamped as a
 * last resort so a menu taller than the window still shows from the top.
 */
export function placeMenu(anchor: Point, menu: Size, viewport: Size): Point {
  const maxX = Math.max(MENU_MARGIN_PX, viewport.width - menu.width - MENU_MARGIN_PX);
  const maxY = Math.max(MENU_MARGIN_PX, viewport.height - menu.height - MENU_MARGIN_PX);

  const x = anchor.x + menu.width > viewport.width - MENU_MARGIN_PX ? anchor.x - menu.width : anchor.x;
  const y = anchor.y + menu.height > viewport.height - MENU_MARGIN_PX ? anchor.y - menu.height : anchor.y;

  return {
    x: Math.min(Math.max(x, MENU_MARGIN_PX), maxX),
    y: Math.min(Math.max(y, MENU_MARGIN_PX), maxY),
  };
}

/* ---------------------------------------------------------------------------
 * What the menu says
 * ------------------------------------------------------------------------- */

export type MenuAction =
  | { type: "hidden"; hidden: boolean }
  | { type: "pin"; pinned: boolean }
  | { type: "remove-feed" }
  | { type: "confirm-remove" }
  | { type: "cancel-remove" };

export interface MenuItemModel {
  action: MenuAction;
  label: string;
  /** Selected state, for the view radios. */
  checked: boolean;
  disabled: boolean;
  /** Optional leading glyph, when the item's meaning has a marker. */
  glyph?: string;
}

export interface MenuModel {
  /** A category row offers hide/show and the mark; a feed row offers removal. */
  kind: "category" | "feed";
  label: string;
  /** Why the items cannot be used, when they cannot. */
  note: string | null;
  /** Hide/Show. Null for a feed row. */
  toggle: MenuItemModel | null;
  /**
   * Pin/Unpin. One state, one item, one word, both kinds of row: a row is
   * either pinned or it is not. Where the mark is kept decides the storage, not
   * the meaning — Pinned Categories owns a category on the server when it is
   * installed, and this device keeps it otherwise; a feed is always this
   * device. It is a pin in every case, so it is called one in every case.
   */
  pin: MenuItemModel | null;
  /** Remove, for a feed row. Replaced by `confirm` once it is chosen. */
  remove: MenuItemModel | null;
  /** The second half of a removal: confirm or back out. Empty otherwise. */
  confirm: MenuItemModel[];
}


/**
 * The menu for one category row: hide or show it, pin or unpin it.
 *
 * Views are not here on purpose. Revealing hidden categories from a row menu
 * defeats the point of hiding them; the view lives on the sidebar band, next to
 * the lock.
 *
 * `state` is whichever block is deciding (see `resolveHidden`), and `authority`
 * says which one that is. It matters for one word: with this device deciding,
 * the item is offered with no note at all, because there is nothing wrong with
 * the server — the hide simply lands here rather than there.
 */
export function categoryMenu(
  state: HiddenCategoriesState,
  label: string,
  pinned: boolean,
  authority: HiddenAuthority = "extension",
): MenuModel {
  const words = pinWords();
  const id = categoryIdForLabel(state, label);
  const hidden = isHiddenCategory(state, label);
  const usable = authority === "local" || (state.available && id !== null);

  const notes: string[] = [];
  // With this device deciding there is nothing to note: hiding works, it simply
  // stays here, and a note would read as an apology for a control that does
  // exactly what it promises.
  if (authority !== "local") {
    if (!state.available) {
      notes.push("The Hidden Categories extension is not answering, so nothing can be hidden right now.");
    } else if (id === null) {
      notes.push("This category has no id on the server, so it cannot be hidden.");
    } else if (state.locked) {
      notes.push("Hidden Categories is locked; the server will refuse changes.");
    }
  }

  return {
    kind: "category",
    label,
    note: notes.length === 0 ? null : notes.join(" "),
    // One entry, whichever storage it lands in. There is one mark on a
    // category, and it is a pin.
    pin: {
      action: { type: "pin", pinned: !pinned },
      label: pinned ? words.remove : words.add,
      glyph: "📌",
      checked: false,
      disabled: false,
    },
    // Always offered: hiding is the one thing a category row is for, and an item
    // that disappears when the extension is slow or absent reads as "this app
    // cannot hide things" rather than "the server is not answering". It is
    // disabled, with the reason in the note, only when there is nowhere to write.
    toggle: {
      action: { type: "hidden", hidden: !hidden },
      label: hidden ? "Show" : "Hide",
      checked: false,
      disabled: !usable,
    },
    remove: null,
    confirm: [],
  };
}

/**
 * The menu for one feed row.
 *
 * Removal is the only thing a feed can be offered that the app cannot do from
 * the row itself, and it is destructive, so it arrives in two steps: asking
 * for the removal, then confirming it. `confirm` is that second step; it holds
 * both answers, so backing out is as reachable as going ahead.
 */
export function feedMenu(
  title: string,
  confirming: boolean,
  pinned = false,
): MenuModel {
  const words = pinWords();
  return {
    kind: "feed",
    label: title,
    note: confirming ? "This removes the feed and its unread items from the server." : null,
    toggle: null,
    pin: confirming
      ? null
      : { action: { type: "pin", pinned: !pinned }, label: pinned ? words.remove : words.add, glyph: "📌", checked: false, disabled: false },
    remove: confirming
      ? null
      : {
          action: { type: "confirm-remove" },
          label: "Remove feed…",
          checked: false,
          disabled: false,
        },
    confirm: confirming
      ? [
          {
            action: { type: "remove-feed" },
            label: "Remove feed",
            checked: false,
            disabled: false,
          },
          {
            action: { type: "cancel-remove" },
            label: "Cancel",
            checked: false,
            disabled: false,
          },
        ]
      : [],
  };
}
