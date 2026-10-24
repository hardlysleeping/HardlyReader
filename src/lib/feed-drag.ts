/**
 * Dragging a feed row: onto another feed to rearrange, onto a category to file
 * it there.
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

export interface FeedDrop {
  /** The feed being moved. */
  streamId: string;
  /** Label of the category it was dropped in. */
  category: string;
  /** Feed it should land before, or null for the end of the category. */
  before: string | null;
}

/** What sits under the pointer, in drop terms. */
export function dropTargetAt(x: number, y: number): { category: string; before: string | null } | null {
  const element = document.elementFromPoint(x, y);
  if (element === null) return null;
  const row = element.closest<HTMLElement>("[data-drop-feed]");
  if (row !== null) {
    const rect = row.getBoundingClientRect();
    const lowerHalf = y > rect.top + rect.height / 2;
    return {
      category: row.dataset.dropCat ?? "",
      before: lowerHalf ? (row.dataset.dropNext ?? null) : (row.dataset.dropFeed ?? null),
    };
  }
  const category = element.closest<HTMLElement>("[data-drop-cat]");
  if (category !== null) return { category: category.dataset.dropCat ?? "", before: null };
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

export interface FeedDragHandlers {
  /** What the pointer is over, or null when it is over nothing droppable. */
  onHover: (target: { category: string; before: string | null } | null) => void;
  /** A completed drag. Only called when the pointer moved far enough. */
  onDrop: (drop: FeedDrop) => void;
  /** A drag started, so a long-press menu can be cancelled. */
  onStart?: () => void;
  /** A drag ended or was cancelled. */
  onEnd?: () => void;
}

export interface FeedDrag {
  /** Call from a row's pointerdown. */
  arm: (event: PointerEvent, streamId: string) => void;
  /** True just after a drop, so the click it ends with can be ignored. */
  justDropped: () => boolean;
  dispose: () => void;
}

export function createFeedDrag(handlers: FeedDragHandlers): FeedDrag {
  let streamId: string | null = null;
  let pointer: number | null = null;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let ghost: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let target: { category: string; before: string | null } | null = null;
  let endedAt = 0;

  function makeGhost(source: HTMLElement, width: number, height: number): HTMLElement {
    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.classList.add("feed-ghost");
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    return clone;
  }

  function begin(event: PointerEvent, row: HTMLElement) {
    dragging = true;
    handlers.onStart?.();
    const rect = row.getBoundingClientRect();
    ghost = makeGhost(row, rect.width, rect.height);
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${event.clientY - rect.height / 2}px`;
    document.body.append(ghost);
    document.documentElement.classList.add("feed-dragging");
  }

  function onMove(event: PointerEvent) {
    if (pointer === null || event.pointerId !== pointer) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < THRESHOLD) return;
      const row = event.target instanceof Element
        ? (event.target.closest<HTMLElement>("[data-drop-feed]") ?? null)
        : null;
      if (row === null) return;
      begin(event, row);
    }
    event.preventDefault();
    if (ghost !== null) {
      ghost.style.top = `${event.clientY - ghost.offsetHeight / 2}px`;
    }
    if (scroller !== null) {
      const rect = scroller.getBoundingClientRect();
      if (event.clientY < rect.top + EDGE) scroller.scrollTop -= EDGE_STEP;
      else if (event.clientY > rect.bottom - EDGE) scroller.scrollTop += EDGE_STEP;
    }
    const next = dropTargetAt(event.clientX, event.clientY);
    const changed =
      next?.category !== target?.category || (next?.before ?? null) !== (target?.before ?? null);
    target = next;
    if (changed) handlers.onHover(next);
  }

  function finish(dropped: boolean) {
    const moved = dragging;
    const destination = target;
    const id = streamId;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKeyDown);
    ghost?.remove();
    ghost = null;
    document.documentElement.classList.remove("feed-dragging");
    dragging = false;
    pointer = null;
    streamId = null;
    target = null;
    scroller = null;
    if (moved) {
      endedAt = performance.now();
      handlers.onHover(null);
      handlers.onEnd?.();
      // Dropping a row on itself is not a move. Saying so here keeps the caller
      // from having to special-case "before myself", which is not a position.
      const landedOnSelf = destination !== null && destination.before === id;
      if (dropped && destination !== null && id !== null && destination.category !== "" && !landedOnSelf) {
        handlers.onDrop({ streamId: id, category: destination.category, before: destination.before });
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
    streamId = id;
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
