/**
 * What the top of the phone says you are syncing with.
 *
 * The bar used to say the app's own name, which is the one thing on that screen
 * a reader already knows. What they check is *which* reader — the tailnet box,
 * the dev container, a server they forgot they were signed into.
 *
 * A session stores an API prefix, never a product name (`api/freshrss.ts`: "a
 * prefix that answered"), so this reads the prefix back rather than pretending
 * a server told it. Two are certain — FreshRSS's own `greader.php`, and any
 * `/v1/reader/api/0`, which is Miniflux's GReader root — and anything else gets
 * the host, which is at least true. A local library is the app, because there is
 * no service to name.
 */
import { serverLabel } from "./server-label";

/** The three things the bar can name, and the fallback. */
export type ServiceName = string;

/**
 * The service behind `apiPath`, or the host when the prefix is not a known one.
 *
 * Matching is on the tail of the prefix, so a server behind a base path
 * (`/freshrss/api/greader.php`, `/miniflux/v1/reader/api/0`) still reads as
 * itself: what identifies a product is the last segment, not the mount point.
 */
export function serviceName(apiPath: string | null | undefined, serverUrl: string): ServiceName {
  const path = (apiPath ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (path.endsWith("/greader.php") || path.endsWith("greader.php")) return "FreshRSS";
  if (path.endsWith("/reader/api/0") && /(^|\/)v1(\/|$)/.test(path)) return "Miniflux";
  const host = serverLabel(serverUrl);
  return host === "" ? "Sync" : host;
}

/**
 * The word the bar draws: the service when there is one, the app when there is
 * not.
 *
 * "On this device" is not a service and must not be drawn as one — a local
 * library has no server to be signed into, so the honest label is the app's own.
 */
export function headerLabel(options: {
  serverUrl: string;
  apiPath: string | null;
  local: boolean;
}): ServiceName {
  if (options.local || options.serverUrl.trim() === "") return "HardlyReader";
  return serviceName(options.apiPath, options.serverUrl);
}
