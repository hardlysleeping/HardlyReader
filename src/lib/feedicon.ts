/**
 * Feed icons.
 *
 * Where a row's mark comes from is a choice, not an assumption, so it sits
 * behind a provider:
 *
 *   `freshrss`     the subscription's own `iconUrl`, which FreshRSS serves out
 *                  of its icon cache. FreshRSS builds that URL from whatever
 *                  host its web UI was loaded on — `localhost:18080`, a
 *                  container name, an internal port — none of which this
 *                  client can route, and an `http:` one trips mixed content in
 *                  a browser on `https:`. So only the path is kept and the
 *                  origin is replaced with the server the session is actually
 *                  talking to. Every subscription icon is served by that same
 *                  server, so nothing else is lost.
 *
 *   `third-party`  a free favicon service, for feeds read with no FreshRSS
 *                  behind them. Off unless a caller asks for it: by default
 *                  this module never produces a third-party URL at all.
 *
 * Either way a feed still gets a mark: its initial, in a colour derived from
 * the title, so a feed without an icon looks like a feed rather than a hole.
 * The decision is pure and unit-tested; the component only draws it, and drops
 * an image that fails to load instead of leaving a broken-image frame.
 */

export type FeedIconProvider = "freshrss" | "third-party";

/** The provider every row uses until a setting says otherwise. */
export const DEFAULT_ICON_PROVIDER: FeedIconProvider = "freshrss";

/**
 * Free favicon service for the `third-party` provider. `{host}` is the feed's
 * own site — not the FreshRSS host, since this provider exists for feeds with
 * no FreshRSS behind them. A caller may pass its own template instead.
 */
export const FAVICON_TEMPLATE = "https://icons.duckduckgo.com/ip3/{host}.ico";

/** Inline images above this size are dropped: they bloat the DOM and are usually logos. */
const MAX_DATA_URI = 200_000;

/** Resolution is remembered per feed shape; a long session still stays bounded. */
const MAX_CACHED = 400;

/** The parts of a subscription an icon can be built from. */
export interface FeedIconSubject {
  /** Stream id (`feed/1`). Used to key the cache and to bust it per feed. */
  id?: string;
  title: string;
  iconUrl?: string;
  /** The feed's own site, which the `third-party` provider looks up. */
  htmlUrl?: string;
  url?: string;
}

export interface FeedIconOptions {
  /** Origin this client is authenticated against. Required by `freshrss`. */
  serverUrl?: string;
  /** Defaults to `freshrss`. */
  provider?: FeedIconProvider;
  /** Overrides `FAVICON_TEMPLATE` for the `third-party` provider. */
  template?: string;
}

export interface FeedIcon {
  /** Image to draw, already cache-busted. Absent means draw `initial`. */
  src?: string;
  /** Letter for the fallback chip. */
  initial: string;
  /** Stable hue for that chip. */
  hue: number;
}

/**
 * Image URLs that failed to load, keyed by the URL itself: the failure belongs
 * to the source, so a feed that later gets a different icon is tried again.
 */
export type FeedIconFailures = Readonly<Record<string, true>>;

function httpUrl(raw: string | undefined, base?: string): URL | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  try {
    const url = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** FNV-1a, base 36: short, stable across runs, and enough to tell icons apart. */
function token(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Adds a per-feed `v=` token.
 *
 * Appended as text rather than through `URL.searchParams`, so the query the
 * server signed (`f.php?h=…`) is handed back byte for byte. The token comes
 * from the feed and the icon URL that produced it, so it is the same string on
 * every render — the browser keeps the image — but changes when FreshRSS hands
 * out a different icon, which is when the stale copy has to go.
 */
function busted(url: string, seed: string): string {
  if (url.startsWith("data:")) return url;
  const fragment = url.indexOf("#");
  const body = fragment === -1 ? url : url.slice(0, fragment);
  const separator = body.endsWith("?") || body.endsWith("&") ? "" : body.includes("?") ? "&" : "?";
  return `${body}${separator}v=${token(seed)}`;
}

/** The seed for one feed's cache-busting token. */
function seedOf(feed: FeedIconSubject, source: string): string {
  return `${feed.id ?? ""}\u0000${feed.title}\u0000${source}`;
}

/**
 * FreshRSS's own icon cache, re-homed onto the configured server.
 *
 * The path and query are the server's; the origin is the session's. A relative
 * `iconUrl` resolves against the server first, so `/f.php?h=…` and
 * `f.php?h=…` both end up addressed to the same place.
 */
function freshRssSource(feed: FeedIconSubject, serverUrl: string): string | undefined {
  const raw = feed.iconUrl?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw.startsWith("data:")) return raw.length > MAX_DATA_URI ? undefined : raw;

  const server = httpUrl(serverUrl);
  if (server === undefined) return undefined;

  // A trailing slash keeps the last segment of a server URL as a directory, so
  // `f.php` beside a `/freshrss` base resolves inside it rather than above it.
  const base = server.href.endsWith("/") ? server.href : `${server.href}/`;
  const icon = httpUrl(raw, base);
  if (icon === undefined) return undefined;

  const rehomed = `${server.origin}${icon.pathname}${icon.search}`;
  return busted(rehomed, seedOf(feed, raw));
}

/**
 * A favicon service lookup for a feed with no FreshRSS behind it.
 *
 * Nothing here runs unless the caller asks for `third-party`, and a feed with
 * no site URL yields nothing rather than a made-up host: a wrong request is
 * worse than a letter.
 */
function thirdPartySource(feed: FeedIconSubject, template: string): string | undefined {
  const site = httpUrl(feed.htmlUrl ?? feed.url);
  if (site === undefined || site.hostname === "") return undefined;

  const built = template.replaceAll("{host}", site.hostname);
  // A template with no `{host}` would fetch the same page for every feed.
  if (built === template) return undefined;
  const url = httpUrl(built);
  if (url === undefined) return undefined;

  return busted(url.toString(), seedOf(feed, site.href));
}

/** The image URL a feed should draw, or `undefined` when it has none. */
export function feedIconSource(feed: FeedIconSubject, options: FeedIconOptions = {}): string | undefined {
  const provider = options.provider ?? DEFAULT_ICON_PROVIDER;
  if (provider === "third-party") {
    return thirdPartySource(feed, options.template ?? FAVICON_TEMPLATE);
  }
  return freshRssSource(feed, options.serverUrl ?? "");
}

/*
 * Resolved icons, remembered against the feed's shape.
 *
 * A sidebar row re-renders on every scroll tick, hover and count change, and
 * the template asks for its row's icon on each of those. The answer is a fixed
 * string for a given subscription, so it is worked out once and handed back by
 * identity — the same reason post thumbnails are memoised per item.
 */
const cache = new Map<string, FeedIcon>();

function cacheKey(feed: FeedIconSubject, options: FeedIconOptions): string {
  return [
    options.provider ?? DEFAULT_ICON_PROVIDER,
    options.serverUrl ?? "",
    options.template ?? "",
    feed.id ?? "",
    feed.title,
    feed.iconUrl ?? "",
    feed.htmlUrl ?? "",
    feed.url ?? "",
  ].join("\u0000");
}

/**
 * Everything a row needs to draw a feed's mark: an image when the provider
 * produced one, and the initial chip's letter and hue either way.
 */
export function feedIcon(feed: FeedIconSubject, options: FeedIconOptions = {}): FeedIcon {
  const key = cacheKey(feed, options);
  const known = cache.get(key);
  if (known !== undefined) return known;

  const icon: FeedIcon = {
    src: feedIconSource(feed, options),
    initial: feedInitial(feed.title),
    hue: feedHue(feed.title),
  };
  // Bounded: a session can see hundreds of feeds, but never unbounded memory.
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, icon);
  return icon;
}

/** Forgets resolved icons. For tests, and for a provider change at runtime. */
export function resetFeedIconCache(): void {
  cache.clear();
}

/**
 * Marks an image URL as failed, copy-on-write so a Svelte row re-renders.
 * Repeating the error is a no-op, so a retrying `<img>` cannot spin.
 */
export function markFeedIconBroken(broken: FeedIconFailures, src: string): FeedIconFailures {
  if (broken[src] === true) return broken;
  return { ...broken, [src]: true };
}

/**
 * The image to draw for a feed: `undefined` once its source has failed, which
 * is what turns the row into its initial chip with no broken-image glyph in
 * between.
 */
export function feedIconImage(icon: FeedIcon, broken: FeedIconFailures): string | undefined {
  if (icon.src === undefined) return undefined;
  return broken[icon.src] === true ? undefined : icon.src;
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
