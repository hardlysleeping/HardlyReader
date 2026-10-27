/**
 * The arithmetic behind tapping a picture open on a phone.
 *
 * A tapped picture gets its own layer over the article, and on that layer two
 * fingers mean what they always mean: pinch to scale, drag to pan, double-tap to
 * jump in and out. All of that is geometry, so it lives here rather than inside
 * the pane — the component owns the pointers and the frame, this file owns the
 * numbers, and the unit suite checks the numbers without a browser.
 *
 * One rule shapes everything: **the picture never leaves the frame.** Panning is
 * clamped so an edge cannot be dragged past the edge of the window, and at scale
 * 1 the picture is centred with nothing to drag — a photo you can fling into the
 * void reads as broken, not as a viewer.
 */

/** Where the picture sits: scale, then the offset applied after scaling. */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

/** A point in the layer's own coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** The box the picture lives in, in CSS pixels. */
export interface Frame {
  width: number;
  height: number;
}

/** The size the picture is drawn at before any zoom, in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

/** What a double-tap zooms to, and what a second one returns from. */
export const DOUBLE_TAP_SCALE = 2.5;

export function restZoom(): Zoom {
  return { scale: MIN_SCALE, x: 0, y: 0 };
}

export function span(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * How far the picture may be dragged at a given scale.
 *
 * Zero on an axis the picture does not overflow, which is what keeps a
 * landscape photo from sliding up and down with nothing above or below it.
 */
export function panRoom(fit: Size, frame: Frame, scale: number): { x: number; y: number } {
  return {
    x: Math.max(0, (fit.width * scale - frame.width) / 2),
    y: Math.max(0, (fit.height * scale - frame.height) / 2),
  };
}

/** Pulls an offset back inside the frame. */
export function clampPan(zoom: Zoom, fit: Size, frame: Frame): Zoom {
  const room = panRoom(fit, frame, zoom.scale);
  return {
    scale: zoom.scale,
    x: clamp(zoom.x, -room.x, room.x),
    y: clamp(zoom.y, -room.y, room.y),
  };
}

/**
 * Two fingers moving from `fromSpan` to `toSpan`, around `centre`.
 *
 * The point under the fingers stays under the fingers: the scale is the ratio of
 * the two spans, and the offset grows with the distance between the centre and
 * the layer's middle, scaled by how much the picture grew.
 */
export function pinch(
  start: Zoom,
  startSpan: number,
  toSpan: number,
  centre: Point,
  frame: Frame,
  fit: Size,
): Zoom {
  if (startSpan <= 0) return start;
  const scale = clamp((start.scale * toSpan) / startSpan, MIN_SCALE, MAX_SCALE);
  const grown = scale / start.scale;
  // Sign: the picture moves OPPOSITE to the finger's offset from the middle, so
  // the pixel under the fingers stays under them as it grows.
  const dx = (centre.x - frame.width / 2) * (1 - grown);
  const dy = (centre.y - frame.height / 2) * (1 - grown);
  return clampPan({ scale, x: start.x + dx, y: start.y + dy }, fit, frame);
}

/** One finger dragging at the current scale. */
export function drag(start: Zoom, by: Point, fit: Size, frame: Frame): Zoom {
  if (start.scale <= MIN_SCALE) return clampPan({ ...start, x: 0, y: 0 }, fit, frame);
  return clampPan({ scale: start.scale, x: start.x + by.x, y: start.y + by.y }, fit, frame);
}

/**
 * A double-tap: in to `DOUBLE_TAP_SCALE` centred where the finger landed, back to
 * rest if it is already zoomed in.
 */
export function doubleTap(current: Zoom, at: Point, frame: Frame, fit: Size): Zoom {
  if (current.scale > MIN_SCALE + 0.01) return restZoom();
  const scale = DOUBLE_TAP_SCALE;
  const dx = (at.x - frame.width / 2) * (1 - scale);
  const dy = (at.y - frame.height / 2) * (1 - scale);
  return clampPan({ scale, x: dx, y: dy }, fit, frame);
}

/**
 * The CSS transform for a zoom, plus the size to draw the picture at.
 *
 * The picture is drawn fit-to-frame and then scaled, so at rest it fills the
 * frame without ever being upscaled past the file's own pixels for a small image.
 */
export function transformOf(zoom: Zoom): string {
  return `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

/** True while the layer is still showing the picture at rest. */
export function atRest(zoom: Zoom): boolean {
  return zoom.scale <= MIN_SCALE + 0.01;
}

/**
 * The size to draw a picture at so it fits the frame without being upscaled.
 *
 * A small file stays its own size — blowing a 300px image up to the width of a
 * phone screen is the blur the article view already avoids, and the reader came
 * here to see the pixels, not a smoothed guess at them.
 */
export function fitInto(natural: Size, frame: Frame): Size {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
  if (frame.width <= 0 || frame.height <= 0) return natural;
  const ratio = Math.min(frame.width / natural.width, frame.height / natural.height, 1);
  return { width: natural.width * ratio, height: natural.height * ratio };
}
