/**
 * How much of the frame a picture gets in the article pane.
 *
 * Three limits decide the drawn width, and the tightest one wins:
 *
 *   - the frame's width, because a picture that runs off the side is cut off;
 *   - the frame's height, because a page you have to scroll to find the end of
 *     is not a page you can read at a glance;
 *   - the file's own width, at 100%. A 600px comic drawn 1400px wide is not a
 *     bigger comic, it is a blurry one; the automatic fit stops at the
 *     resolution the file actually has.
 *
 * `scale` multiplies the result, so the reader can ask for smaller than the fit
 * (words first) or larger than it (a blur they chose). It is one number in the
 * reading preferences, so it holds across articles and across runs.
 */

/** A width and a height, in either CSS pixels or natural pixels. */
export interface Box {
  width: number;
  height: number;
}

/** The drawn width in CSS pixels, or null when the picture has not loaded. */
export function fittedWidth(natural: Box, frame: Box, scale = 1): number | null {
  if (!(natural.width > 0) || !(natural.height > 0)) return null;
  // A frame that has not been measured yet (0) does not limit anything: the
  // pane sets these from its own box, and it reports 0 before its first layout.
  const byWidth = frame.width > 0 ? frame.width / natural.width : Number.POSITIVE_INFINITY;
  const byHeight = frame.height > 0 ? frame.height / natural.height : Number.POSITIVE_INFINITY;
  const fit = Math.min(1, byWidth, byHeight);
  const factor = fit * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return Math.max(1, Math.round(natural.width * factor));
}
