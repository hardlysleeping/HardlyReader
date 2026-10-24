/**
 * Pull down from the top of a scroller to do one thing.
 *
 * The gesture only exists while the scroller is at its top — "nothing is
 * higher" — because pulling down in the middle of a long article means "read
 * up", not "leave". A vertical drag arms it; a horizontal one is left alone so
 * the pane swipe in the one-column layout still works, and a drag that starts
 * while the content is scrolled is ignored entirely.
 *
 * Feedback is a pill at the top of the window rather than a spinner in the
 * scroller: the action fires on release, so what the pill has to say is what
 * releasing will do.
 */

/** How far the content must travel before releasing counts as the gesture. */
export const ARM_PX = 64;

/** The pull is resisted and capped, so it feels like elastic rather than a drag. */
export const MAX_PULL = 88;

export function resist(distance: number): number {
  // Written so NaN — which fails every comparison — counts as no pull at all.
  if (!(distance > 0)) return 0;
  if (!Number.isFinite(distance)) return MAX_PULL;
  return Math.min(MAX_PULL, distance * 0.45);
}

/** True once letting go should do the thing. */
export function isArmed(pull: number): boolean {
  return pull >= ARM_PX;
}

export interface PullOptions {
  /** Shown while pulling, before the action is armed. */
  label: string;
  /** Shown once the pull is far enough to let go. */
  readyLabel?: string;
  /** What letting go does. */
  onPull: () => void;
  /** False to ignore the gesture for now, e.g. while it is already running. */
  enabled?: () => boolean;
}

export function pullDown(node: HTMLElement, options: PullOptions) {
  let opts = options;
  let startX = 0;
  let startY = 0;
  let pull = 0;
  let tracking = false;

  const pill = document.createElement("div");
  pill.className = "pull-pill";
  pill.setAttribute("aria-hidden", "true");

  function show(text: string, armed: boolean) {
    pill.textContent = text;
    pill.classList.toggle("armed", armed);
    if (pill.parentNode === null) document.body.appendChild(pill);
  }

  function hide() {
    pill.remove();
  }

  function settle() {
    pull = 0;
    node.style.transition = "transform 160ms ease-out";
    node.style.transform = "";
    hide();
    const done = () => {
      node.style.transition = "";
      node.removeEventListener("transitionend", done);
    };
    node.addEventListener("transitionend", done);
  }

  function onStart(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    if (opts.enabled !== undefined && !opts.enabled()) return;
    // Only from the top: a pull in the middle of the content is a scroll.
    if (node.scrollTop > 0) {
      tracking = false;
      return;
    }
    tracking = true;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    pull = 0;
  }

  function onMove(event: TouchEvent) {
    if (!tracking || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (pull === 0 && Math.abs(dx) > Math.abs(dy)) {
      // Sideways: that is the pane gesture's business.
      tracking = false;
      return;
    }
    if (dy <= 0) {
      if (pull !== 0) settle();
      return;
    }
    if (node.scrollTop > 0) {
      tracking = false;
      settle();
      return;
    }
    // Keep the browser's own overscroll out of it: this pull is ours.
    event.preventDefault();
    pull = resist(dy);
    node.style.transform = `translateY(${pull.toFixed(1)}px)`;
    show(isArmed(pull) ? (opts.readyLabel ?? "Release") : opts.label, isArmed(pull));
  }

  function onEnd() {
    if (!tracking) return;
    tracking = false;
    const fire = isArmed(pull);
    settle();
    if (fire) opts.onPull();
  }

  node.addEventListener("touchstart", onStart, { passive: true });
  node.addEventListener("touchmove", onMove, { passive: false });
  node.addEventListener("touchend", onEnd);
  node.addEventListener("touchcancel", onEnd);

  return {
    update(next: PullOptions) {
      opts = next;
    },
    destroy() {
      hide();
      node.style.transform = "";
      node.style.transition = "";
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    },
  };
}
