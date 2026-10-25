/**
 * Open a link outside the app.
 *
 * The window is not a browser: a link followed inside it would replace the
 * reader, so anything that leaves the app goes to the system instead — the
 * desktop build hands the URL to the OS, a browser tab gets a new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!/^https?:\/\//i.test(url)) return;
  if ("__TAURI_INTERNALS__" in globalThis) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      // No opener on this host: nothing else can make the link leave.
    }
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
