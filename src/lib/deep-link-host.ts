/**
 * Listening for `hardlyreader://subscribe...` and handing it to the add form.
 *
 * The parsing is `lib/deep-link`'s; this is only the wire. Two things it has to
 * get right:
 *
 * - **A link that launched the app** arrives before anyone is listening. The
 *   plugin answers `getCurrent()` for exactly that case, and without it a cold
 *   launch from the share sheet would do nothing and look broken.
 * - **A link that arrives while the app is open** comes through `onOpenUrl`, and
 *   more than one URL can be in the batch.
 *
 * Every failure is silence. A deep link is being handled on a platform that may
 * not have the plugin (the browser, the desktop build) and inside a webview that
 * may be starting up; a missing plugin is not a reason to break the app the
 * reader is looking at.
 */
import { isTauri } from "./platform";
import { parseDeepLink, type SubscribeLink } from "./deep-link";

/** Hand every recognised link to `open`, for as long as this session lives. */
export async function installDeepLinks(open: (link: SubscribeLink) => void): Promise<() => void> {
  if (!isTauri()) return () => {};

  let unlisten: (() => void) | null = null;
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");

    const handle = (urls: string[] | null): void => {
      for (const raw of urls ?? []) {
        const link = parseDeepLink(raw);
        if (link !== null) open(link);
      }
    };

    unlisten = await onOpenUrl((urls) => handle(urls));

    // The launch URL: `onOpenUrl` cannot have heard it, because the webview did
    // not exist yet.
    try {
      handle(await getCurrent());
    } catch {
      /* no launch link, or a platform without one */
    }
  } catch {
    return () => {};
  }

  return () => {
    unlisten?.();
  };
}
