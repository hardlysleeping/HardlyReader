/**
 * A link into the app from outside it: `hardlyreader://subscribe?...`
 *
 * The phone's share sheet is the reason this exists. iOS will not let a share
 * extension add a feed on the app's behalf — an extension is a few seconds of
 * life in a small box, and the subscribing has to happen where the accounts,
 * the backends and the queue are. So the extension finds the feed, and the feed
 * travels to the app as a URL, which is the one channel that survives being
 * re-signed by AltStore or SideStore: a URL scheme needs no entitlement.
 *
 * The shape is deliberately the Add Feed form's, not a second way to add a feed:
 *
 *     hardlyreader://subscribe?feed=<feed url>&page=<page it came from>&title=<name>
 *
 * `url` is accepted for the same reason as `page` — an older client, or a person
 * typing one, should not have to learn a second spelling — and `feed` wins over
 * it when both are present, because a specific feed is a more precise request
 * than the page it was found on.
 *
 * Everything is validated here rather than at the edge that opens the form: a
 * scheme can be opened by any app on the phone, and the only values allowed to
 * reach the field are `http(s)` links. Anything else opens the blank form, which
 * is what a press on "Add feed" does and cannot be worse than what was asked for.
 */

/** One request to add a feed, as the form would have received it. */
export interface SubscribeLink {
  /** The page the feed was found on, when the sender knew it. */
  pageUrl: string | null;
  /** The feed itself, when one was chosen; `null` means "the page". */
  feedUrl: string | null;
  /** The feed's own name, when the sender read one. */
  title: string | null;
  /**
   * What the Add Feed field starts with.
   *
   * The feed when one was chosen, otherwise the page — the form's own discovery
   * (a page URL is a valid paste) does the rest. Empty means a blank form.
   */
  seed: string;
}

/** The scheme this app answers to. */
export const DEEP_LINK_SCHEME = "hardlyreader";

/** True for the two schemes a feed can actually be fetched over. */
function isHttp(value: string | null): value is string {
  if (value === null || value === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Trim, then refuse anything that is not an http(s) link. */
function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return isHttp(trimmed) ? trimmed : null;
}

/**
 * Read a `hardlyreader://` link, or answer `null` for anything else.
 *
 * `null` is the honest answer for a malformed link: the caller has nothing to
 * show and cannot retry, and opening a blank form in response to garbage is a
 * press the reader did not make. A link with no URLs in it is *not* malformed —
 * `hardlyreader://subscribe` on its own is a legible request for the form.
 */
export function parseDeepLink(raw: string): SubscribeLink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) return null;

  // `hardlyreader://subscribe` puts "subscribe" in the host; the path is empty.
  // A sender that writes `hardlyreader:///subscribe` puts it in the path, and
  // both spellings mean the same thing.
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const route = host !== "" ? host : path;
  if (route !== "subscribe") return null;

  const params = url.searchParams;
  const feedUrl = clean(params.get("feed") ?? params.get("feedUrl"));
  const pageUrl = clean(params.get("page") ?? params.get("url"));
  const titleParam = params.get("title");
  const title = titleParam === null || titleParam.trim() === "" ? null : titleParam.trim();

  return { pageUrl, feedUrl, title, seed: feedUrl ?? pageUrl ?? "" };
}
