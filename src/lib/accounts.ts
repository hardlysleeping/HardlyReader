/**
 * The accounts signed in on this device, as a list with one of them in use.
 *
 * `api/session` stores sessions; this is the policy on top of that store. Two
 * rules keep it honest, and both live here rather than being repeated at each
 * call site:
 *
 * - **The account in use is a stored session and one of the list.** Every write
 *   goes through `rememberAccount`, which upserts the list and then writes
 *   `SESSION_KEY`, in that order — so a launch that reads the store can never find
 *   a list that disagrees with the session the app is reading as.
 * - **Removing an account removes its sign-in and nothing else.** Its layout,
 *   reading preferences and chrome stay under its own keys (`lib/account-key`):
 *   those describe how someone reads, not that they are signed in, and dropping
 *   them behind a Remove button would be deleting work the user did.
 *
 * Slugs are the identity: the same server and email hash the same way every
 * time, which is what lets `sessionFor` find an account's session without ever
 * putting an address in a key.
 */

import type { Session } from "../api/freshrss";
import {
  clearSession,
  loadSession,
  readSessions,
  saveSession,
  writeSessions,
} from "../api/session";
import { accountSlug } from "./account-key";

/**
 * What the account panel shows for one account: who it is, which server, and
 * whether it is the one in use. Deliberately no token — this is the shape a
 * component may hold in reactive state.
 */
export interface AccountRow {
  /** Stable, secret-free tag for this account on this device. */
  slug: string;
  email: string;
  serverUrl: string;
  /** True for the account the app is reading as. */
  active: boolean;
}

/** The slug of the account in use, or null before sign-in. */
export function activeSlug(): string | null {
  const session = loadSession();
  return session === null ? null : accountSlug(session);
}

/**
 * Every account on this device in the order they were added, the account in use
 * first when the list was seeded from a pre-list install.
 *
 * Keyed by slug, so a list that holds two sessions for one account (an older
 * token, a re-login that was interrupted) still reads as one account.
 */
export function accountRows(): AccountRow[] {
  const active = activeSlug();
  const rows = new Map<string, AccountRow>();
  for (const session of readSessions()) {
    const slug = accountSlug(session);
    rows.set(slug, { slug, email: session.email, serverUrl: session.serverUrl, active: slug === active });
  }
  return [...rows.values()];
}

/** One account's stored session, token included, or null when it is not here. */
export function sessionFor(slug: string): Session | null {
  return readSessions().find((session) => accountSlug(session) === slug) ?? null;
}

/**
 * Makes a session the one in use and keeps it in the list.
 *
 * The list is written first and `SESSION_KEY` second: an interrupted write then
 * leaves the account listed and the session unchanged, which is a state the app
 * already knows how to draw, rather than a session nobody can find in the list.
 */
export function rememberAccount(session: Session): void {
  if (typeof localStorage === "undefined") return;
  const slug = accountSlug(session);
  const list = readSessions();
  const at = list.findIndex((entry) => accountSlug(entry) === slug);
  if (at === -1) list.push(session);
  // Replaced in place: signing the same account in again refreshes its token
  // without moving it to the bottom of the list.
  else list[at] = session;
  writeSessions(list);
  saveSession(session);
}

/** Switches to a stored account. Returns the session that is now in use. */
export function activateAccount(slug: string): Session | null {
  const target = sessionFor(slug);
  if (target === null) return null;
  rememberAccount(target);
  return target;
}

/**
 * Drops one account's stored session.
 *
 * Returns whether it was the account in use, because that is the caller's
 * decision to make: a removal that leaves the app with no session has to land
 * somewhere, and only the caller knows where.
 */
export function forgetAccount(slug: string): boolean {
  if (typeof localStorage === "undefined") return false;
  const wasActive = activeSlug() === slug;
  writeSessions(readSessions().filter((session) => accountSlug(session) !== slug));
  if (wasActive) clearSession();
  return wasActive;
}

/** Sign out: every account on this device loses its sign-in. */
export function forgetEveryAccount(): void {
  if (typeof localStorage === "undefined") return;
  writeSessions([]);
  clearSession();
}
