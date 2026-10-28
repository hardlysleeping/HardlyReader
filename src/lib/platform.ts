/**
 * What this device can actually do, in one place.
 *
 * The settings panel used to show every option everywhere, which meant a phone
 * was offered a pane-count switch it could not use and width thresholds for
 * columns it cannot draw. Hiding an option is better than offering one that
 * does nothing — but the decision belongs in one named list, not in a scatter of
 * `if (mobile)` checks, so that the next platform limitation is also one line.
 *
 * The test is `capabilitiesFor()`, a pure function: this file only detects the
 * device and the host, and every flag is asserted in `tests/unit/platform.mjs`.
 */

/** The two shapes the app is built for. A tablet lands on whichever it behaves like. */
export type DeviceShape = "desktop" | "phone";

export interface Capabilities {
  /** A pane-count switch: needs room for more than one column to mean anything. */
  paneCount: boolean;
  /** Dragging the edge between panes: needs a pointer and more than one column. */
  paneResize: boolean;
  /** Width thresholds for when a second and third pane appear. */
  paneThresholds: boolean;
  /** Resizing the host window to fit a mode — a desktop window manager thing. */
  windowFit: boolean;
  /**
   * Fetching the original article for reader view.
   *
   * True everywhere it is offered: the Tauri window is not subject to CORS, and
   * in a browser the attempt fails and the feed's own text is shown, which is a
   * degradation rather than a missing feature. It stays listed here so that a
   * platform which forbids outbound fetches has somewhere to say so.
   */
  articleExtract: boolean;
  /**
   * Offering a post through the device's share sheet.
   *
   * A phone, and only a phone. The desktop window is the finished layout: a
   * fourth act in every row would change the shape the owner signed off, and
   * sharing is a thing done away from the desk. The flag is about the *shape*
   * rather than about the API being present, so the control does not appear and
   * vanish between two phones — the one without Web Share still falls back to
   * copying the link, which is the same press.
   */
  share: boolean;
}

/**
 * The flags for one shape and host.
 *
 * A phone gets none of the layout controls: there is one column, it is as wide
 * as the screen, and nothing can be dragged or thresholded. Article extraction
 * survives on a phone because it is the feature most useful there — reading a
 * summary-only feed on a small screen is exactly what it is for.
 */
export function capabilitiesFor(shape: DeviceShape, tauri: boolean): Capabilities {
  const desktop = shape === "desktop";
  return {
    paneCount: desktop,
    paneResize: desktop,
    paneThresholds: desktop,
    windowFit: desktop && tauri,
    articleExtract: true,
    share: !desktop,
  };
}

/**
 * Whether this is a Tauri window rather than a browser tab.
 *
 * Same test the rest of the app uses for the opener and the HTTP plugin: the
 * internals object is injected by Tauri and absent in a browser.
 */
export function isTauri(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

/**
 * The device shape, from what the hardware says rather than from the user agent.
 *
 * A coarse pointer *and* a short side is the pair that separates a phone from a
 * touchscreen laptop: the laptop has a coarse pointer sometimes, but not a
 * 400px shortest side. `layout.svelte.ts` uses the same rule, and this must stay
 * in step with it — the settings panel and the panes have to agree about what
 * device they are on.
 */
export function detectShape(): DeviceShape {
  if (typeof window === "undefined" || typeof matchMedia !== "function") return "desktop";
  const coarse = matchMedia("(pointer: coarse)").matches;
  const shortest = Math.min(window.screen?.width ?? 1440, window.screen?.height ?? 900);
  return coarse && shortest <= 500 ? "phone" : "desktop";
}

/* ---------------------------------------------------------------------------
 * iOS
 * ------------------------------------------------------------------------- */

/**
 * Whether this is an iOS device's webview.
 *
 * iOS is the one host with a native share sheet to call: the packaged app serves
 * its page from `tauri://localhost`, which is not a secure context, so Web Share
 * is absent there and the sheet has to be presented from UIKit instead. Nothing
 * else — desktop, Android, a browser tab — has that command, and asking for it
 * would only produce an error to swallow.
 *
 * The user agent is a parameter rather than read inside, so the rule is provable
 * without a phone. The `Macintosh` branch is iPadOS 13 and later, which reports
 * the desktop UA: a Mac has no touch points and an iPad has five.
 */
export function iosHost(userAgent: string, touchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && touchPoints > 1;
}

/**
 * Whether the native share sheet can be called from here.
 *
 * Both halves are required: the command exists only in the iOS build, and it is
 * reached through Tauri's IPC — a browser tab on an iPhone has Web Share instead,
 * which `src/lib/share.ts` prefers precisely because it costs no bridge.
 */
export function nativeShareAvailable(): boolean {
  if (!isTauri()) return false;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const touches = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0);
  return iosHost(ua, touches);
}
