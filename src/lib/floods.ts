/**
 * The little light that leaves when an action lands.
 *
 * One rule here: the effect is a hint that something happened where you clicked,
 * so it starts at the point of the click, travels up, and is gone in half a
 * second. Nothing in this module touches the DOM — the layer draws what these
 * functions decide, which is what makes the trimming and clamping testable.
 */

export type FloodKind = "hidden" | "revealed" | "pin" | "unpin";

export interface Point {
  x: number;
  y: number;
}

export interface Flood {
  /** Unique per emission, used as the keyed-block identity. */
  id: number;
  kind: FloodKind;
  x: number;
  y: number;
  /** 0–1: how loud this one is. Unlocking is a quieter event than hiding a feed. */
  strength: number;
}

/** Long enough to notice, short enough to feel like a consequence. */
export const FLOOD_MS = 520;

/**
 * How many can be in the air at once.
 *
 * Held down on a pin button this would otherwise queue a timer each time; three
 * is enough that a quick double-action still reads as two, and old ones are
 * dropped rather than waiting their turn.
 */
export const MAX_FLOODS = 3;

const TONES: Record<FloodKind, string> = {
  hidden: "var(--tone-hidden, #e5484d)",
  revealed: "var(--accent, #0078e0)",
  pin: "var(--tone-pinned, #0078e0)",
  unpin: "var(--accent, #0078e0)",
};

/**
 * How loud each kind is by default.
 *
 * Hiding a feed or pinning one is a small, deliberate act and gets the full
 * glow. The lock pair and a sync get nothing at all: each is answered by the bar
 * that owns the control — the shutter and a red-then-green pulse on the band,
 * a ring in the sync colour on the header. Light thrown across the window for
 * those reads as the wrong message: one says something escaped, the other says
 * the app celebrated finishing a fetch.
 */
const STRENGTHS: Record<FloodKind, number> = {
  hidden: 1,
  revealed: 1,
  pin: 1,
  unpin: 1,
};

export function floodStrength(kind: FloodKind): number {
  return STRENGTHS[kind];
}

export function floodTone(kind: FloodKind): string {
  return TONES[kind];
}

/** Where a flood starts when there was no pointer to start from: centre screen. */
export function fallbackOrigin(
  _kind: FloodKind,
  viewport: { width: number; height: number },
): Point {
  return { x: viewport.width / 2, y: viewport.height / 2 };
}

/**
 * Adds one flood, keeping the list inside the viewport and inside MAX_FLOODS.
 *
 * Off-screen origins are pulled back to the nearest edge: a click on a menu that
 * hung off the bottom of the window would otherwise animate somewhere nobody is
 * looking.
 */
export function pushFlood(
  list: readonly Flood[],
  kind: FloodKind,
  origin: Point | null,
  id: number,
  viewport: { width: number; height: number },
  strength: number = floodStrength(kind),
): Flood[] {
  // A kind with no strength has no tone either, so there is nothing to draw.
  // Dropping it here means even a stray untyped call cannot put a light on
  // screen for something that should be silent, such as locking.
  const loudness = Number.isFinite(strength) ? strength : floodStrength(kind);
  if (!Number.isFinite(loudness)) return list as Flood[];
  const raw = origin ?? fallbackOrigin(kind, viewport);
  const x = Math.min(Math.max(raw.x, 0), Math.max(viewport.width, 0));
  const y = Math.min(Math.max(raw.y, 0), Math.max(viewport.height, 0));
  const quiet = Math.min(Math.max(loudness, 0), 1);
  const next = [...list, { id, kind, x, y, strength: quiet }];
  return next.length > MAX_FLOODS ? next.slice(next.length - MAX_FLOODS) : next;
}

/** Drops one finished flood by id. */
export function retireFlood(list: readonly Flood[], id: number): Flood[] {
  return list.filter((flood) => flood.id !== id);
}
