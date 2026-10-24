/**
 * Dragging a row: a feed onto another feed to rearrange or onto a category to
 * file it there, a category onto another category to reorder the folders.
 *
 * Written with pointer events rather than HTML5 drag-and-drop on purpose: the
 * desktop build runs in WebKitGTK, where `draggable` support is partial and the
 * drag image is drawn by the platform. Pointer events behave the same in the
 * browser preview and in the native window, and they let the drop target be
 * whatever is painted under the cursor.
 *
 * The drop is expressed as one instruction — "put this feed before that feed"
 * or "before nothing" — so a gap, a row's top half and a row's lower half all
 * resolve to the same kind of answer.
 */

/** Pixels before a press becomes a drag. */
const THRESHOLD = 5;

/** How long after a drop a click is still considered part of the drag. */
const CLICK_GRACE = 250;

/** Edge band, in px, that scrolls the list while dragging near it. */
const EDGE = 28;

/** Pixels per pointermove when auto-scrolling. */
const EDGE_STEP = 12;

export interface RowDrop {
  /** The id of the row being moved — a feed id or a category id. */
  moving: string;
  /** Which list it landed in: a category label for feeds, `LIST_CATEGORIES` for categories. */
  target: string;
  /** The id it should land before, or null for the end of the list. */
  before: string | null;
}

/** The feed filing drop, kept for readers of this module. */
export type FeedDrop = RowDrop;

/** Where a category drag lands. Categories are one flat list, so there is one. */
export const LIST_CATEGORIES = "categories";

/**
 * How to read a list of rows out of the DOM.
 *
 * The feed list and the category list differ only in attribute names, so both
 * drags run through this one implementation rather than two copies of the
 * pointer handling.
 */
export interface RowDragOptions {
  /** Attribute marking a draggable row; its value is the id that row moves. */
  rowAttr: string;
  /** Attribute on a row holding the id of the list it belongs to. */
  targetAttr: string;
  /** Attribute on a row holding the id of the row after it. */
  nextAttr: string;
  /** Optional: attribute marking the block that wraps a whole list. */
  sectionAttr?: string;
  /** Optional: attribute on that block holding the id of the block after it. */
  sectionNextAttr?: string;
  /** Value used for `target` when a drop has no section attribute. */
  listName?: string;
  /**
   * Optional: attribute marking a list's title bar. Its halves mean two
   * different things — above it is *the previous list's end*, below it is
   * *this list's first row* — so a feed can be dropped just over a folder
   * without being filed into it.
   */
  headerAttr?: string;
  /** Attribute on that title holding the label of the list before it, or "". */
  headerPrevAttr?: string;
  /** Attribute on that title holding the id of its own first row, or "". */
  headerFirstAttr?: string;
  /** Attribute on a list's block holding its own label, for drops in its gaps. */
  sectionCatAttr?: string;
}

/** Feeds: a feed row, its category label, and the feed after it. */
const FEED_ROWS: RowDragOptions = {
  rowAttr: "data-drop-feed",
  targetAttr: "data-drop-cat",
  nextAttr: "data-drop-next",
  headerAttr: "data-drop-head",
  headerPrevAttr: "data-drop-head-prev",
  headerFirstAttr: "data-drop-head-first",
  sectionCatAttr: "data-drop-section",
};

/** How far above a list's title an empty gap still counts as "before it". */
const HEADER_BAND = 16;

/** Where the DOM is read from, so the rule can be tested without one. */
export interface DropPointHooks {
  /** Defaults to `document.elementFromPoint`. */
  elementFromPoint?: (x: number, y: number) => Element | null;
  /** Defaults to every title bar on the page; used for the gaps between lists. */
  headers?: () => Element[];
}

/** The vertical middle of an element, or null when there is no element. */
function middleOf(element: Element | null): number | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

/**
 * The answer for a drop over a list's own block.
 *
 * A block's title splits it: above the title's middle is *before this list*,
 * which belongs to the list before it; below is this list's first row. An empty
 * area below the last row is this list's end. This is what makes the space
 * *above* a folder reachable at all — without it, hovering anywhere over the
 * folder resolved to "file the feed into it", so a feed could not be dropped
 * next to a folder, only inside one.
 */
function insideSection(
  y: number,
  section: Element,
  sectionCatAttr: string,
  options: RowDragOptions,
): { target: string; before: string | null } | null {
  const own = section.getAttribute(sectionCatAttr) ?? "";
  if (own === "") return null;
  const header = options.headerAttr === undefined ? null : section.querySelector(`[${options.headerAttr}]`);
  const first = options.headerFirstAttr === undefined ? null : (header?.getAttribute(options.headerFirstAttr) ?? null);
  const prev = options.headerPrevAttr === undefined ? null : (header?.getAttribute(options.headerPrevAttr) ?? null);
  const ownFirst = first === "" ? null : first;
  const mid = middleOf(header);
  if (mid !== null && y < mid) {
    if (prev !== null && prev !== "") return { target: prev, before: null };
    return { target: own, before: ownFirst };
  }
  const rows = Array.from(section.querySelectorAll(`[${options.rowAttr}]`));
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const lastBottom = last === null ? null : last.getBoundingClientRect().bottom;
  if (lastBottom !== null && y > lastBottom) return { target: own, before: null };
  return { target: own, before: ownFirst };
}

/** What sits under the pointer, in drop terms. */
export function dropTargetAt(
  x: number,
  y: number,
  options: RowDragOptions = FEED_ROWS,
  hooks: DropPointHooks = {},
): { target: string; before: string | null } | null {
  const point =
    hooks.elementFromPoint ?? ((px: number, py: number) => document.elementFromPoint(px, py));
  const element = point(x, y);

  // A row: its halves pick "before this row" and "after it", which is also how
  // the gap between two rows is reached.
  const row = element?.closest<Element>(`[${options.rowAttr}]`) ?? null;
  if (row !== null) {
    const rect = row.getBoundingClientRect();
    const lowerHalf = y > rect.top + rect.height / 2;
    const here = row.getAttribute(options.rowAttr);
    const next = row.getAttribute(options.nextAttr);
    return {
      target: row.getAttribute(options.targetAttr) ?? options.listName ?? "",
      before: lowerHalf ? (next ?? null) : here,
    };
  }

  // A list's title bar: over its top half the feed belongs to the list above.
  if (options.headerAttr !== undefined) {
    const header = element?.closest<Element>(`[${options.headerAttr}]`) ?? null;
    if (header !== null) {
      const own = header.getAttribute(options.targetAttr) ?? options.listName ?? "";
      const first = options.headerFirstAttr === undefined ? null : header.getAttribute(options.headerFirstAttr);
      const prev = options.headerPrevAttr === undefined ? null : header.getAttribute(options.headerPrevAttr);
      const mid = middleOf(header);
      if (mid !== null && y <= mid && prev !== null && prev !== "") {
        return { target: prev, before: null };
      }
      return { target: own, before: first === "" ? null : first };
    }
  }

  // A list's block, hit in its own gaps rather than on a row.
  if (options.sectionCatAttr !== undefined) {
    const section = element?.closest<Element>(`[${options.sectionCatAttr}]`) ?? null;
    if (section !== null) {
      const resolved = insideSection(y, section, options.sectionCatAttr, options);
      if (resolved !== null) return resolved;
    }
  }

  // A gap so thin that the point lands on the list's container and not on any
  // block: the title immediately below the pointer still names the boundary.
  if (options.headerAttr !== undefined) {
    const headers =
      hooks.headers !== undefined
        ? hooks.headers()
        : Array.from(document.querySelectorAll(`[${options.headerAttr}]`));
    let nearest: { header: Element; distance: number } | null = null;
    for (const header of headers) {
      const distance = header.getBoundingClientRect().top - y;
      if (distance >= -1 && distance <= HEADER_BAND && (nearest === null || distance < nearest.distance)) {
        nearest = { header, distance };
      }
    }
    if (nearest !== null) {
      const header = nearest.header;
      const own = header.getAttribute(options.targetAttr) ?? options.listName ?? "";
      const first = options.headerFirstAttr === undefined ? null : header.getAttribute(options.headerFirstAttr);
      const prev = options.headerPrevAttr === undefined ? null : header.getAttribute(options.headerPrevAttr);
      if (prev !== null && prev !== "") return { target: prev, before: null };
      return { target: own, before: first === "" ? null : first };
    }
  }

  // A drag down the sidebar passes over feed rows far more often than over the
  // folder titles, so a block of feeds resolves to the folder it belongs to: the
  // drop lands next to that folder, never into it.
  //
  // Which side of the folder is the block's own top and bottom, not the folder's
  // title bar: hovering the last rows of a category means "below this one", and
  // hovering its first rows means "above it". Reading only the folder's id made
  // every hover land above, so a slot after the last category was unreachable
  // and the row that would move never lit up.
  if (options.sectionAttr !== undefined) {
    const section = element?.closest<Element>(`[${options.sectionAttr}]`) ?? null;
    if (section !== null) {
      const id = section.getAttribute(options.sectionAttr);
      if (id !== null && id !== "") {
        const rect = section.getBoundingClientRect();
        const lowerHalf = y > rect.top + rect.height / 2;
        const next =
          options.sectionNextAttr === undefined ? null : section.getAttribute(options.sectionNextAttr);
        if (lowerHalf && options.sectionNextAttr !== undefined) {
          return { target: options.listName ?? "", before: next === "" ? null : next };
        }
        return { target: options.listName ?? "", before: id };
      }
    }
  }
  const list = element?.closest<Element>(`[${options.targetAttr}]`) ?? null;
  if (list !== null) return { target: list.getAttribute(options.targetAttr) ?? "", before: null };
  return null;
}

function scrollParentOf(from: Element | null): HTMLElement | null {
  let node: Element | null = from;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

export interface RowDragHandlers {
  /** What the pointer is over, or null when it is over nothing droppable. */
  onHover: (target: { target: string; before: string | null } | null) => void;
  /** A completed drag. Only called when the pointer moved far enough. */
  onDrop: (drop: RowDrop) => void;
  /** A drag started, so a long-press menu can be cancelled. */
  onStart?: () => void;
  /** A drag ended or was cancelled. */
  onEnd?: () => void;
}

/** Kept under its old name: the shape did not change, only the payload's names. */
export type FeedDragHandlers = RowDragHandlers;

export interface FeedDrag {
  /** Call from a row's pointerdown. */
  arm: (event: PointerEvent, moving: string) => void;
  /** True just after a drop, so the click it ends with can be ignored. */
  justDropped: () => boolean;
  dispose: () => void;
}

export function createFeedDrag(handlers: RowDragHandlers, options: RowDragOptions = FEED_ROWS): FeedDrag {
  let moving: string | null = null;
  let pointer: number | null = null;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let ghost: HTMLElement | null = null;
  let lifted: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let target: { target: string; before: string | null } | null = null;
  let endedAt = 0;
  /** The pointer's offset inside the row when the drag began, so the row does
   *  not jump to centre itself under the cursor on the first frame. */
  let grabX = 0;
  let grabY = 0;
  /** Coalesced pointer position: one read, one write per frame, never per event. */
  let pending: { x: number; y: number } | null = null;
  let frame = 0;

  function makeGhost(source: HTMLElement, width: number, height: number): HTMLElement {
    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.classList.add("feed-ghost");
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    return clone;
  }

  /** Put the ghost where the row was lifted from, in one write. */
  function placeGhost(x: number, y: number): void {
    if (ghost === null) return;
    ghost.style.transform = `translate3d(${x - grabX}px, ${y - grabY}px, 0) scale(1.02)`;
  }

  function begin(event: PointerEvent, row: HTMLElement) {
    dragging = true;
    handlers.onStart?.();
    const rect = row.getBoundingClientRect();
    ghost = makeGhost(row, rect.width, rect.height);
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    placeGhost(event.clientX, event.clientY);
    document.body.append(ghost);
    // The row stays where it is, dimmed, so the list does not reflow under the
    // pointer — a row that vanished would shift every row below it and the drop
    // target would move with them.
    lifted = row;
    row.setAttribute("data-lifted", "");
    document.documentElement.classList.add("feed-dragging");
    requestAnimationFrame(() => ghost?.classList.add("lifted"));
  }

  /**
   * One frame of the drag.
   *
   * Pointer events arrive several times per frame on a mouse and dozens of times
   * per frame on a trackpad, and each of them used to read layout (a rect, then
   * `elementFromPoint`, then another rect) straight after writing the ghost's
   * position — the classic read-after-write thrash, which is what made the drag
   * feel heavy. Everything is measured first, then everything is written, and
   * only once per animation frame.
   */
  function flush(): void {
    frame = 0;
    const at = pending;
    pending = null;
    if (at === null || !dragging) return;
    let y = at.y;
    if (scroller !== null) {
      const rect = scroller.getBoundingClientRect();
      if (y < rect.top + EDGE) {
        scroller.scrollTop -= EDGE_STEP;
        y = Math.max(y, rect.top + EDGE);
      } else if (y > rect.bottom - EDGE) {
        scroller.scrollTop += EDGE_STEP;
        y = Math.min(y, rect.bottom - EDGE);
      }
    }
    const next = dropTargetAt(at.x, y, options);
    placeGhost(at.x, at.y);
    const changed =
      next?.target !== target?.target || (next?.before ?? null) !== (target?.before ?? null);
    target = next;
    if (changed) handlers.onHover(next);
  }

  function onMove(event: PointerEvent) {
    if (pointer === null || event.pointerId !== pointer) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < THRESHOLD) return;
      const row = event.target instanceof Element
        ? (event.target.closest<HTMLElement>(`[${options.rowAttr}]`) ?? null)
        : null;
      if (row === null) return;
      begin(event, row);
    }
    event.preventDefault();
    pending = { x: event.clientX, y: event.clientY };
    if (frame === 0) frame = requestAnimationFrame(flush);
  }

  function finish(dropped: boolean) {
    const moved = dragging;
    const destination = target;
    const id = moving;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKeyDown);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    pending = null;
    lifted?.removeAttribute("data-lifted");
    lifted = null;
    const settling = ghost;
    ghost = null;
    if (settling !== null) {
      // The row is placed, not teleported away: it settles for a frame or two
      // where the pointer let go of it while the list underneath takes it in.
      settling.classList.remove("lifted");
      settling.classList.add("dropping");
      window.setTimeout(() => settling.remove(), 140);
    }
    document.documentElement.classList.remove("feed-dragging");
    dragging = false;
    pointer = null;
    moving = null;
    target = null;
    scroller = null;
    if (moved) {
      endedAt = performance.now();
      handlers.onHover(null);
      handlers.onEnd?.();
      // Dropping a row on itself is not a move. Saying so here keeps the caller
      // from having to special-case "before myself", which is not a position.
      const landedOnSelf = destination !== null && destination.before === id;
      if (dropped && destination !== null && id !== null && !landedOnSelf) {
        handlers.onDrop({ moving: id, target: destination.target, before: destination.before });
      }
    }
  }

  function onUp() {
    finish(true);
  }

  function onCancel() {
    finish(false);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  }

  function arm(event: PointerEvent, id: string) {
    if (event.button !== 0) return;
    // A finger on a row is scrolling the list, not filing it. Touch and pen keep
    // the gesture the browser already does well; dragging a feed is a mouse
    // gesture until there is a touch affordance designed for it.
    if (event.pointerType === "touch") return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    moving = id;
    pointer = event.pointerId;
    dragging = false;
    target = null;
    startX = event.clientX;
    startY = event.clientY;
    scroller = scrollParentOf(event.target instanceof Element ? event.target : null);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
  }

  return {
    arm,
    justDropped: () => endedAt !== 0 && performance.now() - endedAt < CLICK_GRACE,
    dispose: () => {
      finish(false);
      endedAt = 0;
    },
  };
}

export { THRESHOLD as FEED_DRAG_THRESHOLD, CLICK_GRACE as FEED_DRAG_CLICK_GRACE, EDGE as FEED_DRAG_EDGE };
