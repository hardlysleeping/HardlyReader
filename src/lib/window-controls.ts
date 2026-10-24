/**
 * The window's own buttons: minimize, and maximize or restore.
 *
 * A desktop window is asked for these through Tauri; a browser tab has no window
 * to minimize, so nothing here does anything there and the buttons are not drawn
 * (see `isDesktop`). Every call is guarded: a window manager that refuses one of
 * them is not an error worth a dialog, and the reader has nothing to say about it.
 */

/** True when this is the desktop build rather than a tab in a browser. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Put the window away. */
export async function minimizeWindow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await (await appWindow()).minimize();
  } catch {
    // No window manager to ask: nothing happens, nothing is said.
  }
}

/** Maximize, or put back the frame it had. Returns the state it ended in. */
export async function toggleMaximizeWindow(): Promise<boolean | null> {
  if (!isDesktop()) return null;
  try {
    const win = await appWindow();
    const maximized = await win.isMaximized();
    if (maximized) await win.unmaximize();
    else await win.maximize();
    return !maximized;
  } catch {
    return null;
  }
}

/**
 * Follow the window's maximize state, from the window rather than from the press.
 *
 * A window can be maximized by the title bar, by a double press on its edge, or
 * by the window manager itself; a button that only knows what it did last shows
 * the wrong glyph the moment one of those happens.
 */
export async function watchMaximized(onChange: (maximized: boolean) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const win = await appWindow();
    onChange(await win.isMaximized());
    return await win.onResized(async () => {
      try {
        onChange(await win.isMaximized());
      } catch {
        // The window is going away; there is no state left to report.
      }
    });
  } catch {
    return () => {};
  }
}
