/**
 * The accounts on this device, as the app holds them.
 *
 * One account is in use at a time and that is the session everything else reads:
 * `active` is the source of truth the reader is keyed on, so a switch is a
 * re-mount of the reader against the new session rather than a second client
 * living beside the first.
 *
 * Switching is a re-authentication, not a reshuffle of local state: the saved
 * token is offered to the server (`user-info`) before anything is re-pointed, and
 * an account whose sign-in the server no longer accepts stays listed and
 * un-switched-to with a line saying so. The alternative — switching first and
 * finding out on the first request — paints the other account's frame around an
 * error banner and calls it a login.
 *
 * The verifier is injected so the store can be driven in a test without a server;
 * the default is the real request.
 */

import { AuthError, HttpError, userInfo, type Session, type UserInfo } from "../api/freshrss";
import { transport } from "../api/transport";
import { loadSession } from "../api/session";
import {
  accountRows,
  forgetAccount,
  forgetEveryAccount,
  rememberAccount,
  sessionFor,
  type AccountRow,
} from "../lib/accounts";
import { accountSlug } from "../lib/account-key";

/** How a switch proves a saved session still works. */
export type VerifyAccount = (session: Session) => Promise<UserInfo>;

export class AccountsState {
  /** Every account on this device, the one in use flagged. */
  rows = $state<AccountRow[]>([]);

  /** The session in use, or null when this device holds none. */
  active = $state<Session | null>(null);

  /** Who the active account says it is, once the server has answered. */
  profile = $state<UserInfo | null>(null);

  /** The slug a switch is waiting on, or null. */
  busy = $state<string | null>(null);

  /** Why the last attempt did not happen. Cleared by the next one. */
  notice = $state("");

  private readonly verify: VerifyAccount;

  /** The account `profile` describes, so a different one cannot wear its name. */
  private profiled: string | null = null;

  constructor(verify: VerifyAccount = (session) => userInfo(transport, session)) {
    this.verify = verify;
    this.refresh();
  }

  /** The slug of the account in use, or null. */
  get activeSlug(): string | null {
    return this.active === null ? null : accountSlug(this.active);
  }

  /**
   * Signs an account in and makes it the one in use.
   *
   * Also the path a stored account takes when it is signed in again: the same
   * account keeps its place in the list and gets the token it just earned.
   */
  add(session: Session): void {
    rememberAccount(session);
    this.refresh();
    this.notice = "";
    // A client login answers with a token, not a name; the header shows the
    // address until this lands, which is why it is not awaited.
    void this.verify(session)
      .then((info) => this.noteProfile(session, info))
      .catch(() => {
        /* the address is a fine label */
      });
  }

  /**
   * Switches to a stored account, once the server still accepts its session.
   *
   * Returns whether the app is now reading as that account, so a caller that
   * needed a switch (removing the account in use, say) can tell whether it has
   * anywhere to land.
   */
  async switchTo(slug: string): Promise<boolean> {
    if (slug === this.activeSlug) return false;
    const target = sessionFor(slug);
    if (target === null) {
      this.refresh();
      this.notice = "That account is no longer stored on this device.";
      return false;
    }

    this.busy = slug;
    this.notice = "";
    let info: UserInfo;
    try {
      info = await this.verify(target);
    } catch (cause) {
      this.notice = refusal(target, cause);
      return false;
    } finally {
      this.busy = null;
    }

    rememberAccount(target);
    this.refresh();
    this.noteProfile(target, info);
    return true;
  }

  /**
   * Removes one account's sign-in. Its layout, reading preferences and chrome
   * stay on disk under its own keys — removal is about being signed in, not about
   * undoing how someone set the app up.
   *
   * Removing the account in use moves to another one first, so the app is never
   * left holding a list with no session behind it: that screen would be the login
   * form with working accounts invisible behind it.
   */
  async remove(slug: string): Promise<void> {
    const row = this.rows.find((entry) => entry.slug === slug);
    if (row === undefined) return;
    this.notice = "";
    if (row.active) {
      const next = this.rows.find((entry) => entry.slug !== slug);
      if (next !== undefined) await this.switchTo(next.slug);
    }
    forgetAccount(slug);
    this.refresh();
  }

  /** Sign out: this device forgets every account it holds a session for. */
  signOut(): void {
    forgetEveryAccount();
    this.refresh();
    this.notice = "";
  }

  /**
   * Forgets the active account's session alone.
   *
   * The launch probe uses this when the server refuses the stored token: that
   * account's sign-in is dead, and the other accounts on the device did nothing
   * wrong.
   */
  dropActive(): void {
    const slug = this.activeSlug;
    if (slug !== null) forgetAccount(slug);
    this.refresh();
  }

  /** Records what the server said about a session, if that session is still in use. */
  noteProfile(session: Session, info: UserInfo): void {
    if (this.activeSlug !== accountSlug(session)) return;
    this.profile = info;
    this.profiled = accountSlug(session);
  }

  /** Re-reads the store, so state and storage cannot drift apart. */
  private refresh(): void {
    this.active = loadSession();
    this.rows = accountRows();
    if (this.profiled !== this.activeSlug) {
      // The name belonged to the session it was fetched for.
      this.profile = null;
      this.profiled = null;
    }
  }
}

/** Why a saved session did not switch, in the terms the person reading it needs. */
function refusal(session: Session, cause: unknown): string {
  if (cause instanceof AuthError) {
    return `${session.email} was refused by ${session.serverUrl}. Remove it and add it again to sign in.`;
  }
  if (cause instanceof HttpError) {
    return `${session.serverUrl} answered ${cause.status}, so ${session.email} could not be checked.`;
  }
  return `${session.serverUrl} could not be reached, so ${session.email} was not switched to.`;
}

export const accounts = new AccountsState();
