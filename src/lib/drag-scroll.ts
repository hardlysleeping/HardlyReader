/**
 * Drag the content with the pointer, the way a finger does on a touchscreen.
 *
 * One listener on the window rather than one per pane: every scroll surface in
 * the app already has a scrollable ancestor (sidebar list, article list, reader
 * body, reading controls), and finding that ancestor at pointerdown means a new
 * scroll container gets the behaviour without being wired up.
 *
 * The rules that keep it from eating the app:
 *
 * - **Mouse and finger.** Both pan here, so both feel the same: a drag places the
 *   content and a flick throws it. The pointer is taken from the browser only on
 *   surfaces that hand it over (`touch-action: none` on the pane's scroller);
 *   everywhere else — menus, panels, dialogs — the browser still pans, because
 *   those are not the reader and have no fling to match.
 * - **A throw, not a glide.** Release speed is read from the last `FLING.window`
 *   of the gesture, so letting go at the end of a long drag still throws if the
 *   hand was still moving, and a drag that slowed to a stop does not.
 * - **A press catches it.** Any new press stops the content immediately, wherever
 *   it lands, and that press does not also count as a click on the row underneath.
 * - **Nothing happens until the pointer has travelled `THRESHOLD`px.** Below
 *   that it is a click, and a click must stay a click — rows, buttons and links
 *   are how the app is used. A finger that landed on something tappable gets
 *   `CONTROL_THRESHOLD` instead, because a hand is not steady and a 24px toggle
 *   cannot answer a 5px trigger.
 * - **A pan swallows the click it ends with.** Otherwise releasing a drag over a
 *   row would also open the article that happened to be under the cursor.
 * - **Controls that own the pointer keep it**: `input`, `textarea`, `select`,
 *   `[contenteditable]` and the pane gutter (resize). A range slider must slide,
 *   not pan the page.
 * - **`data-no-drag-scroll` is a mouse opt-out, not a finger one.** It exists
 *   because a mouse press that slid a few pixels became a pan and swallowed the
 *   click, which made the toggle under it look dead — and a mouse has a wheel
 *   and a scrollbar to fall back on. A finger has neither: the pan is the only
 *   way the content moves under it, so a finger is never refused there.
 * - **Shift, Alt, Ctrl and Meta disable it for the mouse**, so text selection and
 *   the browser's own gestures still work when asked for by name.
 */

import { decayVelocity, isFlung, isSpent, releaseVelocity, FLING, type FlingSample } from "./fling";

/** Pixels the pointer must travel before a press becomes a pan. */
const THRESHOLD = 5;

/**
 * The same, for a finger that went down on something tappable.
 *
 * A hand is not steady: 5px is inside the shake of a deliberate tap, so with one
 * threshold every press on a 24px star became a pan and the tap was swallowed.
 * Ten is still a short drag — a finger that means to scroll leaves it in the
 * first centimetre — and it is a threshold per *press*, not a new global one: a
 * finger that went down on the row's body still pans at `THRESHOLD`.
 */
const CONTROL_THRESHOLD = 10;

/** How long after a pan ends a click is still considered part of it. */
const CLICK_GRACE = 250;

/** Targets that own pointer movement themselves, whatever the pointer is. */
const OWNS_POINTER = "input, textarea, select, option, [contenteditable='true'], .gutter";

/**
 * The same, plus the mouse-only opt-out.
 *
 * `data-no-drag-scroll` was added because a mouse press that slid a few pixels
 * became a pan and swallowed the click it ended with, so the control under it
 * looked dead. That is a mouse problem: a mouse has a wheel and a scrollbar. A
 * finger has neither — the pan is the only way the content moves under it — so
 * a finger only hands the gesture to something that would genuinely take it.
 */
const MOUSE_OWNS_POINTER = `${OWNS_POINTER}, [data-no-drag-scroll]`;

/**
 * What a finger is more likely to be aiming at than dragging.
 *
 * A press that starts on one of these still pans — the list has to move under a
 * hand that started on a row — it just has to travel `CONTROL_THRESHOLD` first,
 * so a shaky tap lands on the thing it was aimed at.
 */
const TAPPABLE = "button, a[href], [role='button'], [data-no-drag-scroll]";

/** The panning state class, so CSS can show a grabbing cursor. */
const PANNING_CLASS = "drag-panning";

/** The longest frame the throw will integrate in one go, so a stall cannot skip. */
const MAX_FRAME = 34;

/**
 * When the pointer was there, as best the event can say.
 *
 * `timeStamp` is the pointer's own clock and survives coalescing, which is what
 * a release speed needs; it is also `0` on events produced by some synthetic
 * dispatch paths. Falling back to the clock at receipt keeps a release throwing
 * there instead of reading every sample as the same instant and throwing nothing.
 */
function when(event: Event): number {
  const stamp = event.timeStamp;
  return Number.isFinite(stamp) && stamp > 0 ? stamp : performance.now();
}

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
  /** Whether this container can be panned sideways, decided at the press. */
  let sideways = false;
  let startX = 0;
  let startY = 0;
  /** How far this press has to travel, which depends on what it landed on. */
  let threshold = THRESHOLD;
  let lastX = 0;
  let lastY = 0;
  /** Where the pointer has been lately, for the release speed. */
  let samples: FlingSample[] = [];
  /** The throw in progress, if any. */
  let fling: { el: HTMLElement; raf: number } | null = null;
  /** When the last pan ended, so its click can be swallowed. */
  let endedAt = 0;
  /** Whether the press that is down is the one that caught a throw. */
  let caughtPress = false;
  /** Which pan we are on, so a deferred class removal cannot land in the next. */
  let panSeq = 0;

  /**
   * Stop the content where it is.
   *
   * Called by the next press, by the wheel and by the end of the throw itself —
   * a press that catches the content also ends the throw, so the pane is still
   * under the hand when the hand starts moving again.
   */
  function stopFling(): void {
    if (fling === null) return;
    cancelAnimationFrame(fling.raf);
    fling = null;
  }

  /**
   * Let go: keep the speed the pointer had, and lose `FLING.friction` per frame.
   *
   * The content moves opposite the hand, so the throw is the pointer's velocity
   * negated. Each axis stops on its own when it reaches the end of the scroller,
   * which is why a diagonal throw along the top of a list keeps sliding sideways.
   */
  function startFling(el: HTMLElement, vxPointer: number, vyPointer: number): void {
    let vx = -vxPointer;
    let vy = -vyPointer;
    if (!isFlung(vx, vy)) return;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(now - last, MAX_FRAME) || FLING.frame;
      last = now;
      if (vy !== 0) {
        const before = el.scrollTop;
        el.scrollTop = before + vy * dt;
        if (el.scrollTop === before) vy = 0;
      }
      // A throw is the pan's momentum, so it is spent on the same axes: no
      // sideways fling out of a column that has nothing to the side.
      if (vx !== 0 && sideways) {
        const before = el.scrollLeft;
        el.scrollLeft = before + vx * dt;
        if (el.scrollLeft === before) vx = 0;
      } else if (vx !== 0) {
        vx = 0;
      }
      const next = decayVelocity(vx, vy, dt);
      vx = next.vx;
      vy = next.vy;
      if (isSpent(vx, vy) || (vx === 0 && vy === 0)) {
        fling = null;
        return;
      }
      fling = { el, raf: requestAnimationFrame(step) };
    };
    fling = { el, raf: requestAnimationFrame(step) };
  }

  function onPointerDown(event: PointerEvent) {
    // A press catches a throw first: the hand stops the content where it is, and
    // the press is not also a click on the row it landed on.
    const flingCaught = fling !== null;
    if (flingCaught) {
      stopFling();
      endedAt = performance.now();
    }
    if (event.button !== 0) return;
    if (event.pointerType !== "mouse" && event.pointerType !== "touch") return;
    // Modifiers are a mouse idea: a finger has none.
    if (event.pointerType === "mouse" && (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey))
      return;
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin) return;
    // A finger gives the gesture up only to something that would actually take
    // the movement: typing, a slider, the pane edge. A button or a row is panned
    // past instead, because on a finger the pan is the only scroll there is. The
    // mouse keeps every opt-out it had, `data-no-drag-scroll` included.
    const finger = event.pointerType === "touch";
    if (origin.closest(finger ? OWNS_POINTER : MOUSE_OWNS_POINTER)) return;
    // A press that caught a throw stops it; it does not also open what it landed
    // on, however long the hand rests there before letting go.
    caughtPress = flingCaught;
    container = scrollableFrom(origin);
    if (!container) return;
    panSeq += 1;
    pointer = event.pointerId;
    panning = false;
    // A control has to be travelled past further than a plain surface: a tap on
    // a star that shakes below this is still a tap.
    threshold = finger && origin.closest(TAPPABLE) ? CONTROL_THRESHOLD : THRESHOLD;
    // Which axes this container actually has, decided once: a pointermove that
    // measures `scrollWidth` after writing `scrollTop` forces a layout on every
    // event. An article is one column by definition, so it says so itself
    // (`data-scroll-axis="y"`) and is never dragged sideways however wide a
    // child turns out to be.
    const declared = container.dataset?.scrollAxis;
    sideways =
      declared === "y"
        ? false
        : declared === "x" || container.scrollWidth - container.clientWidth > 1;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
    // The event's own clock, not the clock at receipt: a burst of coalesced moves
    // arrives in one task, and reading the time here would give them all the same
    // instant — a release speed of zero for the fastest flick.
    samples = [{ t: when(event), x: event.clientX, y: event.clientY }];
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(event: PointerEvent) {
    if (!container || event.pointerId !== pointer) return;
    if (!panning) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < threshold) return;
      panning = true;
      // A throw the hand overtakes is over: grabbing again mid-flight must not
      // also inherit the old speed.
      stopFling();
      document.documentElement.classList.add(PANNING_CLASS);
    }
    event.preventDefault();
    // Content follows the pointer: drag up, the text moves up.
    container.scrollTop -= event.clientY - lastY;
    // ...and only sideways where there is something sideways to reach. An
    // article is one column wide by definition, so a finger that drifts left
    // must not slide the prose off its own margin: the axis is spent or it is
    // not there at all.
    if (sideways) {
      container.scrollLeft -= event.clientX - lastX;
    }
    lastX = event.clientX;
    lastY = event.clientY;
    const now = when(event);
    samples.push({ t: now, x: event.clientX, y: event.clientY });
    // Only the tail of the gesture can throw, so the head is dropped as we go.
    samples = samples.filter((sample) => now - sample.t <= FLING.window * 2);
  }

  function onPointerUp(event: PointerEvent) {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (event.pointerId !== pointer) return;
    const el = container;
    const threw = panning;
    // A pan that ended swallows its click; so does a press that caught a throw,
    // even if it never moved — the hand was stopping the content, not choosing a
    // row.
    if (panning || caughtPress) endedAt = performance.now();
    caughtPress = false;
    panning = false;
    pointer = null;
    container = null;
    // A pan that ended without ever becoming a drag was a click, and a drag that
    // ended slowly is a placement: only real speed throws.
    if (threw && el !== null && event.type === "pointerup") {
      const { vx, vy } = releaseVelocity(samples, when(event));
      startFling(el, vx, vy);
    }
    samples = [];
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

  // The wheel is a hand on the content too: it catches the throw rather than
  // fighting it, so the pane answers the wheel on the next notch instead of a
  // second later.
  function onWheel(): void {
    stopFling();
  }

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("click", onClick, { capture: true });
  window.addEventListener("wheel", onWheel, { passive: true });

  return () => {
    stopFling();
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("wheel", onWheel);
    document.documentElement.classList.remove(PANNING_CLASS);
  };
}
