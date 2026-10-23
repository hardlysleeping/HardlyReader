/**
 * Reading layout: how big the text is, how loose the lines are, and which way
 * the text hangs.
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
  readonly initial: number;
}

/**
 * How far one press moves a size, in percent.
 *
 * Shared by text, rows and pictures rather than fixed per scale: a fifth of a
 * picture per press was two presses away from absurd, and someone who wants fine
 * control wants it everywhere, not on whichever control happened to be tuned
 * that way.
 */
export const STEP_PERCENTS = [1, 5, 10] as const;
export type StepPercent = (typeof STEP_PERCENTS)[number];
export const STEP_INITIAL: StepPercent = 5;

export function isStepPercent(value: unknown): value is StepPercent {
  return typeof value === "number" && (STEP_PERCENTS as readonly number[]).includes(value);
}

/** Article text. 100% is the tuned reading size; the range is a nudge, not a magnifier. */
export const TEXT_SCALE: ScaleSpec = { min: 0.85, max: 1.5, initial: 1 };

/** List rows: title, preview and thumbnail grow together, so rows stay in proportion. */
export const ROW_SCALE: ScaleSpec = { min: 0.8, max: 1.4, initial: 1 };

/**
 * The picture's own size, on top of the row scale.
 *
 * Separate from ROW_SCALE because wanting a bigger picture and wanting bigger
 * text are different wishes: at 200% the thumbnail is a preview, at 60% it is an
 * icon beside the headline.
 */
export const THUMB_SCALE: ScaleSpec = { min: 0.6, max: 2, initial: 1 };

/**
 * The picture's base size, before row and picture scaling.
 *
 * Exported so the panel can say "58px wide" using the same number the stylesheet
 * multiplies — a readout computed from a different number would drift the first
 * time either changed.
 */
export const THUMB_BASE_PX = 48;

/** What the next row's picture will measure, for the panel's readout. */
export function thumbWidthPx(rowScale: number, thumbScale: number): number {
  return Math.round(THUMB_BASE_PX * clampScale(rowScale, ROW_SCALE) * clampScale(thumbScale, THUMB_SCALE));
}

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
export function stepScale(
  current: number,
  direction: 1 | -1,
  spec: ScaleSpec,
  stepPercent: StepPercent = STEP_INITIAL,
): number {
  const start = clampScale(current, spec);
  return clampScale(round(start + (direction * stepPercent) / 100), spec);
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
  align: TextAlign;
  thumbScale: number;
  thumbSide: ThumbSide;
  articleImage: boolean;
  /** Percent per press, shared by every size control. */
  stepPercent: StepPercent;
}

export const LAYOUT_INITIAL: ReadingLayout = {
  textScale: TEXT_SCALE.initial,
  rowScale: ROW_SCALE.initial,
  leading: LEADING_INITIAL,
  align: ALIGN_INITIAL,
  thumbScale: THUMB_SCALE.initial,
  thumbSide: THUMB_SIDE_INITIAL,
  articleImage: ARTICLE_IMAGE_INITIAL,
  stepPercent: STEP_INITIAL,
};

export function isDefaultLayout(layout: ReadingLayout): boolean {
  return (
    clampScale(layout.textScale, TEXT_SCALE) === TEXT_SCALE.initial &&
    clampScale(layout.rowScale, ROW_SCALE) === ROW_SCALE.initial &&
    layout.leading === LEADING_INITIAL &&
    layout.align === ALIGN_INITIAL &&
    clampScale(layout.thumbScale, THUMB_SCALE) === THUMB_SCALE.initial &&
    layout.articleImage === ARTICLE_IMAGE_INITIAL &&
    (layout.stepPercent ?? STEP_INITIAL) === STEP_INITIAL
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
