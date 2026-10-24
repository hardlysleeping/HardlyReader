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
