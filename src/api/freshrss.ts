/** HTTP transport shape. Injected so the API layer can be exercised outside the
 * Tauri webview (tests, scripts) without pulling in the plugin.
 *
 * The concrete transport for each runtime lives in `./transport`. */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>;

export class AuthError extends Error {
  /**
   * The HTTP status, when the server itself refused the credential.
   *
   * The distinction matters while probing: a `401` is a server saying "this
   * endpoint is here and your password is not", which no other prefix can fix.
   * An `AuthError` without a status is a body this client could not read — an
   * HTML page where a token should be — which just means "not this prefix".
   */
  status?: number;

  constructor(message = "Authentication failed", status?: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface Credentials {
  serverUrl: string;
  email: string;
  apiPassword: string;
  /**
   * Where this server's GReader API lives. Omitted means "find out" — see
   * {@link probeGreaderSession}.
   */
  apiPath?: string;
}

export interface Session {
  serverUrl: string;
  /**
   * The GReader API root on this server, e.g. `/api/greader.php` for FreshRSS
   * or `/v1/reader/api/0` for Miniflux. Every request below is built from it,
   * so the client is not tied to one server product's URL layout.
   */
  apiPath: string;
  email: string;
  token: string;
}

export interface UserInfo {
  userId: string;
  userName: string;
  userProfileId: string;
  userEmail: string;
}

/** Strips trailing slashes and requires an explicit scheme. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Server URL must start with http:// or https://");
  }
  return trimmed;
}

/** FreshRSS's own GReader entry point. Every session saved before `apiPath`
 * existed meant this, which is why it is also the default for a session that
 * has no field (see `loadSession`). */
export const DEFAULT_API_PATH = "/api/greader.php";

/**
 * Where the GReader API's own paths start.
 *
 * A server publishes an *API root* — `…/reader/api/0` for most of them, its own
 * `greader.php` for FreshRSS. Paths in this module stay the API's own
 * (`/reader/api/0/user-info`, `/accounts/ClientLogin`), so a root that already
 * ends in `reader/api/0` must not be handed it a second time.
 */
const READER_ROOT = "/reader/api/0";

/**
 * The GReader roots this client looks for, in probe order.
 *
 *   /api/greader.php       FreshRSS — first, because it is what this app is for
 *   /v1/reader/api/0       Miniflux
 *   /reader/api/0          The Old Reader, Inoreader
 *   /plugins/greader/api   Tiny Tiny RSS with its greader plugin
 *
 * What a session stores is a prefix that answered, never a product name: a
 * fifth server works by pasting its URL with the path on the end, and nothing
 * downstream behaves differently because of which prefix won.
 */
export const GREADER_PREFIXES: readonly string[] = [
  DEFAULT_API_PATH,
  "/v1/reader/api/0",
  "/reader/api/0",
  "/plugins/greader/api",
];

/** Canonical prefix: leading slash, no trailing slashes, never empty. */
export function normalizeApiPath(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/\/+$/, "");
  if (raw === "") return DEFAULT_API_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * The auth root behind an API root.
 *
 * `ClientLogin` sits one level up from the reader API on the servers that
 * publish `/reader/api/0` — Miniflux serves it under `/v1`, The Old Reader at
 * its own root — while FreshRSS serves it inside `greader.php` itself.
 */
function authRoot(prefix: string): string {
  return prefix.endsWith(READER_ROOT) ? prefix.slice(0, -READER_ROOT.length) : prefix;
}

/** Joins one of the API's own paths onto a prefix, without doubling its root. */
export function greaderPathFor(apiPath: string, path: string): string {
  const prefix = normalizeApiPath(apiPath);
  const underReader = path === READER_ROOT || path.startsWith(`${READER_ROOT}/`);
  if (underReader && prefix.endsWith(READER_ROOT)) {
    return prefix + path.slice(READER_ROOT.length);
  }
  if (path.startsWith("/accounts/") && prefix.endsWith(READER_ROOT)) {
    return authRoot(prefix) + path;
  }
  return prefix + path;
}

export function greaderUrl(
  serverUrl: string,
  path: string,
  apiPath: string = DEFAULT_API_PATH,
): string {
  return `${normalizeServerUrl(serverUrl)}${greaderPathFor(apiPath, path)}`;
}

/** What a pasted URL turned out to be: a server, and the prefix it named. */
export interface ServerTarget {
  serverUrl: string;
  /** The prefix found on the end of the URL, or `""` when it named none. */
  apiPath: string;
}

/**
 * Splits a typed URL into a server and, when it carries one, an API prefix.
 *
 * One field, and no mode: `https://reader.example/v1/reader/api/0` and
 * `https://reader.example` differ only in how much of the answer the reader
 * already knew. The longer prefixes are matched first so Miniflux's
 * `/v1/reader/api/0` is not read as The Old Reader's `/reader/api/0`.
 */
export function parseServerInput(input: string): ServerTarget {
  const normalized = normalizeServerUrl(input);
  const known = [...GREADER_PREFIXES].sort((a, b) => b.length - a.length);

  for (const prefix of known) {
    if (normalized.toLocaleLowerCase().endsWith(prefix.toLocaleLowerCase())) {
      const serverUrl = normalized.slice(0, normalized.length - prefix.length).replace(/\/+$/, "");
      // A bare `/api/greader.php` leaves no server behind; that is not a target.
      if (/^https?:\/\/[^/]+/i.test(serverUrl)) {
        return { serverUrl, apiPath: prefix };
      }
    }
  }

  // A `greader.php` somewhere else — a proxy that rewrites it, a hand-rolled
  // install — is still FreshRSS's own entry point. Discovery and the extension
  // gate have to agree on that, so the reading is the same in both.
  const own = /^(.*)\/greader\.php$/i.exec(normalized);
  if (own !== null && /^https?:\/\/[^/]+/i.test(own[1])) {
    return { serverUrl: own[1].replace(/\/+$/, ""), apiPath: "/greader.php" };
  }

  return { serverUrl: normalized, apiPath: "" };
}

function authHeader(token: string): string {
  return `GoogleLogin auth=${token}`;
}

/**
 * ClientLogin returns a plain-text body:
 *
 *   SID=user/hash
 *   LSID=null
 *   Auth=user/hash
 *
 * FreshRSS terminates the Auth line with a space, so the value is trimmed.
 */
export function parseClientLogin(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = /^Auth=(.*)$/.exec(line);
    if (match) {
      const token = match[1].trim();
      if (token !== "") {
        return token;
      }
    }
  }
  throw new AuthError("ClientLogin response did not contain an Auth token");
}

/**
 * Exchanges the FreshRSS API password for a GoogleLogin token.
 *
 * The API password is required; the account password is rejected with 401 when
 * API access is enabled.
 */
export async function clientLogin(
  transport: Transport,
  credentials: Credentials,
): Promise<Session> {
  const apiPath = normalizeApiPath(credentials.apiPath);
  const url = greaderUrl(credentials.serverUrl, "/accounts/ClientLogin", apiPath);
  const body = new URLSearchParams({
    Email: credentials.email,
    Passwd: credentials.apiPassword,
  });

  const response = await transport(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (response.status === 401) {
    throw new AuthError("Wrong email or API password", 401);
  }
  if (!response.ok) {
    throw new HttpError(response.status, `ClientLogin failed (HTTP ${response.status})`);
  }

  return {
    serverUrl: normalizeServerUrl(credentials.serverUrl),
    apiPath,
    email: credentials.email,
    token: parseClientLogin(await response.text()),
  };
}

/** One prefix, and what asking it came to. */
export interface GreaderProbeAttempt {
  apiPath: string;
  /** The short reason it did not answer, for a message a reader can act on. */
  reason: string;
}

/** Raised when no known prefix on a server answered. */
export class GreaderProbeError extends Error {
  readonly serverUrl: string;
  readonly attempts: GreaderProbeAttempt[];

  constructor(serverUrl: string, attempts: GreaderProbeAttempt[]) {
    const tried = attempts.map((attempt) => attempt.apiPath).join(", ");
    super(
      `No GReader API answered on ${serverUrl}. Tried ${tried}. ` +
        "Check the address, and that API access is switched on for this account.",
    );
    this.name = "GreaderProbeError";
    this.serverUrl = serverUrl;
    this.attempts = attempts;
  }
}

/** A refusal the server itself made: no other prefix can turn it into a yes. */
function isAuthRefusal(error: unknown): boolean {
  return error instanceof AuthError && error.status === 401;
}

function probeReason(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error && error.message !== "") return error.message;
  return "failed";
}

/**
 * Signs in to any GReader server: one URL in, the prefix that answered out.
 *
 * Each attempt is the same exchange the client already made — `ClientLogin` for
 * a token, then `user-info` with that token — so this needs no second auth path
 * and no guesswork about which product is on the other end. The first prefix
 * whose `user-info` answers wins and is stored on the session; a session is
 * returned only once one has, so nothing half-signed-in can be saved.
 *
 * Order: a prefix found on the pasted URL first (the reader told us, so believe
 * them), then {@link GREADER_PREFIXES}. A `401` ends the probe immediately —
 * the endpoint is there and the password is wrong — while a `404`, a `501`, an
 * HTML page or a network miss just means "not this prefix".
 */
export async function probeGreaderSession(
  transport: Transport,
  credentials: Credentials,
): Promise<Session> {
  const target = parseServerInput(credentials.serverUrl);
  const prefixes: string[] = [];
  for (const candidate of [target.apiPath, ...GREADER_PREFIXES]) {
    const apiPath = normalizeApiPath(candidate);
    if (!prefixes.includes(apiPath)) prefixes.push(apiPath);
  }

  const attempts: GreaderProbeAttempt[] = [];

  for (const apiPath of prefixes) {
    let session: Session;
    try {
      session = await clientLogin(transport, { ...credentials, serverUrl: target.serverUrl, apiPath });
    } catch (error) {
      if (isAuthRefusal(error)) throw error;
      attempts.push({ apiPath, reason: probeReason(error) });
      continue;
    }

    try {
      await userInfo(transport, session);
      return session;
    } catch (error) {
      if (isAuthRefusal(error)) throw error;
      attempts.push({ apiPath, reason: probeReason(error) });
    }
  }

  throw new GreaderProbeError(target.serverUrl, attempts);
}

/**
 * How a request spent its time.
 *
 * Two numbers because they answer different questions: `fetch` is the wait for
 * the server (the part the network owns), `parse` is reading the body and
 * turning it into JSON (the part this client owns). On a fast local server the
 * second can be the larger of the two, which is exactly why they are measured
 * apart.
 */
export interface RequestTiming {
  fetch: number;
  parse: number;
}

/** Authenticated GET against the GReader API. */
export async function authorizedGet<T>(
  transport: Transport,
  session: Session,
  path: string,
  options: { signal?: AbortSignal; timing?: (timing: RequestTiming) => void } = {},
): Promise<T> {
  const started = performance.now();
  const response = await transport(greaderUrl(session.serverUrl, path, session.apiPath), {
    method: "GET",
    signal: options.signal,
    headers: { Authorization: authHeader(session.token) },
  });
  const arrived = performance.now();

  if (response.status === 401) {
    throw new AuthError("Token rejected by server", 401);
  }
  if (!response.ok) {
    throw new HttpError(response.status, `Request failed (HTTP ${response.status})`);
  }

  const body = (await response.json()) as T;
  options.timing?.({ fetch: arrived - started, parse: performance.now() - arrived });
  return body;
}

/** Confirms a stored token is still valid and returns the account it belongs to. */
export async function userInfo(transport: Transport, session: Session): Promise<UserInfo> {
  return authorizedGet<UserInfo>(transport, session, "/reader/api/0/user-info");
}

/* ---------------------------------------------------------------------------
 * Reader data
 *
 * Every JSON endpoint requires `output=json`; without it FreshRSS answers 501.
 * The query is applied centrally here so no call site has to remember.
 * ------------------------------------------------------------------------- */

export interface FeedCategory {
  id: string;
  label: string;
}

export interface Subscription {
  /** Stream id, e.g. `feed/1`. The trailing number is the FreshRSS feed id. */
  id: string;
  title: string;
  url: string;
  htmlUrl?: string;
  iconUrl?: string;
  categories: FeedCategory[];
  /** FreshRSS priority marker, e.g. `main`. Hidden Categories rewrites this. */
  priority?: string;
}

export interface Tag {
  id: string;
  type?: string;
}

export interface StreamOrigin {
  streamId: string;
  htmlUrl?: string;
  title?: string;
}

export interface StreamItem {
  id: string;
  title?: string;
  published?: number;
  timestampUsec?: string;
  alternate?: { href: string }[];
  canonical?: { href: string }[];
  categories?: string[];
  origin?: StreamOrigin;
  author?: string;
  summary?: { content: string };
  content?: { content: string };
  /** Podcast/photo feeds: the post's own attachment. */
  enclosure?: { href: string; type?: string }[];
  /** Media RSS, when a feed speaks it. */
  media?: {
    thumbnail?: { url: string }[];
    content?: { url: string; type?: string }[];
  };
}

export interface StreamContents {
  id: string;
  updated?: number;
  continuation?: string;
  items: StreamItem[];
}

export interface UnreadCount {
  id: string;
  count: number;
  newestItemTimestampUsec?: string;
}

export const STATE_READ = "user/-/state/com.google/read";
export const STATE_STARRED = "user/-/state/com.google/starred";
export const READING_LIST = "user/-/state/com.google/reading-list";

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams({ output: "json" });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  return `${path}?${query.toString()}`;
}

export async function listSubscriptions(
  transport: Transport,
  session: Session,
): Promise<Subscription[]> {
  const body = await authorizedGet<{ subscriptions?: Subscription[] }>(
    transport,
    session,
    withQuery("/reader/api/0/subscription/list", {}),
  );
  return body.subscriptions ?? [];
}

export async function listTags(transport: Transport, session: Session): Promise<Tag[]> {
  const body = await authorizedGet<{ tags?: Tag[] }>(
    transport,
    session,
    withQuery("/reader/api/0/tag/list", {}),
  );
  return body.tags ?? [];
}

export async function getUnreadCounts(
  transport: Transport,
  session: Session,
): Promise<UnreadCount[]> {
  const body = await authorizedGet<{ unreadcounts?: UnreadCount[] }>(
    transport,
    session,
    withQuery("/reader/api/0/unread-count", {}),
  );
  return body.unreadcounts ?? [];
}

export interface StreamOptions {
  count?: number;
  continuation?: string;
  excludeRead?: boolean;
  /** Lets the caller drop a response that is no longer wanted. */
  signal?: AbortSignal;
  /** Reports how the request spent its time, for the switch timings. */
  timing?: (timing: RequestTiming) => void;
}

export async function getStreamContents(
  transport: Transport,
  session: Session,
  streamId: string,
  options: StreamOptions = {},
): Promise<StreamContents> {
  // Stream ids contain slashes and are not percent-encoded by FreshRSS itself.
  const path = withQuery(`/reader/api/0/stream/contents/${streamId}`, {
    n: options.count,
    c: options.continuation,
    xt: options.excludeRead ? STATE_READ : undefined,
  });
  return authorizedGet<StreamContents>(transport, session, path, {
    signal: options.signal,
    timing: options.timing,
  });
}

/** Read/write actions need a separate short-lived token from `/token`. */
export async function getWriteToken(transport: Transport, session: Session): Promise<string> {
  const response = await transport(greaderUrl(session.serverUrl, "/reader/api/0/token", session.apiPath), {
    method: "GET",
    headers: { Authorization: authHeader(session.token) },
  });

  if (response.status === 401) {
    throw new AuthError("Token rejected by server", 401);
  }
  if (!response.ok) {
    throw new HttpError(response.status, `Token request failed (HTTP ${response.status})`);
  }

  const token = (await response.text()).trim();
  if (token === "") {
    throw new HttpError(response.status, "Server returned an empty write token");
  }
  return token;
}

export interface EditTagRequest {
  itemIds: string[];
  add?: string[];
  remove?: string[];
}

/**
 * Applies tag changes (read/unread, starred) to one or more items.
 *
 * Requires the write token; a stale one is rejected with 401.
 */
export async function editTag(
  transport: Transport,
  session: Session,
  request: EditTagRequest,
): Promise<void> {
  const writeToken = await getWriteToken(transport, session);

  const body = new URLSearchParams({ T: writeToken });
  for (const id of request.itemIds) {
    body.append("i", id);
  }
  for (const tag of request.add ?? []) {
    body.append("a", tag);
  }
  for (const tag of request.remove ?? []) {
    body.append("r", tag);
  }

  const response = await transport(greaderUrl(session.serverUrl, "/reader/api/0/edit-tag", session.apiPath), {
    method: "POST",
    headers: {
      Authorization: authHeader(session.token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (response.status === 401) {
    throw new AuthError("Write token rejected by server", 401);
  }
  if (!response.ok) {
    throw new HttpError(response.status, `edit-tag failed (HTTP ${response.status})`);
  }
}

/* ---------------------------------------------------------------------------
 * Subscriptions
 *
 * FreshRSS accepts subscription ids in two shapes and only one of them works:
 * `feed/<url>` (or `feed/<numeric id>`) subscribes, while `feed:<url>` is
 * answered with HTTP 200 / `OK` and changes nothing — a silent no-op that looks
 * like success. Every subscription id built here therefore uses the slash form.
 *
 * A successful POST is also not proof of a change on its own: FreshRSS answers
 * `OK` to edits it ignored. Callers that need certainty re-read
 * `listSubscriptions`.
 * ------------------------------------------------------------------------- */

/**
 * Stream id for a feed URL, e.g. `feed/https://example.com/rss.xml`.
 *
 * The URL itself is left unescaped — `URLSearchParams` does the encoding when
 * the request body is built, and the separators inside the id must survive as
 * literal characters on the wire.
 */
export function feedStreamId(feedUrl: string): string {
  return `feed/${feedUrl}`;
}

/**
 * The server's own words, when it bothered to send any.
 *
 * FreshRSS answers a refused subscribe with a short plain-text or HTML
 * explanation; the status alone ("HTTP 400") tells the user nothing about
 * *why* the URL was rejected, so the text is flattened and appended.
 */
async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const flat = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat === "" ? "" : `: ${flat.slice(0, 200)}`;
}

/** POSTs to a write endpoint with a freshly issued write token. */
async function postWithWriteToken(
  transport: Transport,
  session: Session,
  path: string,
  params: URLSearchParams,
  failureLabel: string,
): Promise<void> {
  const writeToken = await getWriteToken(transport, session);
  params.set("T", writeToken);

  const response = await transport(greaderUrl(session.serverUrl, path, session.apiPath), {
    method: "POST",
    headers: {
      Authorization: authHeader(session.token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (response.status === 401) {
    throw new AuthError("Write token rejected by server", 401);
  }
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new HttpError(response.status, `${failureLabel} failed (HTTP ${response.status})${detail}`);
  }
}

/**
 * Adds a feed.
 *
 * `title` overrides the title FreshRSS derives from the feed; omit it to keep
 * the feed's own. Rejects with `HttpError` 400 when the feed is already
 * subscribed or when FreshRSS cannot fetch and parse the URL.
 */
export async function subscribe(
  transport: Transport,
  session: Session,
  feedUrl: string,
  title?: string,
  category?: string,
): Promise<void> {
  const params = new URLSearchParams({
    ac: "subscribe",
    s: feedStreamId(feedUrl),
  });
  if (title !== undefined && title !== "") {
    params.set("t", title);
  }
  // `a` is GReader's "add to this label": the same field the website uses when
  // a feed arrives inside a folder, which is how an OPML import keeps them.
  if (category !== undefined && category !== "") {
    params.set("a", `user/-/label/${category}`);
  }

  await postWithWriteToken(
    transport,
    session,
    "/reader/api/0/subscription/edit",
    params,
    "subscribe",
  );
}

/**
 * Moves a subscription to another category.
 *
 * `to` is the category label it should end up in, or null for Uncategorized —
 * which is not a label at all, just the absence of one, so it is expressed by
 * removing the old label and adding nothing. Uncategorized is never sent as an
 * `r` value: FreshRSS has no such label to remove.
 *
 * `ac=edit` is GReader's "change this subscription" action: `a` adds a label,
 * `r` removes one, and both together are a move.
 */
export async function moveFeed(
  transport: Transport,
  session: Session,
  streamId: string,
  to: string | null,
  from: string | null,
): Promise<void> {
  const params = new URLSearchParams({ ac: "edit", s: streamId });
  if (to !== null && to !== "") {
    params.set("a", `user/-/label/${to}`);
  }
  if (from !== null && from !== "" && from !== to) {
    params.set("r", `user/-/label/${from}`);
  }
  if (params.has("a") === false && params.has("r") === false) return;
  await postWithWriteToken(transport, session, "/reader/api/0/subscription/edit", params, "Move");
}

/**
 * Removes a subscription.
 *
 * `streamId` is an id from {@link listSubscriptions}, either `feed/<url>` or
 * `feed/<numeric id>`. Rejects with `HttpError` 400 when no such feed is
 * subscribed.
 */
export async function unsubscribe(
  transport: Transport,
  session: Session,
  streamId: string,
): Promise<void> {
  const params = new URLSearchParams({
    ac: "unsubscribe",
    s: streamId,
  });

  await postWithWriteToken(
    transport,
    session,
    "/reader/api/0/subscription/edit",
    params,
    "unsubscribe",
  );
}

export function isRead(item: StreamItem): boolean {
  return item.categories?.includes(STATE_READ) ?? false;
}

export function isStarred(item: StreamItem): boolean {
  return item.categories?.includes(STATE_STARRED) ?? false;
}

/** Labels attached to an item, without the Google Reader state entries. */
export function itemLabels(item: StreamItem): string[] {
  return (item.categories ?? []).filter(
    (c) => !c.startsWith("user/-/state/") && !c.startsWith("user/-/label/"),
  );
}
