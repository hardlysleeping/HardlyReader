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
 *
 * `fill` is the phone's rule: a picture that is already most of the way across
 * the frame is drawn all the way across it. A 600px photograph in a 390px phone
 * column has 40px of margin to lose nothing by, and the sliver it leaves reads as
 * a mistake rather than as a choice. Pictures much smaller than the frame are
 * left alone — a 64px icon blown up to the width of the screen is not a bigger
 * icon, it is a blur, and the same rule that stops the fit at the file's own
 * width is what stops this.
 */

/**
 * How much of the frame a file has to be before filling it is an improvement.
 *
 * Half: a picture at half the frame's width is a picture that was drawn for a
 * column, and the column is what it gets. Below that it is an inline mark.
 */
export const FILL_FLOOR = 0.5;

/** A width and a height, in either CSS pixels or natural pixels. */
export interface Box {
  width: number;
  height: number;
}

/** The drawn width in CSS pixels, or null when the picture has not loaded. */
export function fittedWidth(natural: Box, frame: Box, scale = 1, fill = false): number | null {
  if (!(natural.width > 0) || !(natural.height > 0)) return null;
  // A frame that has not been measured yet (0) does not limit anything: the
  // pane sets these from its own box, and it reports 0 before its first layout.
  const byWidth = frame.width > 0 ? frame.width / natural.width : Number.POSITIVE_INFINITY;
  const byHeight = frame.height > 0 ? frame.height / natural.height : Number.POSITIVE_INFINITY;
  const fit = Math.min(1, byWidth, byHeight);
  const factor = fit * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const drawn = Math.max(1, Math.round(natural.width * factor));
  if (!fill || !(frame.width > 0)) return drawn;
  // Only a picture that was already close to the frame is widened to it, and the
  // widened one still never runs past the frame: this adds margin, never removes
  // the fit.
  if (natural.width < frame.width * FILL_FLOOR) return drawn;
  // A reader who asked for smaller pictures asked for smaller pictures.
  const wanted = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (wanted < 1) return drawn;
  return Math.round(frame.width);
}
