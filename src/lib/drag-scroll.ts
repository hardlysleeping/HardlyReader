/**
 * Drag the content with the mouse, the way a finger does on a touchscreen.
 *
 * One listener on the window rather than one per pane: every scroll surface in
 * the app already has a scrollable ancestor (sidebar list, article list, reader
 * body, reading controls), and finding that ancestor at pointerdown means a new
 * scroll container gets the behaviour without being wired up.
 *
 * The rules that keep it from eating the app:
 *
 * - **Mouse only.** Touch and pen already pan natively; running our own scroll
 *   for them would fight the browser's inertia and its scroll-chaining.
 * - **Nothing happens until the pointer has travelled `THRESHOLD`px.** Below
 *   that it is a click, and a click must stay a click — rows, buttons and links
 *   are how the app is used.
 * - **A pan swallows the click it ends with.** Otherwise releasing a drag over a
 *   row would also open the article that happened to be under the cursor.
 * - **Controls that own the pointer keep it**: `input`, `textarea`, `select`,
 *   `[contenteditable]`, the pane gutter (resize) and anything marked
 *   `data-no-drag-scroll`. A range slider must slide, not pan the page.
 * - **Shift, Alt, Ctrl and Meta disable it**, so text selection and the browser's
 *   own gestures still work when asked for by name.
 *
 * No momentum: a mouse is a precise device and a fling that keeps moving after
 * release is worse than a scroll that stops where the hand stops.
 */

/** Pixels the pointer must travel before a press becomes a pan. */
const THRESHOLD = 5;

/** How long after a pan ends a click is still considered part of it. */
const CLICK_GRACE = 250;

/** Targets that own pointer movement themselves. */
const OWNS_POINTER =
  "input, textarea, select, option, [contenteditable='true'], [data-no-drag-scroll], .gutter";

/** The panning state class, so CSS can show a grabbing cursor. */
const PANNING_CLASS = "drag-panning";

/** The nearest ancestor that can actually scroll in either direction. */
function scrollableFrom(from: Element | null): HTMLElement | null {
  let node: Element | null = from;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const scrollsY =
        node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(style.overflowY);
      const scrollsX =
        node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(style.overflowX);
      if (scrollsY || scrollsX) return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function installDragScroll(): () => void {
  let container: HTMLElement | null = null;
  let pointer: number | null = null;
  let panning = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  /** When the last pan ended, so its click can be swallowed. */
  let endedAt = 0;
  /** Which pan we are on, so a deferred class removal cannot land in the next. */
  let panSeq = 0;

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest(OWNS_POINTER)) return;
    container = scrollableFrom(origin);
    if (!container) return;
    panSeq += 1;
    pointer = event.pointerId;
    panning = false;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(event: PointerEvent) {
    if (!container || event.pointerId !== pointer) return;
    if (!panning) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < THRESHOLD) return;
      panning = true;
      document.documentElement.classList.add(PANNING_CLASS);
    }
    event.preventDefault();
    // Content follows the pointer: drag up, the text moves up.
    container.scrollTop -= event.clientY - lastY;
    container.scrollLeft -= event.clientX - lastX;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent) {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (event.pointerId !== pointer) return;
    if (panning) endedAt = performance.now();
    panning = false;
    pointer = null;
    container = null;
    // The panning class comes off a frame later, not now. It is what holds
    // snapping off, and re-arming the snap engine here hands the column back to
    // it before any listener that cares about the end of the drag has read the
    // position: the snap pulls the content to the card it started on, the drag
    // looks like it did nothing, and whether it survives depends on how far the
    // hand got — which is why it seemed to work now and then, and only one way.
    // A frame is invisible to the hand and enough for those readers.
    const seq = panSeq;
    requestAnimationFrame(() => {
      if (seq === panSeq) document.documentElement.classList.remove(PANNING_CLASS);
    });
  }

  function onClick(event: MouseEvent) {
    if (!endedAt || performance.now() - endedAt > CLICK_GRACE) return;
    endedAt = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("click", onClick, { capture: true });

  return () => {
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    document.documentElement.classList.remove(PANNING_CLASS);
  };
}
