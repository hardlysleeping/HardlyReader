/**
 * Reading layout: how big the text is, how loose the lines are, whether
 * paragraphs are indented, and which way the text hangs.
 *
 * These are view preferences, not article data, so they are device-local and
 * global: one setting follows you across feeds, categories and posts. Per-post
 * layout would mean re-deciding the same thing every time you open something,
 * and the point of a size control is that it is set once.
 *
 * Nothing here touches the DOM; it maps a preference to a number and to the CSS
 * custom properties the panes read, so the arithmetic can be tested on its own.
 */

export type TextAlign = "left" | "center" | "right";
export type Leading = "tight" | "normal" | "loose";
/** Where a post's picture sits in a list row. "off" still keeps row sizing. */
export type ThumbSide = "left" | "right" | "off";

export interface ScaleSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly initial: number;
}

/** Article text. 100% is the tuned reading size; the range is a nudge, not a magnifier. */
export const TEXT_SCALE: ScaleSpec = { min: 0.85, max: 1.5, step: 0.1, initial: 1 };

/** List rows: title, preview and thumbnail grow together, so rows stay in proportion. */
export const ROW_SCALE: ScaleSpec = { min: 0.8, max: 1.4, step: 0.1, initial: 1 };

/**
 * The picture's own size, on top of the row scale.
 *
 * Separate from ROW_SCALE because wanting a bigger picture and wanting bigger
 * text are different wishes: at 200% the thumbnail is a preview, at 60% it is an
 * icon beside the headline.
 */
export const THUMB_SCALE: ScaleSpec = { min: 0.6, max: 2, step: 0.2, initial: 1 };

export const LEADINGS: Record<Leading, number> = {
  tight: 1.4,
  normal: 1.65,
  loose: 1.95,
};

export const LEADING_LABELS: Record<Leading, string> = {
  tight: "Tight",
  normal: "Normal",
  loose: "Loose",
};

export const LEADING_ORDER: readonly Leading[] = ["tight", "normal", "loose"];

export const TEXT_ALIGNS: readonly TextAlign[] = ["left", "center", "right"];

export const ALIGN_LABELS: Record<TextAlign, string> = {
  left: "Left",
  center: "Centre",
  right: "Right",
};

export const THUMB_SIDES: readonly ThumbSide[] = ["left", "right", "off"];

export const THUMB_SIDE_LABELS: Record<ThumbSide, string> = {
  left: "Left",
  right: "Right",
  off: "Off",
};

export const THUMB_SIDE_INITIAL: ThumbSide = "right";

/**
 * A lead picture at the top of the article.
 *
 * On by default: a feed that bothered to send an image is usually telling you
 * something about the post. It is suppressed per-article when the body already
 * opens with that same image, so the reader does not show it twice.
 */
export const ARTICLE_IMAGE_INITIAL = true;

export const ALIGN_INITIAL: TextAlign = "left";
export const LEADING_INITIAL: Leading = "normal";
export const INDENT_INITIAL = false;

/** First-line indent applied when the toggle is on, relative to the text size. */
export const PARAGRAPH_INDENT = "1.2em";

export function isTextAlign(value: unknown): value is TextAlign {
  return typeof value === "string" && (TEXT_ALIGNS as readonly string[]).includes(value);
}

export function isLeading(value: unknown): value is Leading {
  return typeof value === "string" && (LEADING_ORDER as readonly string[]).includes(value);
}

export function isThumbSide(value: unknown): value is ThumbSide {
  return typeof value === "string" && (THUMB_SIDES as readonly string[]).includes(value);
}

/**
 * Two decimal places, because 0.85 + 0.1 is 0.9500000000000001 and that number
 * would be stored, displayed and compared for the rest of the session.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A stored or typed value, brought inside the scale and rounded to 1%. */
export function clampScale(value: unknown, spec: ScaleSpec): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return spec.initial;
  return round(Math.min(spec.max, Math.max(spec.min, value)));
}

/**
 * One press of a bigger/smaller button.
 *
 * Steps are taken from the current value rather than from a fixed ladder, so a
 * value that came from elsewhere (an older build, or a hand-edited preference)
 * still walks sensibly instead of snapping.
 */
export function stepScale(current: number, direction: 1 | -1, spec: ScaleSpec): number {
  const start = clampScale(current, spec);
  return clampScale(round(start + direction * spec.step), spec);
}

export function atScaleLimit(value: number, direction: 1 | -1, spec: ScaleSpec): boolean {
  const clamped = clampScale(value, spec);
  return direction === 1 ? clamped >= spec.max : clamped <= spec.min;
}

/** "100%", for a readout next to the buttons. */
export function scalePercent(value: number, spec: ScaleSpec = TEXT_SCALE): string {
  return `${Math.round(clampScale(value, spec) * 100)}%`;
}

export interface ReadingLayout {
  textScale: number;
  rowScale: number;
  leading: Leading;
  indent: boolean;
  align: TextAlign;
  thumbScale: number;
  thumbSide: ThumbSide;
  articleImage: boolean;
}

export const LAYOUT_INITIAL: ReadingLayout = {
  textScale: TEXT_SCALE.initial,
  rowScale: ROW_SCALE.initial,
  leading: LEADING_INITIAL,
  indent: INDENT_INITIAL,
  align: ALIGN_INITIAL,
  thumbScale: THUMB_SCALE.initial,
  thumbSide: THUMB_SIDE_INITIAL,
  articleImage: ARTICLE_IMAGE_INITIAL,
};

export function isDefaultLayout(layout: ReadingLayout): boolean {
  return (
    clampScale(layout.textScale, TEXT_SCALE) === TEXT_SCALE.initial &&
    clampScale(layout.rowScale, ROW_SCALE) === ROW_SCALE.initial &&
    layout.leading === LEADING_INITIAL &&
    layout.indent === INDENT_INITIAL &&
    layout.align === ALIGN_INITIAL &&
    clampScale(layout.thumbScale, THUMB_SCALE) === THUMB_SCALE.initial &&
    layout.articleImage === ARTICLE_IMAGE_INITIAL
  );
}

/**
 * The CSS custom properties the panes inherit.
 *
 * One place sets them, on the element that contains every pane, so the article,
 * the list and the header all read the same numbers without each asking the
 * preference store.
 */
export function readingVars(layout: Partial<ReadingLayout>): Record<string, string> {
  return {
    "--read-scale": String(clampScale(layout.textScale, TEXT_SCALE)),
    "--read-leading": String(LEADINGS[layout.leading ?? LEADING_INITIAL] ?? LEADINGS[LEADING_INITIAL]),
    "--read-indent": layout.indent ? PARAGRAPH_INDENT : "0",
    "--read-align": isTextAlign(layout.align) ? layout.align : ALIGN_INITIAL,
    "--row-scale": String(clampScale(layout.rowScale, ROW_SCALE)),
    "--thumb-scale": String(clampScale(layout.thumbScale, THUMB_SCALE)),
  };
}

/** `style` attribute text from the same map, for plain-DOM callers. */
export function readingStyle(layout: ReadingLayout): string {
  return Object.entries(readingVars(layout))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}
