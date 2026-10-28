/**
 * The account's server side: the devices it is signed in on, and how it ends.
 *
 * `api/identity.ts` answers *who this is*. This file does the two things that
 * change the answer or the account: ending a session on another device (the
 * device list), and deleting the account itself. Both are server calls, because
 * both are the server's data — a client that could delete its own entitlement row
 * or another device's session on its own would be a client that can also undo
 * them.
 *
 * **What is deliberately not here.** No provider. No `iCloud`, no `Drive`, no
 * `Dropbox`, no `OneDrive`: deleting a HardlyReader account removes an identity
 * and the rows that hang off it, and the reader's own cloud folder is their
 * folder — HardlyReader put files in it, and a support request is not permission
 * to take them away. The words for the *separate* action that does delete them
 * are here (`PROVIDER_FILES_ACTION` / `PROVIDER_FILES_WARNING`) because the
 * wording has to be written before the button exists; the action itself arrives
 * with the first provider (`t_63abddf5`, `t_af52a063`). Until then there is no
 * code path from an account deletion to a folder, which the suite checks rather
 * than trusts.
 *
 * **No library either.** This module has no import from `api/local/` and no
 * reference to a store, a profile or a key. Deleting an account cannot touch the
 * posts on this device because it cannot reach them: the library is the reader's,
 * and it is the one thing an account is never allowed to take with it.
 *
 * The four calls, and the only four:
 *
 * ```
 * GET  /rest/v1/account_devices?select=…        → the devices this account is in
 * POST /rest/v1/rpc/register_device             → "this device is here now"
 * POST /rest/v1/rpc/revoke_device               → end one device's session
 * POST /rest/v1/rpc/delete_my_account           → the account, gone
 * ```
 *
 * The SQL is `supabase/schema.sql`, and the two functions are `security definer`
 * for a reason worth keeping: `auth.sessions` and `auth.users` are not writable
 * by a client, so a session cannot be revoked and an account cannot be deleted
 * without a function that acts as its owner — with `auth.uid()` deciding *whose*.
 */

import { sessionIdOf } from "./identity";

/** The network, as this file needs it. Injected so a suite needs no server. */
export type AccountFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How long one call may take before it counts as not having been answered. */
const ACCOUNT_TIMEOUT_MS = 5000;

/** Said by anything that needs an account on a device without one. */
export const NOT_SIGNED_IN = "This device is not signed in, so there is no account to ask about.";

/**
 * The sentence after a deletion, and every clause in it is a promise.
 *
 * The account and its row: gone. The library on this device: untouched. The files
 * in the reader's own cloud folder: untouched. The last clause is the one that
 * matters — a reader deleting an account has not asked for their folder to be
 * emptied, and the app must not infer that they did.
 */
export const ACCOUNT_DELETED =
  "Your HardlyReader account and its subscription record are deleted. Your library on this device is still here, and any files HardlyReader wrote to your cloud folder are still there too.";

/**
 * Why an account with a live subscription is not deleted in one press.
 *
 * Deleting the identity while Stripe still holds a card means money keeps moving
 * for an account that no longer exists: the webhook cannot even tell whose it is.
 * Cancelling is the reader's own action at the payment provider, so the app says
 * so instead of taking the money and the account at once.
 */
export const CANCEL_FIRST =
  "Your subscription is still being charged, so the account was not deleted. Cancel HardlyReader Sync first (the link is on your Stripe receipt), then come back — nothing else has changed.";

/**
 * The second action's wording, waiting for the first provider.
 *
 * Its own button, its own confirmation, and it says what it is not: not the
 * account, not the library on this device, not the rest of the folder.
 */
export const PROVIDER_FILES_ACTION = "Delete the files HardlyReader wrote to your cloud folder";

/** What that second action says before it happens. A folder is not a support ticket. */
export const PROVIDER_FILES_WARNING =
  "This is separate from deleting your account, and it is the only thing that deletes anything in your cloud folder. It removes the files HardlyReader wrote into the folder you chose — your account, your library on this device, and everything else in that folder are not touched.";

/** After a revoke: that device loses its session, and keeps everything else. */
export const DEVICE_REVOKED =
  "That device is signed out: it stops syncing the next time it checks, and it asks to sign in again. Its library is still on it, and nothing was deleted anywhere.";

/** The current device is in the list too, and revoking it is the reader signing out here. */
export const REVOKE_THIS_DEVICE =
  "This is the device you are reading on. Revoking it signs this device out the next time it checks for your subscription — your library stays exactly where it is.";

/** A device as the list draws it. `id` is the provider's `auth.sessions` row. */
export interface AccountDevice {
  readonly id: string;
  readonly label: string;
  readonly platform: string;
  readonly createdAt: number | null;
  readonly lastSeenAt: number | null;
  /** This device, recognised by the `session_id` claim of the token asking. */
  readonly current: boolean;
}

export type DeviceListResult = { ok: true; devices: AccountDevice[] } | { ok: false; reason: string };

export type DeviceResult = { ok: true; revoked: boolean } | { ok: false; reason: string };

export type DeleteOutcome = "deleted" | "cancel_first";

export type DeleteResult = { ok: true; outcome: DeleteOutcome } | { ok: false; reason: string };

/** Everything a call needs: where the project is, the publishable key, and the reader's token. */
export interface AccountOptions {
  /** `https://<ref>.supabase.co`. */
  readonly url: string;
  /** The publishable anon key. Public by design: row-level security is the protection. */
  readonly anonKey: string;
  /** The reader's access token. Never logged, never stored here — the caller holds it. */
  readonly token: string;
  readonly request?: AccountFetch;
  readonly timeoutMs?: number;
}

/**
 * The devices this account is signed in on.
 *
 * One `GET` on a table whose policy is "rows where `user_id = auth.uid()`", so the
 * list is the reader's own by construction and the query does not filter by
 * anything the client could lie about. The device this call is made from is
 * marked by comparing its `session_id` claim with the rows — the claim the server
 * would act on anyway.
 */
export async function listDevices(options: AccountOptions): Promise<DeviceListResult> {
  if (options.token.trim() === "") return { ok: false, reason: NOT_SIGNED_IN };
  const query = "select=session_id,label,platform,created_at,last_seen_at&order=last_seen_at.desc&limit=50";
  const response = await send(options, `account_devices?${query}`, { method: "GET" });
  if (response === null) return { ok: false, reason: "the server did not answer" };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "the server would not accept this session" };
  }
  if (!response.ok) return { ok: false, reason: `the server answered ${response.status}` };
  const body: unknown = await json(response);
  if (!Array.isArray(body)) return { ok: false, reason: "the answer was not a list of devices" };

  const here = sessionIdOf(options.token);
  const devices: AccountDevice[] = [];
  for (const row of body) {
    if (typeof row !== "object" || row === null) continue;
    const fields = row as Record<string, unknown>;
    const id = typeof fields.session_id === "string" ? fields.session_id : "";
    if (id === "") continue;
    devices.push({
      id,
      label: typeof fields.label === "string" ? fields.label : "",
      platform: typeof fields.platform === "string" ? fields.platform : "",
      createdAt: moment(fields.created_at),
      lastSeenAt: moment(fields.last_seen_at),
      current: here !== null && here === id,
    });
  }
  return { ok: true, devices };
}

/**
 * Says "this device is here", once per sign-in.
 *
 * The row is keyed by the session, so a second call updates the label and the
 * last-seen time rather than adding a device. Signing out ends the session, and
 * the row goes with it (the foreign key cascades) — the list is a list of
 * sessions, not a history of every device that ever installed the app.
 */
export async function registerDevice(
  options: AccountOptions,
  device: { label: string; platform: string },
): Promise<{ ok: true; sessionId: string | null } | { ok: false; reason: string }> {
  if (options.token.trim() === "") return { ok: false, reason: NOT_SIGNED_IN };
  const body = { p_label: device.label, p_platform: device.platform };
  const response = await send(options, "rpc/register_device", { method: "POST", body: JSON.stringify(body) });
  if (response === null) return { ok: false, reason: "the server did not answer" };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "the server would not accept this session" };
  }
  if (!response.ok) return { ok: false, reason: `the server answered ${response.status}` };
  return { ok: true, sessionId: sessionIdOf(options.token) };
}

/**
 * Ends one device's session.
 *
 * The session *is* the credential: the function deletes the `auth.sessions` row
 * for that id and that user, its refresh tokens go with it, and that device's
 * next `refresh()` fails — which the identity seam already turns into "signed
 * out, library untouched". A stale access token stays valid until it expires
 * (that is what a JWT is); nothing in this app acts on one without a lease on it.
 *
 * Returns `revoked: false` when the row was not there — someone else's session id,
 * or one already ended. Not an error: the caller's list was simply old.
 */
export async function revokeDevice(options: AccountOptions, sessionId: string): Promise<DeviceResult> {
  if (options.token.trim() === "") return { ok: false, reason: NOT_SIGNED_IN };
  const id = sessionId.trim();
  if (id === "") return { ok: false, reason: "no device was named" };
  const response = await send(options, "rpc/revoke_device", {
    method: "POST",
    body: JSON.stringify({ p_session: id }),
  });
  if (response === null) return { ok: false, reason: "the server did not answer" };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "the server would not accept this session" };
  }
  if (!response.ok) return { ok: false, reason: `the server answered ${response.status}` };
  return { ok: true, revoked: (await scalar(response)) === "true" };
}

/**
 * Deletes this account: the identity, the entitlement row, the customer link.
 *
 * Three outcomes, and the last one is not a failure of the network but of the
 * order of operations:
 *
 * - `deleted` — the `auth.users` row is gone; `entitlements`, `stripe_customers`
 *   and the account's sessions went with it by cascade. The caller then signs
 *   this device out locally (`identity.signOut()`), which is a local clear.
 * - `cancel_first` — the row still says the subscription is charging. See
 *   `CANCEL_FIRST`; nothing was deleted.
 * - `ok: false` — no answer, or a refusal to act for this token.
 *
 * **Nothing here names a folder, a provider or a library**, and the function it
 * calls cannot reach one: it deletes a row in `auth`, and the reader's files are
 * not in this database.
 */
export async function deleteAccount(options: AccountOptions): Promise<DeleteResult> {
  if (options.token.trim() === "") return { ok: false, reason: NOT_SIGNED_IN };
  const response = await send(options, "rpc/delete_my_account", { method: "POST", body: "{}" });
  if (response === null) return { ok: false, reason: "the server did not answer" };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "the server would not accept this session" };
  }
  if (!response.ok) return { ok: false, reason: `the server answered ${response.status}` };
  const outcome = await scalar(response);
  if (outcome === "deleted") return { ok: true, outcome: "deleted" };
  if (outcome === "cancel_first") return { ok: true, outcome: "cancel_first" };
  return { ok: false, reason: "the server did not say what it did, so nothing is claimed" };
}

/**
 * A label and a platform for one device row, from the user agent.
 *
 * Cosmetic on purpose: it is what the reader recognises their own phone by, not a
 * fingerprint, and the reader can see the same list from any device. Nothing
 * branches on it.
 */
export function describeDevice(userAgent: string): { label: string; platform: string } {
  const ua = userAgent;
  const platform = /iphone|ipad|ipod/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /windows/i.test(ua)
        ? "Windows"
        : /macintosh|mac os x/i.test(ua)
          ? "macOS"
          : /linux/i.test(ua)
            ? "Linux"
            : "This device";
  // Chrome before Safari, because every Chrome user agent says "Safari" too. A
  // WebKitGTK window (Tauri on Linux) says Safari with no Chrome beside it, so it
  // is named for the engine rather than as a browser it is not.
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /opr\//i.test(ua)
      ? "Opera"
      : /firefox/i.test(ua)
        ? "Firefox"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /safari/i.test(ua)
            ? platform === "Linux"
              ? "WebKit"
              : "Safari"
            : "";
  return {
    label: browser === "" ? platform : `${platform} · ${browser}`,
    platform,
  };
}

/* --------------------------------------------------------------------------
 * The plumbing: one endpoint shape, one timeout, one way of reading a scalar
 * ----------------------------------------------------------------------- */

function base(options: AccountOptions): string {
  return options.url.trim().replace(/\/+$/, "");
}

/**
 * One request against PostgREST, or null when it did not answer.
 *
 * Never throws: every caller here answers a reader with a sentence, and a stack
 * trace in a settings row is not a sentence. The timeout is ours because a
 * request that hangs leaves a "Revoke" press unanswered forever.
 */
async function send(options: AccountOptions, path: string, init: RequestInit): Promise<Response | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? ACCOUNT_TIMEOUT_MS);
  try {
    const call: AccountFetch = options.request ?? ((url, requestInit) => fetch(url, requestInit));
    return await call(`${base(options)}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: options.anonKey,
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: stop.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * A function's answer that is one value, not a row.
 *
 * PostgREST sends a `text` return as a JSON string and a `boolean` as `true`/
 * `false`; this reads either, and reads anything else as "" so an unexpected
 * shape never reads as a success.
 */
async function scalar(response: Response): Promise<string> {
  let text = "";
  try {
    text = (await response.text()).trim();
  } catch {
    return "";
  }
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "boolean") return String(parsed);
    return "";
  } catch {
    return "";
  }
}

/** A timestamp from a row, in milliseconds. A date Postgres cannot parse is no date. */
function moment(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
