/**
 * Ask the desktop window to become a width.
 *
 * Only the Tauri build can do this: a browser tab cannot resize itself, so the
 * call reports failure and the caller falls back to switching the mode alone —
 * the window keeps its size and the layout switch says it is squeezed. Height
 * is read from the window rather than passed in, because the reader owns that
 * and only the width belongs to the layout.
 */
export async function fitWindowTo(width: number): Promise<boolean> {
  if (typeof window === "undefined" || !Number.isFinite(width) || width <= 0) return false;
  if (!("__TAURI_INTERNALS__" in window)) return false;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const height = window.innerHeight;
    await getCurrentWindow().setSize(new LogicalSize(Math.round(width), Math.round(height)));
    return true;
  } catch {
    return false;
  }
}
