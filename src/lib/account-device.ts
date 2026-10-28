/**
 * This device, in the account's device list.
 *
 * Two small things that belong to the device list rather than to the account
 * server, and both are about the same question — *is this row the window I am
 * reading in?*
 *
 * 1. **`registerOnce`** writes this device's row exactly once per sign-in. The
 *    account server keys a device by its session, so a second call for the same
 *    session is a wasted request and a second row is impossible anyway; the mark
 *    kept here is what makes "once" true across a page reload, where the session
 *    is the same sign-in and nothing has changed. It is deliberately *not* called
 *    at launch: a device that was registered when it signed in asks the server
 *    nothing on the hundred launches that follow.
 *    A failed registration leaves no mark, so the next time the sheet is opened
 *    it is tried again — a row nobody can see in their own device list is a small
 *    lie, and retrying it is one request.
 *
 * 2. **`lastSeenLabel`** turns the row's timestamp into a phrase. Cosmetic on
 *    purpose: it is what a person recognises their own phone by, and the same
 *    list is drawn on every device, so nothing branches on it.
 */
import { deviceKeys, type KeyStore } from "../api/identity";

/** Where the session this device registered under is written. One key, like the others. */
export const DEVICE_MARK_KEY = "hardlyreader.device.v1";

/** What `registerOnce` did, so a caller can tell "already" from "failed". */
export type RegisterOutcome =
  /** The server took the row. */
  | "registered"
  /** This session was registered before, so nothing was asked. */
  | "already"
  /** There is no session to register — a device with no account. */
  | "no_session"
  /** The call was made and did not land. No mark is kept, so it is retried. */
  | "failed";

export interface RegisterOnceOptions {
  /** The provider session this device is signed in under, from the token's claim. */
  sessionId: string | null;
  /** The call itself: `registerDevice(...)` with this device's label and platform. */
  register: () => Promise<{ ok: boolean }>;
  /** Where the mark lives. Null means memory only, which is a suite. */
  keys?: KeyStore | null;
}

/** The session this device last registered under, or null. */
export function registeredSession(keys: KeyStore | null = deviceKeys()): string | null {
  if (keys === null) return null;
  try {
    const value = keys.getItem(DEVICE_MARK_KEY);
    return value !== null && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Forgets the mark. Signing out ends the session, so its row is gone with it. */
export function forgetRegisteredSession(keys: KeyStore | null = deviceKeys()): void {
  if (keys === null) return;
  try {
    keys.removeItem(DEVICE_MARK_KEY);
  } catch {
    /* see `writeIdentityRecord`: a store that refuses loses only the memory */
  }
}

/**
 * Registers this device for the session it is signed in under, once.
 *
 * Never throws: the caller is a sheet that must keep drawing, and a device list
 * that could not be extended is not a reason to leave a reader staring at a
 * spinner. A `null` session is a device with no account, and nothing is asked.
 */
export async function registerOnce(options: RegisterOnceOptions): Promise<RegisterOutcome> {
  const session = options.sessionId;
  if (session === null || session === "") return "no_session";
  const keys = options.keys === undefined ? deviceKeys() : options.keys;
  if (registeredSession(keys) === session) return "already";

  let ok = false;
  try {
    ok = (await options.register()).ok;
  } catch {
    ok = false;
  }
  if (!ok) return "failed";
  if (keys !== null) {
    try {
      keys.setItem(DEVICE_MARK_KEY, session);
    } catch {
      /* this window still has the row; the next one will ask again */
    }
  }
  return "registered";
}

/**
 * When a device was last seen, in words.
 *
 * A minute, an hour, a day: the three units a person uses about their own phones.
 * Anything older is a date, because "43 days ago" is arithmetic nobody asked for.
 * A timestamp in the future is "just now" rather than a negative age — a device
 * whose clock is wrong is not a device from the future.
 */
export function lastSeenLabel(at: number | null, now = Date.now()): string {
  if (at === null) return "not seen yet";
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
