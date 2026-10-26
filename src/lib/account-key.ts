/**
 * One device, more than one account.
 *
 * Everything this app keeps in `localStorage` used to be global: the layout, the
 * reading preferences, the sidebar chrome, the pins and the local indent. That
 * was honest while the app held exactly one session, and it stops being honest
 * the moment a second login exists — the next account would inherit the first
 * one's panes, pins and passcode-pad choice.
 *
 * So every account-owned key carries a slug derived from the account. The slug
 * is a hash: the email and the server URL are input, and neither ever appears in
 * a key. A key is not a credential store, and `localStorage` is readable by
 * anything running in the webview — a token, a password or a raw address in a key
 * name is a leak with extra steps.
 *
 * The slug is an identity tag, not a security boundary: 32 bits, so two accounts
 * on one device never meet in practice, and stable — the same server and email
 * hash the same way on every launch, which is what makes stored state findable
 * again. It is not secrecy. Someone holding the device who can name a candidate
 * server and address can hash that guess in microseconds and see whether a key is
 * theirs; what the hash stops is a name sitting in plain sight in a storage dump,
 * which is the part a screenshot or a pasted log actually spreads. The same slug
 * scopes the IndexedDB cache (see `state/persist.ts`), so one device-wide answer
 * to "whose key is this" holds for both stores.
 *
 * The legacy global keys are never deleted. A build without this file still
 * reads them, so a downgrade keeps working; and the first account to look for its
 * scoped copy adopts what the global key held (see `readAccountValue`). The
 * IndexedDB side takes the other road: those blobs are a disposable cache, so an
 * old-layout key is dropped rather than adopted.
 */

/** The session key, imported from the module that owns it, so a rename cannot
 * silently leave this helper reading a key nobody writes. */
import { SESSION_KEY } from "../api/session";

/** What a key needs to know about an account. No token, no password. */
export interface AccountIdentity {
  readonly serverUrl: string;
  readonly email: string;
}

/** The part of `Storage` these helpers use, so a stub can stand in for it. */
export type KeyStore = Pick<Storage, "getItem" | "setItem">;

/**
 * A stable, short, secret-free tag for one account.
 *
 * An address is normalised first — trimmed, lowercased, trailing slashes off the
 * server — so a session saved as `Example.com/` and one saved as `example.com`
 * are the same account rather than two. The hash is FNV-1a over that pair, 8 hex
 * characters: short enough to read in a storage dump, wide enough that two logins
 * on a device do not meet.
 */
export function accountSlug(account: AccountIdentity): string {
  const server = normalizeServer(text(account.serverUrl));
  const email = text(account.email).trim().toLowerCase();
  const input = `${server}|${email}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // FNV prime, via imul so the multiply stays in 32 bits instead of becoming a
    // float and losing the low bits.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeServer(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * A missing field is treated as empty rather than thrown on.
 *
 * Hashing runs on the cache write path, where a throw is worse than a plain
 * answer: a session restored from an older build, or one mid-way through a login,
 * can arrive without an address. Such a session still hashes to a stable slug
 * (different servers on one device stay apart); there is simply no second
 * identity on that server for it to be confused with.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `base` for one account, or `base` itself when there is no account yet.
 *
 * The fallback is deliberate: before sign-in — a login screen, a first run — there
 * is no account to scope to, and the old global key is still the only thing that
 * can hold a preference.
 */
export function scopedKey(base: string, account: AccountIdentity | null | undefined): string {
  return account === null || account === undefined ? base : `${base}:${accountSlug(account)}`;
}

/** Where the account that adopted a legacy key is recorded. Hex slugs cannot collide with it. */
function ownerKey(base: string): string {
  return `${base}:legacy-owner`;
}

/**
 * The value for this account, adopting a pre-scoping key once.
 *
 * A scoped key wins whenever it exists. When it does not, the legacy key — the
 * global `base`, or for the reader the old `serverUrl|email` form — is read and
 * copied to the scoped key, so the next launch finds it there. The legacy value
 * is left alone: an older build must still find it, and leaving it costs one
 * stored blob.
 *
 * Only the **first** account adopts. Whichever slug reaches the legacy value
 * records itself in `base:legacy-owner`; every other account sees that record and
 * starts from defaults instead of inheriting a stranger's state. A second account
 * reading an old global layout is not an upgrade, it is a leak.
 */
export function readAccountValue(
  storage: KeyStore | undefined,
  base: string,
  account: AccountIdentity | null,
  /** The key a pre-scoping build wrote. Defaults to `base`. */
  legacyKey: string = base,
): string | null {
  if (!storage) return null;
  if (account === null) return get(storage, base);

  const slug = accountSlug(account);
  const key = scopedKey(base, account);
  const own = get(storage, key);
  if (own !== null) return own;

  const legacy = get(storage, legacyKey);
  if (legacy === null) return null;
  const owner = get(storage, ownerKey(base));
  if (owner !== null && owner !== slug) return null;

  try {
    storage.setItem(ownerKey(base), slug);
    storage.setItem(key, legacy);
  } catch {
    // Storage full or blocked: the value is still this launch's to use.
  }
  return legacy;
}

/**
 * Writes the account's copy.
 *
 * A write claims an unclaimed legacy key even if nothing was read first, so the
 * first account on a device keeps the old value and the second one cannot adopt
 * it afterwards. With no account (before sign-in) it writes `base`, which is what
 * this app did before any of this existed.
 */
export function writeAccountValue(
  storage: KeyStore | undefined,
  base: string,
  account: AccountIdentity | null,
  value: string,
  legacyKey: string = base,
): void {
  if (!storage) return;
  if (account === null) {
    set(storage, base, value);
    return;
  }

  const slug = accountSlug(account);
  try {
    const owner = get(storage, ownerKey(base));
    if (owner === null && get(storage, legacyKey) !== null) {
      storage.setItem(ownerKey(base), slug);
    }
    storage.setItem(scopedKey(base, account), value);
  } catch {
    // Full or blocked storage: the state still applies for this session.
  }
}

/**
 * The account this device is signed in as, from the stored session.
 *
 * Only the two identity fields are returned — the token in that blob is not this
 * module's business, and reading it here would put a credential in the path of
 * code that only needs a name. A malformed or missing session is simply "no
 * account".
 */
export function storedAccount(storage: KeyStore | undefined): AccountIdentity | null {
  if (!storage) return null;
  const raw = get(storage, SESSION_KEY);
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw) as { serverUrl?: unknown; email?: unknown };
    if (typeof saved.serverUrl !== "string" || typeof saved.email !== "string") return null;
    return { serverUrl: saved.serverUrl, email: saved.email };
  } catch {
    return null;
  }
}

function get(storage: KeyStore, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function set(storage: KeyStore, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Full or blocked storage: the state still applies for this session.
  }
}
