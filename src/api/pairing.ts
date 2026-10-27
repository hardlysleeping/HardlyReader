/**
 * Pairing, over the wire.
 *
 * The state machine is `src/lib/pairing.ts`; this file is the five requests
 * that drive it, and the statement of what the server has to do for any of it
 * to work.
 *
 * ## SERVER MUST
 *
 * The client half is useless without these, and they are not in this repository
 * — the extension has to be deployed for them to exist. In order of how much
 * they block:
 *
 * 1. **A pairing store with the same five routes**, under
 *    `/api/misc.php/Hardly%20Read/v1/pair/*`, with the same bodies and the same
 *    refusal codes (see `PAIRING_ROUTE` and `reasonOf` below). The extension
 *    here implements it (`lib/HardlyReadPairingStore.php`); the deployed
 *    extension is the one that counts.
 *
 * 2. **`POST /pair/request` and `POST /pair/redeem` unauthenticated.** They are
 *    the only two routes in the API that may be reached without a GoogleLogin
 *    credential, because a phone signing in has none — the code is the
 *    credential. Every other route keeps the existing rule.
 *
 * 3. **Rate limiting, by client address, on `/pair/redeem`.** Eight digits is
 *    10^8; a five-minute ticket is not enough on its own. The extension cannot
 *    see the client through most proxies, so this belongs at the web server or
 *    the reverse proxy in front of FreshRSS. Without it a code is a lottery
 *    ticket, not a secret. Count *failed* attempts — a code that is not there,
 *    or is not eight digits — and not `not_approved`, which is the answer a
 *    legitimate phone gets every few seconds while it waits for somebody to
 *    press approve. Throttling that answer throttles the only client that is
 *    behaving.
 *
 * 4. **A device token the server accepts.** On redeem the server mints
 *    `hrd_` + 32 random bytes, stores the SHA-256 of it with a label, an
 *    account, a created date, a last-used date and a revoked flag, and returns
 *    it once. It must then accept `Authorization: GoogleLogin auth=<login>/<token>`
 *    wherever it accepts an API password — the extension's own authenticator
 *    does (`HardlyReadExtension::authenticateGoogleLogin`). GReader does not,
 *    until the server also installs that token as a per-device API password for
 *    the account; FreshRSS supports more than one, and doing so is what makes a
 *    paired phone able to *read feeds*, not only talk to this API. Until that
 *    exists, a paired phone signs in and its sync is refused 401 — which the
 *    reader already handles as "this sign-in was refused", and which is the
 *    honest state of affairs rather than something this client can paper over.
 *
 * 5. **Revocation that takes effect on the next request**, not at token expiry:
 *    the store must check the revoked flag when it authenticates, which is why
 *    the token is kept as a hash plus a flag and not as a session.
 *
 * What is *not* required, and must not be: a captcha bypass. Nothing here solves
 * a captcha, reads a FreshRSS login page, or carries a session token. The human
 * check is the approve press on a device that is already signed in.
 *
 * ## The bodies
 *
 * Every body below is built field by field. Nothing spreads a session, a
 * credential or a ticket into a request — the hand-off is a code, and the one
 * thing it must never become is a way to move a token between devices.
 */

import { DEFAULT_API_PATH, normalizeServerUrl, type Session, type Transport } from "./freshrss";
import { ApiError, apiUrl } from "./hardlyread";
import {
  credentialSessionToken,
  isDeviceToken,
  type DeviceCredential,
  type PairingRefusal,
} from "../lib/pairing";

/** The five routes, relative to the extension's `/v1`. */
export const PAIRING_ROUTE = {
  /** Unauthenticated: a signed-out phone asks for a code. */
  request: "/pair/request",
  /** Authenticated: the codes waiting to be approved on this device. */
  pending: "/pair/pending",
  /** Authenticated: the human press that binds a code to this account. */
  approve: "/pair/approve",
  /** Unauthenticated: the phone claims an approved code, once. */
  redeem: "/pair/redeem",
  /** Device token: the phone withdraws what it was given. */
  revoke: "/pair/revoke",
} as const;

/** A code the phone has been given and is showing. */
export interface PairingOffer {
  code: string;
  label: string;
  expiresAt: number;
}

/** A code waiting on a signed-in device, as the settings row draws it. */
export interface PendingPairing {
  code: string;
  label: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Asking for a code.
 *
 * `unavailable` is the important case: a server whose extension predates the
 * route answers 404, and the phone must fall back to the API-password field
 * rather than showing a code box that cannot work.
 */
export type PairingRequestAnswer =
  | { kind: "code"; offer: PairingOffer }
  | { kind: "unavailable" }
  | { kind: "failed"; error: unknown };

/**
 * Claiming a code.
 *
 * `waiting` is not a failure — it is the answer to "has a human approved me
 * yet", and the phone asks again in two seconds.
 */
export type PairingRedeemAnswer =
  | { kind: "paired"; credential: DeviceCredential }
  | { kind: "waiting" }
  | { kind: "refused"; reason: PairingRefusal }
  | { kind: "unavailable" }
  | { kind: "failed"; error: unknown };

/** The pending list, or a server that does not have the route. */
export interface PendingPairingAnswer {
  available: boolean;
  pairings: PendingPairing[];
}

/** What an approve press came to. */
export type PairingApproveAnswer =
  | { kind: "approved"; account: string }
  | { kind: "refused"; reason: PairingRefusal }
  | { kind: "unavailable" }
  | { kind: "failed"; error: unknown };

/** What a revoke came to. */
export type PairingRevokeAnswer =
  | { kind: "revoked" }
  | { kind: "refused"; reason: PairingRefusal }
  | { kind: "unavailable" }
  | { kind: "failed"; error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The refusal behind a response, or null when it was not one we know.
 *
 * The wire spellings are the module's own (`wrong_code`, `not_approved`, …), so
 * there is one vocabulary for the same fact on both sides of the network; the
 * status codes only exist so a cache and a log can tell them apart.
 */
function reasonOf(error: ApiError): PairingRefusal | null {
  const known: PairingRefusal[] = [
    "invalid_code",
    "wrong_code",
    "expired",
    "used",
    "revoked",
    "wrong_account",
    "not_approved",
    "already_approved",
  ];
  return (known as string[]).includes(error.code) ? (error.code as PairingRefusal) : null;
}

/**
 * Whether the answer means "this install has no pairing", rather than "this
 * attempt was refused".
 *
 * Both spellings are the same fact to a reader: a route the deployed extension
 * does not have (404, no code — a plain not-found page), and a router newer than
 * its store (503 `pairing_unavailable`). Neither is worth a red message; both
 * mean the offer should not be made at all.
 */
function noPairing(error: ApiError): boolean {
  return error.status === 404 || error.code === "pairing_unavailable";
}

/** One request against the extension, with or without a credential. */
async function call(
  transport: Transport,
  serverUrl: string,
  path: string,
  options: { method: "GET" | "POST"; token?: string; body?: Record<string, unknown>; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.Authorization = `GoogleLogin auth=${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await transport(apiUrl(normalizeServerUrl(serverUrl), path), {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const body = await bodyOf(response);
  if (!response.ok) {
    const error = body.error;
    const code = isRecord(error) && typeof error.code === "string" ? error.code : `http_${response.status}`;
    const message =
      isRecord(error) && typeof error.message === "string" && error.message !== ""
        ? error.message
        : `Request failed (HTTP ${response.status})`;
    throw new ApiError(response.status, code, message, null, null, body);
  }
  return body;
}

/**
 * Asks for a code. No credential: this is the signed-out phone.
 *
 * The label is what the approving screen will show, so it says what the device
 * is ("Phone", "Tablet") and never who is holding it.
 */
export async function requestPairing(
  transport: Transport,
  options: { serverUrl: string; label: string; signal?: AbortSignal },
): Promise<PairingRequestAnswer> {
  try {
    const body = await call(transport, options.serverUrl, PAIRING_ROUTE.request, {
      method: "POST",
      body: { label: options.label },
      signal: options.signal,
    });
    if (typeof body.code !== "string" || typeof body.expiresAt !== "number") {
      return { kind: "failed", error: new Error("The server did not answer with a code.") };
    }
    return {
      kind: "code",
      offer: {
        code: body.code,
        label: options.label,
        expiresAt: body.expiresAt,
      },
    };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "failed", error };
    // "This install has no pairing" is not a failure to show in red: the reader
    // shows the same sentence for a route that is not there and for a router
    // newer than its store.
    if (noPairing(error)) return { kind: "unavailable" };
    return { kind: "failed", error };
  }
}

/**
 * Claims a code — the phone's one and only credential-bearing request.
 *
 * The body carries the code and the label, and nothing else. Not a session, not
 * a password, not a token: the server decides which account this is for, because
 * the ticket says so.
 */
export async function redeemPairing(
  transport: Transport,
  options: { serverUrl: string; code: string; label: string; signal?: AbortSignal },
): Promise<PairingRedeemAnswer> {
  try {
    const body = await call(transport, options.serverUrl, PAIRING_ROUTE.redeem, {
      method: "POST",
      body: { code: options.code, label: options.label },
      signal: options.signal,
    });
    const credential = credentialOf(body);
    if (credential === null) {
      return { kind: "failed", error: new Error("The server did not answer with a credential.") };
    }
    return { kind: "paired", credential };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "failed", error };
    if (error.code === "not_approved") return { kind: "waiting" };
    const reason = reasonOf(error);
    if (reason !== null) return { kind: "refused", reason };
    if (noPairing(error)) return { kind: "unavailable" };
    return { kind: "failed", error };
  }
}

/**
 * A credential, from a redeem answer.
 *
 * Checked here rather than trusted: a body with a token that is not one of the
 * extension's (`hrd_` + 64 hex) is not a credential this app can store, and
 * storing it would put an unknown string in the session slot.
 */
function credentialOf(body: Record<string, unknown>): DeviceCredential | null {
  const token = body.token;
  const account = body.account;
  if (!isDeviceToken(token) || typeof account !== "string" || account === "") return null;
  const now = Date.now();
  return {
    token,
    account,
    label: typeof body.label === "string" ? body.label : "",
    pairedAt: typeof body.pairedAt === "number" ? body.pairedAt : now,
    lastUsedAt: typeof body.lastUsedAt === "number" ? body.lastUsedAt : now,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : now,
    revokedAt: null,
  };
}

/**
 * The codes waiting on this signed-in device.
 *
 * Read-only and cheap: a handful of tickets with their timestamps, drawn with a
 * countdown. An adapter without the route answers 404 and the row simply does
 * not appear.
 */
export async function pendingPairings(
  transport: Transport,
  session: Session,
  signal?: AbortSignal,
): Promise<PendingPairingAnswer> {
  try {
    const body = await call(transport, session.serverUrl, PAIRING_ROUTE.pending, {
      method: "GET",
      token: session.token,
      signal,
    });
    const rows: PendingPairing[] = [];
    if (Array.isArray(body.pairings)) {
      for (const entry of body.pairings) {
        if (!isRecord(entry)) continue;
        if (typeof entry.code !== "string" || typeof entry.expiresAt !== "number") continue;
        rows.push({
          code: entry.code,
          label: typeof entry.label === "string" ? entry.label : "",
          issuedAt: typeof entry.issuedAt === "number" ? entry.issuedAt : 0,
          expiresAt: entry.expiresAt,
        });
      }
    }
    return { available: true, pairings: rows };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // "No pairing here" is an answer about the install, not a failure to report
    // in the panel: an extension that predates the routes, or one whose store is
    // not wired, both mean this account cannot approve anything.
    if (noPairing(error)) return { available: false, pairings: [] };
    throw error;
  }
}

/**
 * Approves one code for this account.
 *
 * The press is the human check: no captcha is answered here either, because the
 * device was already signed in. What it adds is consent and a binding — before
 * this, a code belongs to nobody.
 */
export async function approvePairing(
  transport: Transport,
  session: Session,
  code: string,
): Promise<PairingApproveAnswer> {
  try {
    const body = await call(transport, session.serverUrl, PAIRING_ROUTE.approve, {
      method: "POST",
      token: session.token,
      body: { code },
    });
    return {
      kind: "approved",
      account: typeof body.account === "string" ? body.account : session.email,
    };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "failed", error };
    const reason = reasonOf(error);
    if (reason !== null) return { kind: "refused", reason };
    if (noPairing(error)) return { kind: "unavailable" };
    return { kind: "failed", error };
  }
}

/**
 * Withdraws this device's credential, or somebody else's by its token.
 *
 * Sent with the device's own token in the GoogleLogin slot, which is the same
 * header every other call uses: a paired device is not a second kind of client,
 * it is the same client with a credential that can be taken away.
 */
export async function revokePairing(
  transport: Transport,
  options: { serverUrl: string; token: string; signal?: AbortSignal },
): Promise<PairingRevokeAnswer> {
  try {
    await call(transport, options.serverUrl, PAIRING_ROUTE.revoke, {
      method: "POST",
      token: options.token,
      signal: options.signal,
    });
    return { kind: "revoked" };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "failed", error };
    const reason = reasonOf(error);
    if (reason !== null) return { kind: "refused", reason };
    if (noPairing(error)) return { kind: "unavailable" };
    return { kind: "failed", error };
  }
}

/** The session a paired phone stores: same shape, its own token. */
export function pairedSession(credential: DeviceCredential, serverUrl: string): Session {
  return {
    serverUrl: normalizeServerUrl(serverUrl),
    apiPath: DEFAULT_API_PATH,
    email: credential.account,
    token: credentialSessionToken(credential),
  };
}
