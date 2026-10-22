/** HTTP transport shape. Injected so the API layer can be exercised outside the
 * Tauri webview (tests, scripts) without pulling in the plugin. */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>;

export const tauriTransport: Transport = async (input, init) => {
  const { fetch } = await import("@tauri-apps/plugin-http");
  return fetch(input, init);
};

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
