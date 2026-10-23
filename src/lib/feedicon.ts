/**
 * Feed icons.
 *
 * FreshRSS builds icon URLs from whatever host its web UI was reached on, so a
 * server behind a proxy or a tailnet hands out URLs pointing somewhere this
 * client cannot route (`localhost:18080`, a container name, an internal port).
 * Rendering those gives broken images, so the decision is kept here — pure and
 * testable — instead of being scattered through markup.
 *
 * The second job is the fallback: every feed gets a deterministic letter and
 * hue, so a feed without an icon still looks like a feed rather than a blank.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** Inline images above this size are dropped: they bloat the DOM and are usually logos. */
const MAX_DATA_URI = 200_000;

/**
 * Resolves a subscription's `iconUrl` into something this client can load, or
 * `undefined` when there is nothing safe to render.
 */
export function feedIconSrc(raw: string | undefined, serverUrl: string): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  if (trimmed.startsWith("data:")) {
    return trimmed.length > MAX_DATA_URI ? undefined : trimmed;
  }

  let icon: URL;
  try {
    icon = new URL(trimmed, serverUrl);
  } catch {
    return undefined;
  }
  if (icon.protocol !== "http:" && icon.protocol !== "https:") {
    return undefined;
  }

  // Icons must come from the server we are actually authenticated against. A
  // loopback host in the icon URL means FreshRSS was configured by someone
  // browsing it locally, so borrow only the origin we know works.
  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    return undefined;
  }
  if (LOCAL_HOSTS.has(icon.hostname) && !LOCAL_HOSTS.has(server.hostname)) {
    icon.protocol = server.protocol;
    icon.host = server.host;
  }

  return icon.toString();
}

/**
 * First letter or digit of a feed title, for the fallback tile. Titles like
 * "the verge" capitalise; titles with no letters or digits get a neutral mark.
 */
export function feedInitial(title: string): string {
  const match = /[\p{L}\p{N}]/u.exec(title.trim());
  return match === null ? "?" : match[0].toUpperCase();
}

/**
 * Stable hue for the fallback tile, so a feed keeps the same colour across
 * sessions instead of flickering between palettes on every render.
 */
export function feedHue(title: string): number {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  return hash;
}
