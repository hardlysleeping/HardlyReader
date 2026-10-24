/**
 * Action feedback: the short burst of light that says "that landed".
 *
 * Deliberately tiny state. A flood is added, its CSS animation ends, and the
 * layer removes it — no timers per frame, no per-row bookkeeping, and nothing
 * that survives the animation.
 *
 * `prefers-reduced-motion` turns them off at the source rather than animating
 * them for a fraction of a millisecond: someone who asked for less motion is not
 * asking for a flicker instead.
 */

import { pushFlood, retireFlood, type Flood, type FloodKind, type Point } from "../lib/floods";

function reducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function viewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

class FloodState {
  floods = $state<Flood[]>([]);

  #sequence = 0;

  /**
   * Emits one flood. `origin` is the click that caused it; without one the kind
   * picks its own anchor (a sync arrives top right, where its control is).
   */
  emit(kind: FloodKind, origin: Point | null = null): void {
    if (reducedMotion()) return;
    this.#sequence += 1;
    this.floods = pushFlood(this.floods, kind, origin, this.#sequence, viewport());
  }

  retire(id: number): void {
    this.floods = retireFlood(this.floods, id);
  }

  /** For tests and for the panic path: nothing in the air. */
  clear(): void {
    this.floods = [];
  }
}

export const floods = new FloodState();
