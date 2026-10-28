/**
 * The HardlyReader account, as Settings asks about it.
 *
 * `api/identity.ts` is the seam (who is signed in, and how a door is added) and
 * `api/account.ts` is the server (the devices, and the deletion). This file is
 * the third thing a sheet needs and neither of them should own: **the state of a
 * press** — which button is in flight, what the last one said, and which device
 * rows are on screen. The component draws it; none of it decides anything new.
 *
 * Four rules, each one a way this could go wrong:
 *
 * 1. **A door being added is `link()`, never `signIn()`.** Signing in a second
 *    time is how one person ends up with two `auth.users` rows, and the purchase
 *    is attached to the first. The seam refuses it (`secondAccountRefusal`), and
 *    the surface never offers it: while signed in, the only two things offered are
 *    the doors the account does *not* have, and they call `link()`.
 * 2. **The device list is the account's, and revoking is ending a session.**
 *    Revoking the device you are reading on signs *this* device out locally
 *    (`identity.signOut()`, a storage clear) — the row is gone, so this window is
 *    signed out, and its library is exactly where it was.
 * 3. **Deleting needs two presses, and the second one may be refused.**
 *    `delete_my_account()` refuses while Stripe is still charging
 *    (`cancel_first`); that is not a failure and nothing is deleted. When the
 *    account is gone, this device signs out and `ACCOUNT_DELETED` says what is
 *    still there — the library, and the reader's own cloud folder.
 * 4. **Nothing here reaches a library, a profile or a provider's files.** This
 *    module imports the two account modules, the device-list helpers and the
 *    billing service, and nothing else on the reader's path. That is why
 *    `PROVIDER_FILES_ACTION` is not drawn: it is a separate action, and it has no
 *    implementation until the first provider exists.
 *
 * `registerOnce` is here for the same reason the device list is: a sign-in has
 * just completed, so this is the moment this device introduces itself — once per
 * session, never again on launch, and never in the way of the reader.
 */
import {
  PROVIDER_LABEL,
  identityConfig,
  identity as appIdentity,
  type Identity,
  type IdentityProvider,
  type KeyStore,
} from "../api/identity";
import {
  ACCOUNT_DELETED,
  CANCEL_FIRST,
  DEVICE_REVOKED,
  NOT_SIGNED_IN,
  REVOKE_THIS_DEVICE,
  deleteAccount,
  describeDevice,
  listDevices,
  registerDevice,
  revokeDevice,
  type AccountDevice,
  type AccountFetch,
  type AccountOptions,
} from "../api/account";
import { forgetRegisteredSession, lastSeenLabel, registerOnce } from "../lib/account-device";
import { PortalError, billingUrl, openBillingPortal } from "../api/billing";
import { openExternal } from "../lib/open-external";

/** The project, and the network: everything the account's server calls need. */
export interface CloudAccountServer {
  readonly url: string;
  readonly anonKey: string;
  /** Injected by the suite; the app uses `fetch`. */
  readonly request?: AccountFetch;
}

/** Where each half comes from. Everything has a default, so the app passes none. */
export interface CloudAccountOptions {
  /** The seam. Defaults to the app's one identity. */
  identity?: Identity;
  /** The project this build was configured with, or null. Defaults to `identityConfig()`. */
  server?: () => CloudAccountServer | null;
  /** The device list's label for this window. Defaults to `navigator.userAgent`. */
  userAgent?: () => string;
  /** The billing service, for the one link a refused deletion points at. */
  billingBase?: () => string;
  /** The billing service's network. Injected by the suite; the app uses `fetch`. */
  billingFetch?: typeof fetch;
  /** Opens a URL outside the app. Defaults to the same opener Checkout uses. */
  open?: (url: string) => Promise<void> | void;
  /** Where the "this session is registered" mark lives. Null is a suite's memory. */
  keys?: KeyStore | null;
  /** The clock, for the device list's "last seen". */
  now?: () => number;
}

/** A provider's refusal, as one line. The reason is the provider's own message. */
function refusalSentence(provider: IdentityProvider, cause: unknown): string {
  const detail =
    cause instanceof Error && cause.message !== ""
      ? cause.message
      : typeof cause === "object" && cause !== null && typeof (cause as { message?: unknown }).message === "string"
        ? (cause as { message: string }).message
        : "";
  const door = PROVIDER_LABEL[provider];
  return detail === "" ? `${door} did not answer.` : `${door}: ${detail}`;
}

/** Which press is in flight. One string, so exactly one press is disabled. */
type Press = "signIn" | "link" | "revoke" | "delete" | "portal";

export class CloudAccount {
  private readonly identity: Identity;
  private readonly server: () => CloudAccountServer | null;
  private readonly userAgent: () => string;
  private readonly billingBase: () => string;
  private readonly billingFetch: typeof fetch | undefined;
  private readonly open: (url: string) => Promise<void> | void;
  private readonly keys: KeyStore | null | undefined;
  private readonly now: () => number;

  /** Who is signed in on this device, copied from the seam after every press. */
  userId = $state<string | null>(null);
  email = $state<string | null>(null);
  /** The door this account came through, for the one sentence that names it. */
  provider = $state<IdentityProvider | null>(null);
  /** Every door into this account. Signing in again is never how this grows. */
  providers = $state<readonly IdentityProvider[]>([]);

  /** The seam's own sentence: a refusal, an expiry, or what a link started. */
  notice = $state<string | null>(null);
  /** This surface's sentence: the outcome of the press that just finished. */
  note = $state<string | null>(null);

  /** The press in flight, if any. */
  busy = $state<Press | null>(null);

  /** The account's devices, as the server last listed them. */
  devices = $state<AccountDevice[]>([]);
  /** Whether that list has been asked for on this opening, and how it went. */
  devicesState = $state<"idle" | "loading" | "failed">("idle");

  /** The two-step deletion, and the one refusal that has somewhere to go. */
  confirmingDelete = $state(false);
  /** True when a deletion was refused because Stripe is still charging. */
  needsCancel = $state(false);

  constructor(options: CloudAccountOptions = {}) {
    this.identity = options.identity ?? appIdentity;
    this.server = options.server ?? (() => identityConfig());
    this.userAgent = options.userAgent ?? (() => (typeof navigator === "undefined" ? "" : navigator.userAgent));
    this.billingBase = options.billingBase ?? billingUrl;
    this.billingFetch = options.billingFetch;
    this.open = options.open ?? openExternal;
    this.keys = options.keys;
    this.now = options.now ?? Date.now;
    this.sync();
  }

  /** Whether this device holds an account. Read it; never invent a second flag. */
  get signedIn(): boolean {
    return this.userId !== null;
  }

  /** "Google", "Apple", "an email address" — or "" on a device with no account. */
  get providerLabel(): string {
    return this.provider === null ? "" : PROVIDER_LABEL[this.provider];
  }

  /**
   * The doors this account does not have yet.
   *
   * These are the only two ways to add one, and they are `link()`. The address is
   * not in this list: changing it is a change *of* the address, confirmed from
   * both inboxes, not a fourth door.
   */
  get doorsToAdd(): readonly IdentityProvider[] {
    return (["google", "apple"] as const).filter((door) => !this.providers.includes(door));
  }

  /** Every device row, in the order the server gave them (newest first). */
  get deviceRows(): readonly AccountDevice[] {
    return this.devices;
  }

  /** When a row was last seen, in words. Read through so the panel holds no clock. */
  lastSeen(at: number | null): string {
    return lastSeenLabel(at, this.now());
  }

  /**
   * The section was opened.
   *
   * The one thing a sheet does that nothing else can: a session that arrived on
   * the redirect back from Google or Apple was written by the provider's client
   * after this app read its own storage, so a device that *has* just signed in can
   * still be holding no record. `refresh()` is the seam's answer for that — no
   * request when there is nothing to find — and it is asked here, when a person is
   * looking at the account, rather than on the launch path.
   *
   * Then the device list, which is a read and never a gate: the rows are drawn
   * when they arrive, and a failure is a sentence under them.
   */
  async opened(): Promise<void> {
    this.sync();
    if (!this.signedIn) await this.identity.refresh();
    this.sync();
    if (!this.signedIn) return;
    await this.introduce();
    await this.loadDevices();
  }

  /** A door on a signed-out device: `signIn`, exactly once. */
  async signIn(provider: IdentityProvider, email?: string): Promise<void> {
    if (this.busy !== null) return;
    this.busy = "signIn";
    this.note = null;
    try {
      // A provider error rejects on purpose: the sheet is the place it is shown.
      await this.identity.signIn(provider, email);
    } catch (cause) {
      this.note = refusalSentence(provider, cause);
    } finally {
      this.busy = null;
      this.sync();
    }
    if (!this.signedIn) return;
    // The sign-in just completed: this is the moment this device introduces
    // itself, and it is not on the reader's path — nothing awaits it.
    void this.introduce();
  }

  /**
   * A door added to the account already signed in: `link`, never `signIn`.
   *
   * The confirmation is the seam's own sentence (`linkStarted` / `EMAIL_CHANGE_SENT`)
   * once the provider has taken the door; a provider that refuses rejects, and
   * that is the sentence the sheet shows.
   */
  async link(provider: IdentityProvider, email?: string): Promise<void> {
    if (this.busy !== null) return;
    this.busy = "link";
    this.note = null;
    try {
      await this.identity.link(provider, email);
    } catch (cause) {
      this.note = refusalSentence(provider, cause);
    } finally {
      this.busy = null;
      this.sync();
    }
  }

  /** Asks the server for the device list. A failure is a sentence, not an empty list. */
  async loadDevices(): Promise<void> {
    const options = this.accountOptions();
    if (options === null) return;
    this.devicesState = "loading";
    try {
      const answer = await listDevices(options);
      if (answer.ok) {
        this.devices = answer.devices;
        this.devicesState = "idle";
        return;
      }
      this.devices = [];
      this.devicesState = "failed";
      this.note = `The device list could not be read: ${answer.reason}.`;
    } finally {
      if (this.devicesState === "loading") this.devicesState = "idle";
    }
  }

  /**
   * Ends one device's session.
   *
   * Another device: its next check signs it out, and nothing on this one changes
   * (`DEVICE_REVOKED`). This device: the row is this window's own session, so it is
   * the reader signing out here — the sentence says so (`REVOKE_THIS_DEVICE`) and
   * the local clear happens next, which is what makes it true.
   */
  async revoke(device: AccountDevice): Promise<void> {
    const options = this.accountOptions();
    if (options === null || this.busy !== null) return;
    this.busy = "revoke";
    this.note = null;
    try {
      const answer = await revokeDevice(options, device.id);
      if (!answer.ok) {
        this.note = `That device could not be signed out: ${answer.reason}.`;
        return;
      }
      if (device.current) {
        this.note = REVOKE_THIS_DEVICE;
        await this.identity.signOut();
        this.signOutCleared();
        return;
      }
      this.note = DEVICE_REVOKED;
      // The row was there: the list on screen is now one row older.
      this.devices = this.devices.filter((row) => row.id !== device.id);
    } finally {
      this.busy = null;
    }
  }

  /** The first press of the two: nothing is sent, and the sentence appears. */
  askDelete(): void {
    this.confirmingDelete = true;
    this.needsCancel = false;
    this.note = null;
  }

  /** The way out of the second step. Nothing was sent, so nothing has to be undone. */
  cancelDelete(): void {
    this.confirmingDelete = false;
  }

  /**
   * The second press: the account, gone — or refused, with nothing changed.
   *
   * `cancel_first` is not an error: the row is still there, Stripe is still
   * charging, and the reader has to cancel that first. `needsCancel` is what makes
   * the sheet offer the portal; it is a state rather than a string comparison, so a
   * change of wording cannot silently remove the button.
   */
  async confirmDelete(): Promise<void> {
    const options = this.accountOptions();
    if (options === null || this.busy !== null) {
      this.note = NOT_SIGNED_IN;
      return;
    }
    this.busy = "delete";
    this.note = null;
    this.needsCancel = false;
    try {
      const answer = await deleteAccount(options);
      if (!answer.ok) {
        this.note = `The account was not deleted: ${answer.reason}. Nothing has changed.`;
        return;
      }
      if (answer.outcome === "cancel_first") {
        this.confirmingDelete = false;
        this.needsCancel = true;
        this.note = CANCEL_FIRST;
        return;
      }
      // The identity is gone on the server, so this device must not keep holding
      // it: a local clear, and the sentence says what a deletion does not touch.
      this.confirmingDelete = false;
      this.note = ACCOUNT_DELETED;
      await this.identity.signOut();
      this.signOutCleared();
    } finally {
      this.busy = null;
    }
  }

  /**
   * Where a refused deletion sends the reader: the payment provider's own page.
   *
   * The service makes the URL for the customer the token names, so this cannot
   * open somebody else's subscription. A reader who has no customer there is told
   * that plainly — it means there is nothing left to cancel, and pressing delete
   * again will work.
   */
  async manageSubscription(): Promise<void> {
    const token = this.identity.token;
    if (token === null || token === "") {
      this.note = NOT_SIGNED_IN;
      return;
    }
    if (this.busy !== null) return;
    this.busy = "portal";
    try {
      await openBillingPortal({
        token,
        base: this.billingBase(),
        open: this.open,
        ...(this.billingFetch === undefined ? {} : { fetch: this.billingFetch }),
      });
      this.note = PORTAL_OPENED;
    } catch (cause) {
      this.note = cause instanceof PortalError && cause.code === "no_customer" ? NO_CUSTOMER : PORTAL_FAILED;
    } finally {
      this.busy = null;
    }
  }

  /* -------------------------------------------------------------------------
   * The plumbing
   * ---------------------------------------------------------------------- */

  /** Copies the seam's answers onto this surface. Called after every press. */
  private sync(): void {
    this.userId = this.identity.userId;
    this.email = this.identity.email;
    this.provider = this.identity.provider;
    this.providers = this.identity.providers;
    this.notice = this.identity.notice;
    if (this.userId === null) {
      this.devices = [];
      this.devicesState = "idle";
      this.confirmingDelete = false;
      this.needsCancel = false;
    }
  }

  /** After a local sign-out: the mark goes with the session it named. */
  private signOutCleared(): void {
    forgetRegisteredSession(this.keys);
    this.sync();
  }

  /** The four calls' shared options, or null when this build cannot make them. */
  private accountOptions(): AccountOptions | null {
    const server = this.server();
    const token = this.identity.token;
    if (server === null || token === null || token === "") return null;
    return {
      url: server.url,
      anonKey: server.anonKey,
      token,
      ...(server.request === undefined ? {} : { request: server.request }),
    };
  }

  /**
   * "This device is here now", once per sign-in.
   *
   * `registerOnce` holds the mark, so a page reload with the same session asks the
   * server nothing and a session that has changed is registered once. The failure
   * case is the useful one: offline at the wrong moment leaves no mark, so the next
   * opening tries again rather than the row being missing forever.
   */
  private async introduce(): Promise<void> {
    const options = this.accountOptions();
    const session = this.identity.sessionId;
    if (options === null || session === null) return;
    const label = describeDevice(this.userAgent());
    await registerOnce({
      sessionId: session,
      register: () => registerDevice(options, label),
      keys: this.keys,
    });
  }
}

/** Said when the browser has the payment page and the app does not. */
export const PORTAL_OPENED =
  "The payment page is open in your browser. Cancel there, come back, and delete the account — nothing here has changed yet.";

/** What a reader with no customer at the payment provider is told. */
export const NO_CUSTOMER = "There is no subscription at the payment provider for this account, so there is nothing to cancel.";

/** The payment page could not be opened. One sentence, and the sentence above still holds. */
export const PORTAL_FAILED = "The payment page could not be opened. Try again in a moment.";


/** The app's one account surface. A build with no project holds a signed-out one. */
export const cloudAccount = new CloudAccount();
