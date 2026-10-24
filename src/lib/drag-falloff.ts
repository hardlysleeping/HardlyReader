/**
 * A slider that gives up precision the further the mouse runs away from it.
 *
 * A native range input is 1px of track to 1px of pointer, so on a track that
 * spans 360–2000px a small nudge at the wrong moment moves the threshold by
 * twenty pixels. This makes the pointer pull the handle *less* the further it
 * gets from it: near the handle it is 1:1, at one falloff distance it is half
 * speed, and it keeps creeping instead of running away. Pushing past the end
 * of the track is still possible — it just gets slower, which is what makes it
 * feel like a rubber band rather than a clamp.
 *
 * Keyboard, touch, and the native thumb all still work: the damping only
 * applies to a mouse drag, and only until it is let go.
 */

/** How quickly the pull fades with distance, in pixels. */
export const FALLOFF = 90;
/** Below this, the pointer is barely moving the value at all. */
export const FLOOR = 0.06;

/**
 * The fraction of pointer movement that reaches the value, given how far the
 * pointer has run ahead of the handle.
 */
export function gain(lag: number, falloff = FALLOFF, floor = FLOOR): number {
  if (!(lag > 0)) return 1;
  const slowed = 1 / (1 + lag / Math.max(1, falloff));
  return Math.min(1, Math.max(floor, slowed));
}

/** Snaps a float position onto the slider's step grid. */
export function snap(position: number, step: number): number {
  if (!(step > 0)) return position;
  return Math.round(position / step) * step;
}

/** Keeps a value inside the slider's range. */
export function clampTo(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface FalloffOptions {
  /** Distance at which the pull halves. Defaults to {@link FALLOFF}. */
  falloff?: number;
  /** Lowest fraction of movement that still reaches the value. */
  floor?: number;
}

/**
 * Attaches the damped drag to a range input. The input stays a real range
 * input, so its value, ARIA and keyboard behaviour are unchanged; only the
 * mouse drag is intercepted.
 */
export function falloffDrag(node: HTMLInputElement, options: FalloffOptions = {}) {
  let opts = options;
  let active = false;
  let pointerId = -1;
  let lastX = 0;
  let travelled = 0;
  let position = 0;

  const min = () => Number(node.min === "" ? 0 : node.min);
  const max = () => Number(node.max === "" ? 100 : node.max);
  const stepOf = () => {
    const step = Number(node.step);
    return step > 0 ? step : 1;
  };

  /** Where the handle for this value sits, in viewport pixels. */
  function handleX(value: number): number {
    const box = node.getBoundingClientRect();
    if (box.width <= 0) return box.left;
    const span = max() - min();
    if (span <= 0) return box.left;
    const fraction = clampTo((value - min()) / span, 0, 1);
    return box.left + fraction * box.width;
  }

  function setValue(value: number): void {
    const next = clampTo(snap(value, stepOf()), min(), max());
    if (next === node.valueAsNumber) return;
    node.value = String(next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function onDown(event: PointerEvent): void {
    // Touch and pen keep their native behaviour; this damping is for a mouse.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    active = true;
    pointerId = event.pointerId;
    lastX = event.clientX;
    travelled = 0;
    position = node.valueAsNumber;
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer cannot be captured; the window
      // listeners below still see its moves.
    }
    // Stop the browser's own 1:1 thumb drag: ours replaces it while it lasts.
    event.preventDefault();
  }

  function onMove(event: PointerEvent): void {
    if (!active || event.pointerId !== pointerId) return;
    const delta = event.clientX - lastX;
    lastX = event.clientX;
    travelled += Math.abs(delta);
    // How far the pointer has run ahead of the handle: the further it is, the
    // less of each further pixel reaches the value.
    const lag = Math.abs(event.clientX - handleX(node.valueAsNumber));
    position = clampTo(position + delta * gain(lag, opts.falloff, opts.floor), min(), max());
    setValue(position);
  }

  function onUp(event: PointerEvent): void {
    if (!active || event.pointerId !== pointerId) return;
    active = false;
    try {
      node.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    // A press that did not travel is a click: jump to where it landed, which is
    // what a range input does, and what a drag never should.
    if (travelled < 3) {
      const box = node.getBoundingClientRect();
      if (box.width > 0) {
        const fraction = clampTo((event.clientX - box.left) / box.width, 0, 1);
        position = min() + fraction * (max() - min());
        setValue(position);
      }
    }
  }

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);

  return {
    update(next: FalloffOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    },
  };
}
