/** HTTP transport shape. Injected so the API layer can be exercised outside the
 * Tauri webview (tests, scripts) without pulling in the plugin.
 *
 * The concrete transport for each runtime lives in `./transport`. */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>;

export class AuthError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "AuthError";
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
}

export interface Session {
  serverUrl: string;
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

export function greaderUrl(serverUrl: string, path: string): string {
  return `${normalizeServerUrl(serverUrl)}/api/greader.php${path}`;
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
  const url = greaderUrl(credentials.serverUrl, "/accounts/ClientLogin");
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
    throw new AuthError("Wrong email or API password");
  }
  if (!response.ok) {
    throw new HttpError(response.status, `ClientLogin failed (HTTP ${response.status})`);
  }

  return {
    serverUrl: normalizeServerUrl(credentials.serverUrl),
    email: credentials.email,
    token: parseClientLogin(await response.text()),
  };
}

/** Authenticated GET against the GReader API. */
export async function authorizedGet<T>(
  transport: Transport,
  session: Session,
  path: string,
): Promise<T> {
  const response = await transport(greaderUrl(session.serverUrl, path), {
    method: "GET",
    headers: { Authorization: authHeader(session.token) },
  });

  if (response.status === 401) {
    throw new AuthError("Token rejected by server");
  }
  if (!response.ok) {
    throw new HttpError(response.status, `Request failed (HTTP ${response.status})`);
  }

  return (await response.json()) as T;
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
  return authorizedGet<StreamContents>(transport, session, path);
}

/** Read/write actions need a separate short-lived token from `/token`. */
export async function getWriteToken(transport: Transport, session: Session): Promise<string> {
  const response = await transport(greaderUrl(session.serverUrl, "/reader/api/0/token"), {
    method: "GET",
    headers: { Authorization: authHeader(session.token) },
  });

  if (response.status === 401) {
    throw new AuthError("Token rejected by server");
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

  const response = await transport(greaderUrl(session.serverUrl, "/reader/api/0/edit-tag"), {
    method: "POST",
    headers: {
      Authorization: authHeader(session.token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (response.status === 401) {
    throw new AuthError("Write token rejected by server");
  }
  if (!response.ok) {
    throw new HttpError(response.status, `edit-tag failed (HTTP ${response.status})`);
  }
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
