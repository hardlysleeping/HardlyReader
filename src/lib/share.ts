/**
 * Sharing one post: the device's own sheet when there is one, a copy when there
 * is not.
 *
 * On iOS the Web Share API *is* the share sheet — `navigator.share()` hands the
 * title and the link to `UIActivityViewController`, and the reader gets the same
 * list of apps every other app on the phone offers. Two rules come with it and
 * both are easy to get wrong:
 *
 * 1. It needs a **secure context** and a **user gesture**. The handle is called
 *    straight out of the button's own click, with nothing awaited before it, so
 *    the activation is still live when the sheet opens.
 * 2. A dismissed sheet rejects with `AbortError`. That is the reader saying no,
 *    not a failure: turning around and copying the link to the clipboard after
 *    someone cancelled would leave something they explicitly refused sitting on
 *    the pasteboard.
 *
 * The Tauri window complicates both. It serves the app from a custom scheme
 * (`tauri://localhost`), which WebKit does not count as potentially trustworthy,
 * so `navigator.share` and the async `navigator.clipboard` can be missing there
 * even on a phone. The copy fallback therefore has a second route —
 * `document.execCommand("copy")`, which predates the secure-context rule — so a
 * link can still be put on the clipboard inside the app. Nothing here invents a
 * sheet of its own: an in-app menu dressed as one would be a drawing, and the
 * point of this file is the real sheet, or an honest copy.
 */

import { nativeShareAvailable } from "./platform";

/** What an article says about itself, in the fields a share can carry. */
export interface ShareTarget {
  /** The article's headline; may be empty on a feed that sends none. */
  title: string;
  /** Where the post lives — already checked as an external http(s) link. */
  url: string;
  /**
   * The lead image's own address, when the feed declared one.
   *
   * Only the native sheet uses it: `navigator.share` with a URL is a link, and
   * attaching a file to a Web Share call is a different contract (a `File`, a
   * `canShare` check, a permission prompt on some browsers) that this press does
   * not need. The phone app can hand UIKit the picture directly.
   */
  image?: string;
}

/**
 * What came of one press.
 *
 * `shared` handed the post to the system, `cancelled` means the sheet was
 * dismissed without sharing, `copied` is the fallback landing, and `failed` is
 * the copy having nowhere to go — the one case with something to say out loud.
 */
export type ShareOutcome = "shared" | "cancelled" | "copied" | "failed";

/** The two capabilities this file reaches for, injected so the chain is testable. */
export interface ShareHost {
  /**
   * The app's own sheet — `UIActivityViewController` through the `share_sheet`
   * command. `null` everywhere else, including the iOS browser tab, which has
   * Web Share and does not need a bridge.
   *
   * It resolves once the sheet is on its way rather than when it closes, so it
   * says nothing about what the reader picked. Every other outcome — a system
   * that cannot present it, a link UIKit refuses — rejects, and the copy below
   * is what happens then.
   */
  native: ((data: SharePayload) => Promise<void>) | null;
  /** `navigator.share`, or `null` where the context has none. */
  share: ((data: SharePayload) => Promise<void>) | null;
  /** Puts text on the clipboard; `false` when it could not. */
  copy: (text: string) => Promise<boolean>;
}

/** The shape `navigator.share` takes. A URL is the one member always sent. */
export interface SharePayload {
  title?: string;
  url: string;
  /** The lead image, for the native sheet. Never sent to `navigator.share`. */
  image?: string;
}

/**
 * The payload for one target.
 *
 * `title` is omitted rather than sent empty: an empty string is a title to the
 * sheet — a blank subject line in Mail — while a missing one lets the receiving
 * app read the page and fill in its own.
 */
export function sharePayload(target: ShareTarget): SharePayload {
  const title = target.title.trim();
  const image = target.image?.trim() ?? "";
  const payload: SharePayload = title === "" ? { url: target.url } : { title, url: target.url };
  // Blank is absent: a sheet with an empty picture item is a placeholder image.
  if (image !== "") payload.image = image;
  return payload;
}

/**
 * Whether a rejected share was the reader dismissing the sheet.
 *
 * WebKit and Chromium both answer a cancelled sheet with `AbortError`; every
 * other rejection (no transient activation, a policy that forbids sharing, a
 * webview with no share target at all) is a reason to fall back to the copy.
 */
export function isDismissal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Share one article: the system sheet if this host has one, the link on the
 * clipboard otherwise.
 *
 * The ordering is the whole design, and there are two shapes of "the sheet":
 *
 * - **In the app on iOS**, Web Share is not there at all — `tauri://localhost`
 *   is not a secure context — so the sheet is presented by UIKit through the
 *   `share_sheet` command, and that is tried first.
 * - **Anywhere else**, `navigator.share` is the sheet, and it is not awaited
 *   through anything that could lose the click's activation.
 *
 * The two are exclusive rather than chained: on the one host that has the native
 * command, an `await` on the IPC round trip has already spent the activation, so
 * a Web Share call afterwards could only fail. A bridge that refuses falls to
 * the copy — the same landing the web path uses — and a cancellation, where the
 * platform reports one, ends the attempt instead of continuing into it.
 */
export async function shareArticle(
  target: ShareTarget,
  host: ShareHost = shareHost(),
): Promise<ShareOutcome> {
  if (target.url.trim() === "") return "failed";
  const payload = sharePayload(target);

  if (host.native !== null) {
    try {
      await host.native(payload);
      return "shared";
    } catch {
      // No window to present on, or a link UIKit would not take: copy instead.
      return (await host.copy(target.url)) ? "copied" : "failed";
    }
  }

  if (host.share !== null) {
    try {
      await host.share(payload);
      return "shared";
    } catch (error) {
      if (isDismissal(error)) return "cancelled";
      // A sheet that refused is exactly the case the fallback exists for.
    }
  }

  return (await host.copy(target.url)) ? "copied" : "failed";
}

/* ---------------------------------------------------------------------------
 * Clipboard
 * ------------------------------------------------------------------------- */

/**
 * How the clipboard is reached, injected so both routes can be exercised.
 *
 * `secure` gates the async API rather than being read inside it: a webview can
 * expose `navigator.clipboard` on a page it does not consider secure, and the
 * call then rejects. `legacy` is the route that has no such requirement.
 */
export interface CopyHost {
  secure: boolean;
  write: ((text: string) => Promise<void>) | null;
  legacy: (text: string) => boolean;
}

/**
 * Copy text, by the best route this page allows.
 *
 * The legacy route runs **before** any await when the async one is unavailable,
 * which keeps it inside the click's own task — `execCommand` is checked against
 * the user activation the same way the sheet is.
 */
export async function copyText(text: string, host: CopyHost = copyHost()): Promise<boolean> {
  if (host.secure && host.write !== null) {
    try {
      await host.write(text);
      return true;
    } catch {
      // Exposed and refused: the webview's own answer, so try the other route.
    }
  }
  return host.legacy(text);
}

/** The host this page actually offers. Read at call time — a webview may differ per build. */
export function copyHost(): CopyHost {
  const win = typeof window === "undefined" ? null : window;
  const secure = win?.isSecureContext === true;
  const clipboard =
    typeof navigator === "undefined" ? undefined : (navigator as Navigator).clipboard;
  const write =
    typeof clipboard?.writeText === "function"
      ? (text: string) => clipboard.writeText(text)
      : null;
  return { secure, write, legacy: legacyCopy };
}

/**
 * Copy through a hidden, selected textarea.
 *
 * `document.execCommand("copy")` is deprecated and still the only route that
 * works inside a webview whose custom scheme is not a secure context — which is
 * every Tauri window on a phone. The field is off-screen but selectable, and it
 * is removed in `finally` so a refusal cannot leave a stray node behind.
 */
export function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/** The host this context actually offers. */
export function shareHost(): ShareHost {
  const share =
    typeof navigator !== "undefined" && typeof navigator.share === "function"
      ? (data: SharePayload) =>
          // Only the two members Web Share defines: an image is the native
          // sheet's business, and a stray field is a payload the platform may
          // refuse rather than ignore.
          navigator.share({ ...(data.title ? { title: data.title } : {}), url: data.url })
      : null;
  return { native: nativeShare(), share, copy: (text) => copyText(text) };
}

/**
 * The app's own sheet, when this build has it.
 *
 * The import is deferred and lives inside the function: the web build never
 * loads Tauri's IPC module, and a desktop press never even reaches here. The
 * command name matches `share_sheet` in `src-tauri/src/share.rs`; the argument
 * keys are camel-cased by Tauri's own deserializer.
 */
export function nativeShare(): ((data: SharePayload) => Promise<void>) | null {
  if (!nativeShareAvailable()) return null;
  return async (data) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("share_sheet", {
      title: data.title ?? "",
      url: data.url,
      image: data.image ?? null,
    });
  };
}
