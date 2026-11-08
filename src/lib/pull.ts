/**
 * Pull down from the top of a scroller to do one thing.
 *
 * The gesture only exists while the scroller is at its top — "nothing is
 * higher" — because pulling down in the middle of a long article means "read
 * up", not "leave". A vertical drag arms it; a horizontal one is left alone so
 * the pane swipe in the one-column layout still works, and a drag that starts
 * while the content is scrolled is ignored entirely.
 *
 * Feedback is a slider that rises out of the bottom edge of the window, not a
 * pill at the top of it and not a spinner in the scroller. Three reasons, in
 * the order they matter: the action fires on release, so the feedback has to
 * say what releasing will do; a phone is held at the bottom, so an indicator
 * down there is one the hand can see without leaving the gesture; and a
 * slider that comes *up* while the content goes *down* reads as a spring being
 * loaded rather than as a second thing to watch.
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

/**
 * Where the slider sits for one pull distance. Two numbers, both 0..1.
 *
 * `rise` is how far the capsule has come out from under the bottom edge, over
 * the whole pull — so the hand sees it move on the first pixel of the drag.
 * `fill` is how much of the way to the arm point it is, and it stops at 1 —
 * the accent filling the capsule *is* the instruction to let go, so it must
 * finish at the arm point rather than at the cap, or a pull that is ready
 * would look no readier than the one before it.
 */
export function sliderMetrics(pull: number): { rise: number; fill: number; armed: boolean } {
  // Same reading of nonsense as `resist`: NaN is no pull, an infinite drag is
  // the cap. Anything else would draw a capsule that disagrees with the pull.
  const px = pull > 0 ? Math.min(Number.isFinite(pull) ? pull : MAX_PULL, MAX_PULL) : 0;
  return { rise: px / MAX_PULL, fill: Math.min(1, px / ARM_PX), armed: isArmed(px) };
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
  /**
   * False to remove the listeners altogether.
   *
   * `enabled` is "not now" — the gesture still exists and comes back. This is
   * "not at all": turning the pull off in Settings must leave nothing on the
   * node, because a handler that checks a flag on every touchstart is still a
   * handler the platform runs.
   */
  active?: () => boolean;
}

/**
 * The box that actually scrolls under this node.
 *
 * A list that is nested inside the feeds tree does not scroll itself — it is
 * sized by its posts and the tree scrolls (`ArticleList n`ested`.items` is
 * `overflow: visible` for exactly that reason). Reading `node.scrollTop` there
 * is reading 0 for ever, so the gesture armed at the bottom of a feed as
 * readily as at its top, and pulling up to read back through a feed started a
 * refresh instead. The gesture asks the nearest scrolling ancestor, and the
 * node itself when it is the scroller.
 */
function scrollerFor(node: HTMLElement): HTMLElement {
  let candidate: HTMLElement | null = node;
  while (candidate !== null) {
    const overflow = getComputedStyle(candidate).overflowY;
    const scrolls = overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    if (scrolls && candidate.scrollHeight > candidate.clientHeight + 1) return candidate;
    candidate = candidate.parentElement;
  }
  return node;
}

/**
 * Whether the content is still at its beginning.
 *
 * Two shapes, because there are two: the node scrolls itself (a pane's list),
 * or it is a list inside a scroller (a feed unfolded in the tree). In the
 * second the question is not "is the scroller at 0" — the tree above the feed
 * is content too — but "has this list been scrolled past", which is true exactly
 * while its own top edge is still at or below the top of the viewport.
 */
function atBeginning(node: HTMLElement, scroller: HTMLElement): boolean {
  if (scroller === node) return node.scrollTop <= 0;
  const listTop = node.getBoundingClientRect().top;
  const viewTop = scroller.getBoundingClientRect().top;
  return listTop >= viewTop - 1;
}

export function pullDown(node: HTMLElement, options: PullOptions) {
  let opts = options;
  let startX = 0;
  let startY = 0;
  let pull = 0;
  let tracking = false;

  /**
   * One node for the whole gesture: a capsule carrying the accent and the
   * words, appended to <body> so it can sit over the bottom edge of the window
   * rather than inside whichever scroller started the pull.
   */
  const slider = document.createElement("div");
  slider.className = "pull-slider";
  slider.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = "fill";
  const words = document.createElement("span");
  words.className = "label";
  slider.append(fill, words);
  let retreat: ReturnType<typeof setTimeout> | null = null;

  function show(label: string, armed: boolean, at: number) {
    const metrics = sliderMetrics(at);
    words.textContent = label;
    slider.classList.toggle("armed", armed);
    slider.classList.remove("leaving");
    slider.style.setProperty("--rise", metrics.rise.toFixed(3));
    slider.style.setProperty("--fill", metrics.fill.toFixed(3));
    if (slider.parentNode === null) document.body.appendChild(slider);
  }

  function hide() {
    if (retreat !== null) {
      clearTimeout(retreat);
      retreat = null;
    }
    slider.remove();
  }

  function settle() {
    pull = 0;
    node.style.transition = "transform 160ms ease-out";
    node.style.transform = "";
    // Back under the edge, and gone once it is out of sight. A timer rather
    // than `transitionend`: a window that asked for reduced motion has no
    // transition to end, and the capsule would stay on screen for ever.
    if (slider.parentNode !== null) {
      slider.classList.add("leaving");
      slider.style.setProperty("--rise", "0");
      slider.style.setProperty("--fill", "0");
      if (retreat !== null) clearTimeout(retreat);
      retreat = setTimeout(() => {
        retreat = null;
        slider.remove();
      }, 240);
    }
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
    if (!atBeginning(node, scrollerFor(node))) {
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
    if (!atBeginning(node, scrollerFor(node))) {
      tracking = false;
      settle();
      return;
    }
    // Keep the browser's own overscroll out of it: this pull is ours.
    event.preventDefault();
    pull = resist(dy);
    node.style.transform = `translateY(${pull.toFixed(1)}px)`;
    show(isArmed(pull) ? (opts.readyLabel ?? "Release") : opts.label, isArmed(pull), pull);
  }

  function onEnd() {
    if (!tracking) return;
    tracking = false;
    const fire = isArmed(pull);
    settle();
    if (fire) opts.onPull();
  }

  let attached = false;

  function attach(): void {
    if (attached) return;
    attached = true;
    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    tracking = false;
    pull = 0;
    hide();
    node.style.transform = "";
    node.style.transition = "";
    node.removeEventListener("touchstart", onStart);
    node.removeEventListener("touchmove", onMove);
    node.removeEventListener("touchend", onEnd);
    node.removeEventListener("touchcancel", onEnd);
  }

  if (opts.active?.() !== false) attach();

  return {
    update(next: PullOptions) {
      opts = next;
      if (next.active?.() === false) detach();
      else attach();
    },
    destroy() {
      detach();
    },
  };
}
