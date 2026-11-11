/**
 * The width the window may honestly become, and the ask that makes it so.
 *
 * These two are separate because they can disagree with each other for a good
 * reason: the monitor says what fits on the screen, and a mode press says what
 * the layout wants. The caller caps the second with the first.
 */

/**
 * The widest a window may honestly become on the screen it is on.
 *
 * A native window asks its monitor, because "the screen" is whichever display
 * the window was last on and a maximised 4K panel is not the laptop lid it came
 * from. A browser tab has no such question and uses the screen it can see. When
 * neither answers, the caller gets `null` and applies no cap rather than a guess.
 */
export async function screenWidth(): Promise<number | null> {
  if (typeof window === "undefined") return null;
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const monitor = await currentMonitor();
      if (monitor !== null) {
        const factor = monitor.scaleFactor || 1;
        const width = monitor.size.width / factor;
        if (Number.isFinite(width) && width > 0) return Math.round(width);
      }
    } catch {
      // Fall through to the browser's answer.
    }
  }
  const available = window.screen?.availWidth;
  return typeof available === "number" && available > 0 ? available : null;
}

/**
 * Whether this shell can resize its own window at all.
 *
 * A browser tab and a phone cannot, and the difference matters *before* a press
 * is drawn, not after it fails: a press that asks for a width it will never get
 * draws its first frames at that width, then the refusal re-settles the columns
 * and the slide ends somewhere else. Ask here and a shell that cannot resize
 * draws the press from the frame it is actually in, once.
 */
export function canFitWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask the desktop window to become a width, and say whether it did.
 *
 * Only the Tauri build can do this: a browser tab cannot resize itself, so the
 * call reports failure and the caller falls back to switching the mode alone —
 * the window keeps its size and the layout switch says it is squeezed. Height
 * is read from the window rather than passed in, because the reader owns that
 * and only the width belongs to the layout — unless a caller owns the height
 * too, as fitting a picture to the screen does.
 */
export async function fitWindowTo(width: number, height?: number): Promise<boolean> {
  if (typeof window === "undefined" || !Number.isFinite(width) || width <= 0) return false;
  if (!("__TAURI_INTERNALS__" in window)) return false;
  const tall = Number.isFinite(height) && (height ?? 0) > 0 ? Math.round(height as number) : window.innerHeight;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(Math.round(width), tall));
    return true;
  } catch {
    return false;
  }
}

/**
 * The screen the window is on, in logical pixels, or `null` when nothing answers.
 *
 * The height matters as much as the width here: fitting a comic to the window
 * means fitting it to the screen, and a picture is only "whole" if its height
 * has somewhere to go.
 */
export async function screenSize(): Promise<{ width: number; height: number } | null> {
  if (typeof window === "undefined") return null;
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const monitor = await currentMonitor();
      if (monitor !== null) {
        const factor = monitor.scaleFactor || 1;
        const width = monitor.size.width / factor;
        const height = monitor.size.height / factor;
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          return { width: Math.round(width), height: Math.round(height) };
        }
      }
    } catch {
      // Fall through to the browser's answer.
    }
  }
  const width = window.screen?.availWidth;
  const height = window.screen?.availHeight;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

/**
 * What the window should become to show one card whole — and no more than that.
 *
 * **The fit is minimal.** The pane keeps the width it has and the window only
 * grows in height, by the amount the card is short of. Widening is never the
 * answer: a card's picture is drawn across the pane, so a wider pane makes the
 * picture *taller*, which is the opposite of fitting it. Growing to the screen's
 * full height on every press — what this used to ask for — resized a window for
 * a comic that already fitted, and the reader got a window he did not ask for.
 *
 * The picture keeps its own shape (`height = paneWidth × share ÷ natural`), the
 * card keeps its furniture (`chrome`) and its two slivers (`peek`), so the
 * neighbours still show above and below. Never shorter than `windowHeight`: a
 * fit that shrank the window is a fit nobody asked for, and the shell clamps
 * some asks anyway. Returns `null` when nothing would move, so a press on a card
 * that already fits does nothing at all.
 */
export interface CardFitInput {
  /** The pane the cards are drawn in, right now. */
  paneWidth: number;
  /** The share of the pane one picture is drawn across (panels share one zoom). */
  share: number;
  /** The picture's own shape: width ÷ height. */
  natural: number;
  /** Everything in the window that is not the picture: the card's text, header. */
  chrome: number;
  /** The window as it stands, and the screen it is on, in logical pixels. */
  windowHeight: number;
  screenHeight: number;
  /** The sliver kept above and below the card, as the sheet fades by. */
  peek: number;
  /** The shortest window the app may be asked for. */
  floor: number;
}

export interface CardFit {
  paneWidth: number;
  height: number;
}

export function fitCardToWindow(input: CardFitInput): CardFit | null {
  const { paneWidth, share, natural, chrome, windowHeight, screenHeight, peek, floor } = input;
  if (!Number.isFinite(natural) || natural <= 0) return null;
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) return null;
  const pictureH = (paneWidth * share) / natural;
  const wanted = chrome + pictureH + 2 * peek;
  // The screen is the ceiling, the shell's own floor is the floor, and the
  // window as it stands is the third bound: a fit only ever grows. A window
  // already taller than the screen is left alone rather than clamped down to it.
  const ceiling = Math.max(floor, screenHeight);
  const height = Math.round(Math.max(windowHeight, Math.min(ceiling, Math.max(wanted, floor))));
  if (Math.abs(height - windowHeight) < 1) return null;
  return { paneWidth: Math.round(paneWidth), height };
}
