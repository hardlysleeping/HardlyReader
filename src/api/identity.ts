/**
 * An account, and when there is one.
 *
 * Owner decision (2026-10-27): one identity, shared by every platform, so a
 * purchase follows the reader instead of the device. Supabase Auth is the
 * provider — Google, Apple, and an emailed link as the fallback for anyone who
 * wants neither. `docs/accounts-and-entitlements.md` is the reasoning; this file
 * is the seam.
 *
 * Three rules, and this file exists mostly to keep them:
 *
 * 1. **An account is created on demand, never at launch.** Nothing here runs on
 *    the launch path, and no reading path imports this module: a local library
 *    and a FreshRSS profile both work with `userId === null`, forever. Signing
 *    in is something Settings asks for, not something the app does to you.
 * 2. **A token is a convenience, not a requirement.** `restore()` is a storage
 *    read; `refresh()` is the only call that touches the network, and a refresh
 *    that fails means *signed out* — never a broken reader, never a touched
 *    library. That is why `refresh()` does not throw: a resume handler and a
 *    settings row both call it, and neither has anywhere to put an exception.
 * 3. **The service key never ships.** The build is handed a project URL and the
 *    *anon* key, both public by design and protected by row-level security. A
 *    key that decodes to `role: service_role` is refused here, by name, before a
 *    client exists — the one way to lose the whole database is to let that key
 *    into a bundle, and a check that costs microseconds is worth having in front
 *    of the mistake.
 *
 * The device keeps its record where the session already lives: `localStorage`,
 * beside `hardlyreader.session`. Same store, same guards, same "no localStorage
 * means no persistence" behaviour — a token in a second, cleverer place would be
 * a second place to forget to clear. The *library* is what is per profile
 * (`lib/account-key`); sign-in and sign-out never touch it, and they never touch
 * a profile's layout, prefs, pins or caches either.
 *
 * `FakeIdentity` is the suite's: it signs in, rotates a token, refuses a refresh
 * and signs out, all in memory, and records the calls so a suite can prove what
 * did *not* happen. `SupabaseIdentity` is the thin real one, behind
 * `@supabase/supabase-js`, and the only file in `src/` that names the package.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The three doors into one account. Email is the fallback, not a fourth identity. */
export type IdentityProvider = "google" | "apple" | "email";

/** The doors, in the order a sign-in sheet draws them. */
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ["google", "apple", "email"];

/** The doors by the name a person uses for them, for one sentence in a sheet. */
export const PROVIDER_LABEL: Record<IdentityProvider, string> = {
  google: "Google",
  apple: "Apple",
  email: "an email address",
};

/** Whether a value names a door this app offers. */
export function isProvider(value: unknown): value is IdentityProvider {
  return value === "google" || value === "apple" || value === "email";
}

/**
 * The sentence a sheet shows when someone tries to sign in a second time.
 *
 * A second sign-in is how one person ends up with two `auth.users` rows, and a
 * second row means the entitlement they paid for is attached to the other one:
 * the app would then have to say "no subscription" to a reader who has one. So
 * the refusal lives here, in the seam, rather than in whichever screen remembers
 * to check.
 */
export function secondAccountRefusal(provider: IdentityProvider): string {
  return `This device is already signed in. Add ${PROVIDER_LABEL[provider]} to the account you have instead of signing in again — a second sign-in is how one person ends up with two accounts.`;
}

/** What a link attempt is called while the provider has not answered yet. */
export const LINK_NEEDS_AN_ACCOUNT =
  "There is no account on this device to add a second sign-in method to. Sign in first.";

/** A confirmation travels by email, so the account changes only after both inboxes answer. */
export const EMAIL_CHANGE_SENT =
  "Check your inbox: the change needs confirming from the old address and the new one before it happens. Until then this account is unchanged.";

/** The browser is at the provider, and the account is the same one on the way back. */
export function linkStarted(provider: IdentityProvider): string {
  return `Your browser is open at ${PROVIDER_LABEL[provider]}. Come back when it is done — it is still this same account and subscription.`;
}

/**
 * What a signed-in device holds.
 *
 * A record, not a `Session`: there is no server URL and no API path, because an
 * account is not a library. `token` is the access token the entitlement call is
 * made with; `expiresAt` is when it stops being enough, in milliseconds, or null
 * when the provider does not say.
 */
export interface IdentityRecord {
  readonly userId: string;
  readonly token: string;
  /** Whose account it is, for the one row that names them. Never required. */
  readonly email: string | null;
  /** Which door it came through, so a sheet can say "signed in with Google". */
  readonly provider: IdentityProvider;
  readonly expiresAt: number | null;
  /**
   * Every door into this account, as the provider last listed them.
   *
   * Absent on a record written before linking existed, and absent when the
   * provider did not say — which is why the getter falls back to the one door
   * that *is* known rather than pretending the list is complete. Linking writes
   * it; nothing else does, and it is never a reason to refuse a sign-in.
   */
  readonly providers?: readonly IdentityProvider[];
}

/**
 * The seam. Everything above this line is a reader that must not know it exists.
 *
 * `userId` and `token` are the whole state — both null is *no account*, which is
 * the normal condition of this app and not a problem to fix.
 */
export interface Identity {
  readonly userId: string | null;
  readonly token: string | null;
  /** The address the account answers to, when there is one. */
  readonly email: string | null;
  /**
   * Which door this device signed in through, or null with no account.
   *
   * "Signed in with Google" is this value and nothing else. It is the door that
   * was pressed here, not a list: `providers` is the list, and the difference is
   * the whole of "add a door" — the account came through one of them and answers
   * to all of them.
   */
  readonly provider: IdentityProvider | null;
  /**
   * Every door into this account — at least the one this device signed in
   * through. Empty when there is no account.
   */
  readonly providers: readonly IdentityProvider[];
  /**
   * The provider session this device is signed in under.
   *
   * Read from the token's own `session_id` claim, which is the row in
   * `auth.sessions`: that is what a device list shows and what revoking ends.
   * Null on a device with no account, and on any token that does not carry one.
   */
  readonly sessionId: string | null;
  /** Why the last attempt did not happen, in one sentence. Null when nothing is wrong. */
  readonly notice: string | null;
  signIn(provider: IdentityProvider, email?: string): Promise<void>;
  /**
   * Adds a door to the account already signed in on this device.
   *
   * The whole point of the method: a reader who paid with Google and then wants
   * to use Apple on their phone links Apple to the account they have, rather
   * than signing in again and paying twice. The account is one `auth.users` row
   * before and after, so the entitlement row — keyed by that id — is the same
   * row. `email` addresses a change of address, which needs confirming from both
   * inboxes and is not a second account either.
   *
   * Refuses, with a sentence, when there is no account to link to, and rejects
   * when the provider refuses — a sheet that started this has somewhere to show
   * the reason.
   */
  link(provider: IdentityProvider, email?: string): Promise<void>;
  signOut(): Promise<void>;
  /** Renews the token. Never throws: a refusal is `signed out`. */
  refresh(): Promise<void>;
  /** Re-reads the stored record. Storage only: no network, safe on any path. */
  restore(): void;
  /** Refreshes on return to the window, when there is a token to renew. Returns its teardown. */
  watch(): () => void;
}

/** Where a device's identity is written. One key, like the session's. */
export const IDENTITY_KEY = "hardlyreader.identity.v1";

/** The part of `Storage` these helpers use, so a stub can stand in for it. */
export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The device's own storage, or null where there is none.
 *
 * `localStorage` throws in some privacy modes as well as being absent under
 * Node, and a reader with no persistence must still run — so this answers null
 * and the identity simply does not outlive the window.
 */
export function deviceKeys(): KeyStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The stored record, normalised.
 *
 * Anything unrecognisable is dropped rather than half-believed: a record with no
 * user id or no token is not a signed-in device, and one naming a provider this
 * app does not offer is not a record it can act on. The key is removed with it —
 * the same choice `api/session.ts` makes — so a corrupt blob is not re-parsed on
 * every launch for the rest of the install's life.
 */
export function readIdentityRecord(keys: KeyStore | null = deviceKeys()): IdentityRecord | null {
  if (keys === null) return null;
  let raw: string | null = null;
  try {
    raw = keys.getItem(IDENTITY_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const record = parseIdentityRecord(JSON.parse(raw) as unknown);
    if (record !== null) return record;
  } catch {
    /* fall through and discard */
  }
  try {
    keys.removeItem(IDENTITY_KEY);
  } catch {
    /* a store that refuses the removal is a store that will refuse the next write too */
  }
  return null;
}

/** One stored value, read back as a record or as nothing. */
export function parseIdentityRecord(value: unknown): IdentityRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = value as Partial<IdentityRecord>;
  if (typeof parsed.userId !== "string" || parsed.userId === "") return null;
  if (typeof parsed.token !== "string" || parsed.token === "") return null;
  const provider = parsed.provider;
  if (!isProvider(provider)) return null;
  const base: IdentityRecord = {
    userId: parsed.userId,
    token: parsed.token,
    email: typeof parsed.email === "string" && parsed.email !== "" ? parsed.email : null,
    provider,
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
  };
  // A list this app cannot read is dropped rather than half-believed, and an
  // absent one stays absent: the getter then answers with the one door it knows.
  const listed = Array.isArray(parsed.providers) ? parsed.providers.filter(isProvider) : [];
  return listed.length === 0 ? base : { ...base, providers: listed };
}

/**
 * The provider session a token belongs to, from its own `session_id` claim.
 *
 * Supabase puts the `auth.sessions` row's id in every access token. That id is
 * what a device list draws and what revoking deletes, so a device can recognise
 * its own row without the server being asked who it is. Read without believing
 * it: nothing here verifies a signature, and nothing needs to — the server is
 * what acts on the claim, and a forged claim is a claim about a session the
 * forger does not hold.
 */
export function sessionIdOf(token: string | null): string | null {
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeSegment(parts[1])) as { session_id?: unknown };
    return typeof payload.session_id === "string" && payload.session_id !== "" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** Writes the record. A store that is full or blocked loses only the persistence. */
export function writeIdentityRecord(record: IdentityRecord, keys: KeyStore | null = deviceKeys()): void {
  if (keys === null) return;
  try {
    keys.setItem(IDENTITY_KEY, JSON.stringify(record));
  } catch {
    /* This window still knows who it is; the next launch will not. */
  }
}

/** Removes the record, and nothing else. */
export function clearIdentityRecord(keys: KeyStore | null = deviceKeys()): void {
  if (keys === null) return;
  try {
    keys.removeItem(IDENTITY_KEY);
  } catch {
    /* see `writeIdentityRecord` */
  }
}

/**
 * The state half of an identity: one record, its storage, and the rules that
 * keep "signed out" and "broken" from being the same thing.
 *
 * Both real implementations extend this, so neither can invent its own opinion
 * about what a failed refresh does. `adopt()` and `clear()` are the only writers
 * of `record`, which is what makes "the library is untouched" a property of the
 * shape rather than a promise in a comment: this class has no reference to a
 * store, a profile or a session, and cannot reach one.
 */
export abstract class StoredIdentity implements Identity {
  /** Where the record is written. Null in a suite that wants memory only. */
  protected readonly keys: KeyStore | null;

  /** The record as this window holds it. Null is *no account*. */
  protected record: IdentityRecord | null = null;

  /** The sentence the last attempt left behind. Written by every subclass, read by the sheet. */
  protected reason: string | null = null;

  constructor(keys: KeyStore | null = deviceKeys()) {
    this.keys = keys;
    this.restore();
  }

  get userId(): string | null {
    return this.record === null ? null : this.record.userId;
  }

  get token(): string | null {
    return this.record === null ? null : this.record.token;
  }

  get email(): string | null {
    return this.record === null ? null : this.record.email;
  }

  /**
   * Every door into this account.
   *
   * The record's list when the provider gave one, and the door this device came
   * through otherwise — never an empty list while signed in, because "signed in"
   * itself proves one door exists.
   */
  get providers(): readonly IdentityProvider[] {
    if (this.record === null) return [];
    const listed = this.record.providers ?? [];
    return listed.length === 0 ? [this.record.provider] : listed;
  }

  /** The session this device holds, from the token's `session_id` claim. */
  get sessionId(): string | null {
    return this.record === null ? null : sessionIdOf(this.record.token);
  }

  /** Which door this account came through, or null. */
  get provider(): IdentityProvider | null {
    return this.record === null ? null : this.record.provider;
  }

  /** Whether this device holds an account at all. Read it; do not invent a second flag. */
  get signedIn(): boolean {
    return this.record !== null;
  }

  get notice(): string | null {
    return this.reason;
  }

  /** Storage, never network. The launch path may call this. */
  restore(): void {
    this.record = readIdentityRecord(this.keys);
  }

  abstract signIn(provider: IdentityProvider, email?: string): Promise<void>;

  abstract refresh(): Promise<void>;

  /**
   * Adds a door to the account this device is already signed in under.
   *
   * The two refusals that belong to the seam rather than to a screen: there is
   * no account to link to, or the provider will not take the door. The provider
   * call itself is `linkDoor`, so the real client and the suite differ in one
   * method rather than in what linking means.
   */
  async link(provider: IdentityProvider, email?: string): Promise<void> {
    if (this.record === null) {
      this.reason = LINK_NEEDS_AN_ACCOUNT;
      return;
    }
    this.reason = null;
    await this.linkDoor(provider, email);
  }

  /** The provider call a link makes. Rejecting is the provider's refusal, shown by the sheet. */
  protected abstract linkDoor(provider: IdentityProvider, email?: string): Promise<void>;

  /**
   * Whether a sign-in must be refused because this device already has an account.
   *
   * True means the reason has been written and the caller must stop: a second
   * sign-in while signed in is how one reader becomes two `auth.users` rows, with
   * the purchase attached to the row they are no longer using. The same door
   * again is allowed — that is re-authenticating the account that is already
   * here, not creating a second one.
   */
  protected refuseASecondAccount(provider: IdentityProvider): boolean {
    if (this.record === null) return false;
    if (this.record.provider === provider) return false;
    this.reason = secondAccountRefusal(provider);
    return true;
  }

  /**
   * Signing out forgets the account on this device, and does nothing else.
   *
   * No deletion, no lock, no "your library is read-only now": the posts on this
   * device are the reader's own, and not paying for sync — or simply wanting a
   * different account — does not make them hostages.
   */
  async signOut(): Promise<void> {
    // The provider is told first, so the session row and its refresh token go
    // with this device — a signed-out device that stayed listed in the reader's
    // own device list would be a lie. A provider that will not answer is not a
    // reason to keep this device signed in: the local clear happens either way.
    try {
      await this.endSession();
    } catch {
      /* the record is being removed regardless; the server drops the session on its own schedule */
    }
    this.clear(null);
  }

  /**
   * Ends the provider session, if this identity has one.
   *
   * **This device's session only.** `supabase-js` signs out with a *global*
   * scope by default, which revokes every session the reader has — signing out
   * on a phone would silently sign out the laptop, and the device list would
   * never show a second row to revoke. The real implementation passes
   * `scope: "local"`; the suite records that it did.
   */
  protected async endSession(): Promise<void> {}

  /**
   * Renews the token when the window comes back, and only then.
   *
   * A window left open for a week is the normal case on a desktop, and an access
   * token lasts an hour. The listener is installed by whoever wants identity to
   * stay live; the app installs one at launch, and it costs nothing until the
   * first return to the window. A device with no account installs the same
   * listener and refreshes nothing.
   */
  watch(target: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null = typeof document === "undefined" ? null : document): () => void {
    if (target === null) return () => {};
    const onReturn = (): void => {
      if (target.visibilityState !== "visible") return;
      // No account, no request. This is the whole of rule 1 on the resume path.
      if (this.record === null) return;
      void this.refresh();
    };
    target.addEventListener("visibilitychange", onReturn);
    return () => target.removeEventListener("visibilitychange", onReturn);
  }

  /** Takes the record as the account in use. The only way in. */
  protected adopt(record: IdentityRecord, notice: string | null = null): void {
    this.record = record;
    writeIdentityRecord(record, this.keys);
    this.reason = notice;
  }

  /** Forgets it. The only way out, and it touches this key alone. */
  protected clear(notice: string | null): void {
    this.record = null;
    clearIdentityRecord(this.keys);
    this.reason = notice;
  }
}

/**
 * A build with no identity provider configured.
 *
 * A browser tab served from a build without `.env` values, a `pnpm dev` session
 * with no project, the test harness: all of them are this, and all of them work.
 * Signing in says so in one sentence instead of throwing, because a settings row
 * has room for a sentence and no room for a stack trace — and refusing by name is
 * the difference between "this build has no sign-in" and "sign-in failed".
 */
export class NoIdentity extends StoredIdentity {
  constructor(keys: KeyStore | null = deviceKeys()) {
    super(keys);
  }

  async signIn(): Promise<void> {
    this.reason = "This build has no sign-in provider configured, so an account cannot be created here.";
  }

  async refresh(): Promise<void> {
    // There is nothing to renew and nothing to say: this build never had an
    // account, and a resume is not the moment to explain that again.
  }

  /** Nothing can be linked on a build that cannot sign in, and it says so by name. */
  protected async linkDoor(): Promise<void> {
    this.reason = "This build has no sign-in provider configured, so there is no second sign-in method to add.";
  }
}

/**
 * A token shaped like the provider's, so the suite can read claims without a
 * provider.
 *
 * **Suite only.** It is signed by nobody, and nothing in this app treats a claim
 * as proof: `sessionIdOf` reads `session_id` to recognise this device in a device
 * list, and the server is what acts on it.
 */
export function fakeToken(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.not-signed`;
}

/** How the suite drives an account, without a provider or a network. */
export interface FakeIdentityOptions {
  /** Where the record lives. A plain object makes "restart" two instances over one store. */
  keys?: KeyStore | null;
  /** A record a previous launch left on the device. */
  record?: IdentityRecord | null;
  /** Whether the next refresh is refused, the way an expired refresh token is. */
  failRefresh?: boolean;
  /** Whether the provider refuses to add a door, the way an identity already linked elsewhere does. */
  failLink?: boolean;
}

/**
 * The identity a suite uses.
 *
 * It signs in as any of the three doors, hands back a token, rotates it on
 * refresh, refuses a refresh on demand and signs out — and it records every call,
 * so a suite can assert the absence of one (no `refresh` at launch, no request
 * for a signed-out device) rather than only the presence.
 *
 * Linking is modelled the way the provider does it: the account keeps its id and
 * its session, and gains a door. A token carries a `session_id` claim, because
 * the device list is keyed by it.
 */
export class FakeIdentity extends StoredIdentity {
  /** Every method this identity was asked for, in order: `signIn:google`, `refresh`, `signOut`. */
  calls: string[] = [];

  /** A refresh that fails, as an expired refresh token does. Set back to false to recover. */
  failRefresh: boolean;

  /** A link the provider refuses. */
  failLink: boolean;

  private issued = 0;

  /** The provider session this device is in, one per sign-in and kept across refreshes. */
  private session: string | null = null;

  constructor(options: FakeIdentityOptions = {}) {
    super(options.keys === undefined ? null : options.keys);
    this.failRefresh = options.failRefresh === true;
    this.failLink = options.failLink === true;
    const seeded = options.record ?? null;
    if (seeded !== null) {
      this.adopt(seeded);
      this.session = sessionIdOf(seeded.token);
    }
  }

  async signIn(provider: IdentityProvider, email?: string): Promise<void> {
    if (this.refuseASecondAccount(provider)) {
      this.calls.push(`signInRefused:${provider}`);
      return;
    }
    this.calls.push(`signIn:${provider}`);
    const address = (email ?? "").trim();
    if (provider === "email" && address === "") {
      this.reason = "An emailed sign-in link needs an address to send it to.";
      return;
    }
    this.issued += 1;
    const userId = `fake-${provider}-user`;
    this.session = `fake-session-${this.issued}`;
    this.adopt({
      userId,
      token: fakeToken({ sub: userId, session_id: this.session }),
      email: address === "" ? `${provider}@fixture.test` : address,
      provider,
      expiresAt: null,
      providers: [provider],
    });
  }

  async refresh(): Promise<void> {
    this.calls.push("refresh");
    if (this.record === null) return;
    if (this.failRefresh) {
      // Signed out, not broken: the message says where the library is.
      this.clear("Your sign-in has expired. Sign in again to sync. Nothing in your library was touched.");
      return;
    }
    this.issued += 1;
    const session = sessionIdOf(this.record.token) ?? this.session ?? `fake-session-${this.issued}`;
    this.adopt({
      ...this.record,
      token: fakeToken({ sub: this.record.userId, session_id: session, issued: this.issued }),
    });
  }

  /**
   * Adds a door: the same account, the same session, one more way in.
   *
   * Nothing about the id changes, which is the property the whole card rests on —
   * the entitlement row is keyed by that id and a link must not move it.
   */
  protected async linkDoor(provider: IdentityProvider, email?: string): Promise<void> {
    this.calls.push(`link:${provider}`);
    if (this.failLink) throw new Error(`${provider} is already linked to another account`);
    const record = this.record;
    if (record === null) return;
    const address = (email ?? "").trim();
    if (provider === "email" && address === "") {
      this.reason = "An emailed sign-in link needs an address to send it to.";
      return;
    }
    const doors = record.providers ?? [record.provider];
    this.adopt({
      ...record,
      email: provider === "email" && address !== "" ? address : record.email,
      providers: doors.includes(provider) ? doors : [...doors, provider],
    });
    this.reason = provider === "email" ? EMAIL_CHANGE_SENT : linkStarted(provider);
  }

  /** Ends this device's session, as the provider does — one session, not all of them. */
  protected async endSession(): Promise<void> {
    this.calls.push("endSession");
  }

  async signOut(): Promise<void> {
    this.calls.push("signOut");
    await super.signOut();
  }
}

/**
 * The real one, as thin as the package allows.
 *
 * Everything specific to Supabase lives in `signIn` and `refresh`: which call
 * each door makes, and how a session becomes a record. The rules about what a
 * failure means are in the base class, so a change of provider is a change to
 * two methods rather than to the behaviour of the app.
 *
 * `autoRefreshToken` is off on purpose. A background timer renewing a token is a
 * network call nobody asked for; refresh is ours, and it happens on return to
 * the window or when a caller asks for it.
 */
export interface SupabaseIdentityOptions {
  readonly client: SupabaseClient;
  /** Where to send the window for Google and Apple. The shell supplies its own; a browser uses the default. */
  readonly navigate?: (url: string) => void;
  /** Where the provider returns to. Null lets the project's Site URL decide. */
  readonly redirectTo?: string | null;
  readonly keys?: KeyStore | null;
}

export class SupabaseIdentity extends StoredIdentity {
  private readonly client: SupabaseClient;
  private readonly navigate: (url: string) => void;
  private readonly redirectTo: string | null;

  /**
   * The door a sign-in is currently going through.
   *
   * A record that arrives from `getSession()` knows the account and the token but
   * not which button was pressed, so the door has to be remembered across the
   * round trip — otherwise every account would be filed as having come through
   * email, which is the fallback and therefore the wrong answer for two of the
   * three.
   */
  private pending: IdentityProvider | null = null;

  constructor(options: SupabaseIdentityOptions) {
    super(options.keys === undefined ? deviceKeys() : options.keys);
    this.client = options.client;
    this.navigate = options.navigate ?? ((url) => {
      if (typeof location !== "undefined") location.assign(url);
    });
    this.redirectTo = options.redirectTo ?? null;
  }

  /**
   * Starts a sign-in.
   *
   * Google and Apple leave the window — the provider's page is the only place a
   * password is ever typed — so the record arrives on the way back, through
   * `adoptFromClient()`. Email sends a link and does the same. A provider error
   * rejects, because the sheet that started this has somewhere to show it; a
   * *refresh* failure does not, because a resume handler does not.
   */
  async signIn(provider: IdentityProvider, email?: string): Promise<void> {
    if (this.refuseASecondAccount(provider)) return;
    this.reason = null;
    this.pending = provider;
    if (provider === "email") {
      const address = (email ?? "").trim();
      if (address === "") {
        this.reason = "An emailed sign-in link needs an address to send it to.";
        return;
      }
      const { error } = await this.client.auth.signInWithOtp({
        email: address,
        ...(this.redirectTo === null ? {} : { options: { emailRedirectTo: this.redirectTo } }),
      });
      if (error !== null) throw new Error(`the sign-in link could not be sent: ${messageOf(error)}`);
      this.reason = "Check your email for the link. It signs this device in when you open it.";
      await this.adoptFromClient();
      return;
    }

    const { data, error } = await this.client.auth.signInWithOAuth({
      provider,
      options: {
        // The window is sent there by `navigate`, so the SDK must not try too.
        skipBrowserRedirect: true,
        ...(this.redirectTo === null ? {} : { redirectTo: this.redirectTo }),
      },
    });
    if (error !== null) throw new Error(`${provider} sign-in could not start: ${messageOf(error)}`);
    const url = (data as { url?: string | null } | null)?.url ?? null;
    if (url !== null) this.navigate(url);
    // A window that has just been sent to the provider has no session yet; a
    // caller in a test, or a shell that signs in headlessly, does.
    await this.adoptFromClient();
  }

  /**
   * Renews the token, or signs this device out.
   *
   * Never throws. An expired refresh token, an offline laptop and a provider
   * outage all land in the same place — no account on this device, a sentence
   * saying so, and a library that does not notice.
   *
   * With no record yet it is a **storage read, not a renewal**: the redirect back
   * from Google or Apple is picked up by `supabase-js`'s own `detectSessionInUrl`,
   * which runs after this app read its storage, so the record a return needs does
   * not exist until somebody asks the client. A device with nothing stored answers
   * `{ session: null }` and no request is made, which is why this is only asked
   * for from the account sheet — never from the launch path.
   */
  async refresh(): Promise<void> {
    if (this.record === null) {
      await this.adoptFromClient();
      return;
    }
    try {
      const { data, error } = await this.client.auth.refreshSession();
      if (error !== null) throw error;
      const session = (data as { session?: SupabaseSessionLike | null } | null)?.session ?? null;
      if (session === null) {
        this.clear("Your sign-in has ended. Sign in again to sync. Nothing in your library was touched.");
        return;
      }
      this.adopt(sessionRecord(session, this.record.provider));
    } catch (cause) {
      this.clear(
        `Your sign-in could not be renewed (${messageOf(cause)}), so this device is signed out. Your library is untouched.`,
      );
    }
  }

  /**
   * Adds a door to the account already signed in here.
   *
   * `linkIdentity` for Google and Apple: the browser goes to the provider and
   * comes back with the identity attached to **this** user, so the `user_id` the
   * entitlement row is keyed by never moves. `updateUser({ email })` for a change
   * of address, which the provider confirms from both inboxes.
   *
   * Manual linking has to be enabled for the project (Dashboard → Authentication
   * → "Manual linking"); with it off, the provider's refusal is what the sheet
   * shows, and it is a truthful sentence rather than a silently created second
   * account.
   */
  protected async linkDoor(provider: IdentityProvider, email?: string): Promise<void> {
    if (provider === "email") {
      const address = (email ?? "").trim();
      if (address === "") {
        this.reason = "An emailed sign-in link needs an address to send it to.";
        return;
      }
      const { error } = await this.client.auth.updateUser({ email: address });
      if (error !== null) throw new Error(`the address could not be changed: ${messageOf(error)}`);
      await this.adoptFromClient();
      // After `adopt`: adopting the session clears the sentence, and this one is
      // about the account rather than about the token.
      this.reason = EMAIL_CHANGE_SENT;
      return;
    }

    const { data, error } = await this.client.auth.linkIdentity({
      provider,
      options: {
        skipBrowserRedirect: true,
        ...(this.redirectTo === null ? {} : { redirectTo: this.redirectTo }),
      },
    });
    if (error !== null) throw new Error(`${provider} could not be added to this account: ${messageOf(error)}`);
    const url = (data as { url?: string | null } | null)?.url ?? null;
    if (url !== null) this.navigate(url);
    // A window on its way to the provider has the identity added on the way back.
    await this.adoptFromClient();
    // After `adopt`: adopting the session clears the sentence the sheet is
    // waiting for, and this one is not about the token.
    this.reason = linkStarted(provider);
  }

  /**
   * Ends this device's session, and only this one.
   *
   * `supabase-js` defaults to the `global` scope here, which revokes every
   * session the reader has: signing out on the phone would sign out the desktop,
   * and the device list would never have a second row to revoke. `local` is the
   * whole difference, and it is one option.
   */
  protected async endSession(): Promise<void> {
    await this.client.auth.signOut({ scope: "local" });
  }

  /** The session the provider handed back, if it has already been handed back. */
  private async adoptFromClient(): Promise<void> {
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error !== null) return;
      const session = (data as { session?: SupabaseSessionLike | null } | null)?.session ?? null;
      if (session !== null) this.adopt(sessionRecord(session, this.doorFor(session)));
    } catch {
      /* A window on its way to the provider has no session yet, and that is not an error. */
    }
  }

  /**
   * Which door a session arrived through.
   *
   * The button that was pressed, when this window pressed one. A session that came
   * back through the provider's redirect after a page load pressed nothing here, so
   * the next best answer is the account's own identity list — the provider's fact,
   * not a guess — and only then the fallback door. Getting this wrong is cosmetic
   * but it is the difference between "signed in with Google" and "signed in with an
   * email address" on the return from Google.
   */
  private doorFor(session: SupabaseSessionLike): IdentityProvider {
    if (this.pending !== null) return this.pending;
    if (this.provider !== null) return this.provider;
    for (const identity of session.user?.identities ?? []) {
      if (isProvider(identity?.provider)) return identity.provider;
    }
    return "email";
  }
}

/** The parts of a Supabase session this app reads. Nothing else is touched. */
export interface SupabaseSessionLike {
  readonly access_token: string;
  readonly expires_at?: number | null;
  readonly user?: {
    readonly id?: string;
    readonly email?: string | null;
    /** Every identity attached to this user — the provider's own answer to "which doors". */
    readonly identities?: readonly { readonly provider?: string }[] | null;
  } | null;
}

/** A session, as the record this app stores. */
export function sessionRecord(session: SupabaseSessionLike, provider: IdentityProvider): IdentityRecord {
  const userId = session.user?.id ?? "";
  const doors: IdentityProvider[] = [];
  for (const identity of session.user?.identities ?? []) {
    const door = identity?.provider;
    if (isProvider(door) && !doors.includes(door)) doors.push(door);
  }
  // The door that was just used is in the list whenever the provider says so;
  // when it does not, it is still true that this account came through it.
  if (!doors.includes(provider)) doors.push(provider);
  return {
    userId,
    token: session.access_token,
    email: session.user?.email ?? null,
    provider,
    expiresAt: typeof session.expires_at === "number" ? session.expires_at * 1000 : null,
    providers: doors,
  };
}

/** Why a provider refused, as a line. Supabase errors carry a message; nothing else is promised. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "object" && cause !== null) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return "the provider did not answer";
}

/** What the build was handed. Both values are public; the second one is checked anyway. */
export interface IdentityConfig {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * The build's Supabase values, or null when this build has none.
 *
 * They come from the environment (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`,
 * listed in `.env.example` and read by Vite), never from source: the anon key is
 * publishable, but a project URL and a key in a repository are how a hobby
 * project's database ends up being somebody else's quotaless testing ground.
 *
 * A key whose own claims say `service_role` is refused here rather than used.
 * That key bypasses row-level security, so the only safe place for it is the
 * payment webhook's environment; if one ever reaches a bundle, refusing to build
 * a client turns "the database is open" into "sign-in does not work in this
 * build", which is a bug report instead of an incident.
 */
export function identityConfig(env: Record<string, unknown> | null = envOfBuild()): IdentityConfig | null {
  if (env === null) return null;
  const url = text(env.PUBLIC_SUPABASE_URL);
  const anonKey = text(env.PUBLIC_SUPABASE_ANON_KEY);
  if (url === "" || anonKey === "") return null;
  if (roleOf(anonKey) === "service_role") return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

/**
 * Whether a key says it is the service key.
 *
 * Reads the JWT payload's `role` claim and nothing else — no signature check,
 * because this is not authentication, it is a guard against the one string that
 * must never be here. A value that is not a JWT at all (a hand-written test key,
 * a new-format `sb_publishable_…` key) has no claim to read and is not refused.
 */
export function roleOf(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeSegment(parts[1])) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/** base64url → text, without a browser-only API. */
function decodeSegment(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  let out = "";
  for (let index = 0; index < binary.length; index += 1) {
    out += `%${binary.charCodeAt(index).toString(16).padStart(2, "0")}`;
  }
  return decodeURIComponent(out);
}

/** The environment Vite substitutes into the build. Absent under Node, which is a suite. */
function envOfBuild(): Record<string, unknown> | null {
  // Written as the literal `import.meta.env` because that is the expression Vite
  // replaces with the build's values; spelling it any other way (a cast, a
  // destructure) leaves it undefined in a browser bundle and every build would
  // silently have no identity.
  return (import.meta.env ?? null) as Record<string, unknown> | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The identity this build has.
 *
 * No project configured is `NoIdentity`, which is every development build and
 * the whole browser-only case: the app is free, local, and never asks anyone to
 * sign up. Configured, and this is the real one.
 *
 * Constructing either makes no request. `restore()` has already read the stored
 * record by the time this value exists, and nothing here opens a socket until a
 * sign-in is asked for or a window is returned to — which is rule 1, held by the
 * shape of the module rather than by everyone remembering it.
 */
export function createIdentity(
  config: IdentityConfig | null = identityConfig(),
  keys: KeyStore | null = deviceKeys(),
): Identity {
  if (config === null) return new NoIdentity(keys);
  return new SupabaseIdentity({
    client: createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        // Refresh is ours, on return to the window. A timer is a call nobody asked for.
        autoRefreshToken: false,
        // The provider comes back to this window with the session in the URL.
        detectSessionInUrl: true,
      },
    }),
    keys,
    redirectTo: text(envOfBuild()?.PUBLIC_APP_ORIGIN) || null,
  });
}

/** The app's one identity. A build with no project configured holds `NoIdentity`. */
export const identity: Identity = createIdentity();
