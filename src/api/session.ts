import { DEFAULT_API_PATH, normalizeApiPath, type Session } from "./freshrss";
import { secretDelete, secretGet, secretSet, type SecretDeps } from "../lib/secrets";

/** Where the signed-in account lives on this device. Also read by `lib/account-key`. */
export const SESSION_KEY = "hardlyreader.session";

/**
 * Every account signed in on this device, in the order they were added.
 *
 * `SESSION_KEY` still holds *one* session — the active one — because that is what
 * the rest of the app means by "the session": the GReader client, the scoped
 * device keys and any older build reading this store all expect it there. This
 * key is the list behind it, so a second sign-in does not have to throw the first
 * one away. `lib/accounts` owns the rules that keep the two in step; nothing here
 * knows about slugs, so this module stays a store and not a policy.
 */
export const ACCOUNTS_KEY = "hardlyreader.session.accounts";

/**
 * The server-issued token is NOT in either record.
 *
 * Those two records keep everything a reader can be shown — the server, the name,
 * the API prefix — and the token lives in `lib/secrets` instead: the OS's own
 * store where there is one (Keychain, Keystore-backed preferences, Secret
 * Service), this device's storage where there is not. `tokenStored` marks a
 * record whose token has moved, so an upgrade can tell a legacy record (token
 * inline) from a current one without guessing.
 *
 * A token hydrated this launch is kept in memory, keyed by server + name, so the
 * sync `loadSession()`/`sessionFor()` the rest of the app calls still answer with
 * a usable session after the boot's one awaited `hydrateSessions()`.
 */
interface StoredSession extends Session {
  /** True when this record's token lives in the secret store. */
  tokenStored?: boolean;
}

const hydrated = new Map<string, string>();

/**
 * The secret's name for one account: a digest, never the address.
 *
 * A storage key is written where keys are listed — devtools, a backup, the
 * `accounts.mjs` rule that no key may name an address — so the account is hashed
 * rather than spelled. FNV-1a, 64-bit, the same function `secrets.rs` uses for its
 * file names: short, stable, and no dependency in either language. A collision
 * cannot leak a token, because the Rust side checks the key it stored against the
 * key it is asked for and answers nothing when they differ.
 */
export function tokenKey(session: Pick<Session, "serverUrl" | "email">): string {
  const text = `${session.serverUrl}|${session.email}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Moves every stored token into the secret store, and remembers it for this launch.
 *
 * Awaited once at boot, before anything reads a session (`main.ts`), because a
 * record whose token has moved cannot answer without it. Three shapes are handled,
 * and all three turn up on a device:
 *
 * - **a legacy record** with the token inline: it is written to the store, the
 *   record is rewritten without it, and the plain copy is gone — an upgrade signs
 *   nobody out and leaves nothing behind;
 * - **a current record** with `tokenStored`: its token is read back into memory;
 * - **a record whose secret is missing** (the store was wiped, or the app died in
 *   the millisecond between the two writes): the record is dropped, because a
 *   session with no token cannot be used and keeping it would offer a sign-in that
 *   always fails. The account's feeds stay; only the sign-in goes.
 *
 * A store that refuses the write is not fatal: the record is left exactly as it
 * was and the token is remembered for this launch, so a browser with blocked
 * storage behaves as it always did instead of losing the account.
 *
 * Returns how many sessions are usable afterwards, which is what a launch can log.
 */
export async function hydrateSessions(deps?: SecretDeps): Promise<number> {
  if (typeof localStorage === "undefined") return 0;
  // Distinct accounts, not records: the active session is also in the list, and a
  // launch that counted it twice would report two sessions for one sign-in.
  const found = new Set<string>();
  let count = 0;

  const migrate = async (record: StoredSession | null): Promise<StoredSession | null> => {
    if (record === null) return null;
    const key = tokenKey(record);
    if (record.tokenStored !== true && record.token !== "") {
      const kept = await secretSet(key, record.token, deps);
      hydrated.set(key, record.token);
      found.add(key);
      count = found.size;
      // Nowhere to put it: keep the record as it is rather than lose the sign-in.
      return kept ? { ...record, token: "", tokenStored: true } : record;
    }
    const secret = await secretGet(key, deps);
    if (secret === null) return null;
    hydrated.set(key, secret);
    found.add(key);
    count = found.size;
    return { ...record, token: "", tokenStored: true };
  };

  const active = await migrate(readRecord(SESSION_KEY));
  if (active === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(active));

  const list: StoredSession[] = [];
  for (const record of readRawList()) {
    const kept = await migrate(record);
    if (kept !== null) list.push(kept);
  }
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    /* full or blocked storage: the list already written stays as it was */
  }
  return count;
}

/** The token hydrated for this session this launch, if any. */
function tokenFor(session: Pick<Session, "serverUrl" | "email">): string {
  return hydrated.get(tokenKey(session)) ?? "";
}

/**
 * Session persistence.
 *
 * A record is written without its token: the token goes to the secret store and
 * stays in memory for this launch. A write that loses the race — the app killed
 * in the millisecond between the two — costs one sign-in on the next launch, and
 * never leaves a token lying in plain storage.
 *
 * The stored shape gained `apiPath` when the client stopped assuming FreshRSS's
 * URL. A session saved before that has no field, and it meant FreshRSS's
 * `/api/greader.php` — so it loads with that default instead of being thrown
 * away: an upgrade must never require signing in again.
 */
export function loadSession(): Session | null {
  const record = readRecord(SESSION_KEY);
  if (record === null) return null;
  const token = record.token !== "" ? record.token : tokenFor(record);
  if (token === "") return null;
  return serializable({ ...record, token });
}

export function saveSession(session: Session): void {
  if (typeof localStorage === "undefined") return;
  const key = tokenKey(session);
  hydrated.set(key, session.token);
  void secretSet(key, session.token);
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...serializable(session), token: "", tokenStored: true }),
  );
}

/** Drops the active session alone. The list of accounts is `lib/accounts`' business. */
export function clearSession(): void {
  if (typeof localStorage === "undefined") return;
  const record = readRecord(SESSION_KEY);
  if (record !== null) {
    hydrated.delete(tokenKey(record));
    if (record.tokenStored === true) void secretDelete(tokenKey(record));
  }
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Every session this device holds, the active one first.
 *
 * A device that signed in before the list existed has one session and no list at
 * all, and a list that somehow lost the session in use would otherwise hide the
 * account the app is reading as. So the active session is part of the answer
 * either way — it is in the list by definition, not by bookkeeping.
 */
export function readSessions(): Session[] {
  const list = readList();
  const active = loadSession();
  if (active === null) return list;
  const known = list.some(
    (session) =>
      session.serverUrl === active.serverUrl &&
      session.email === active.email &&
      session.token === active.token,
  );
  return known ? list : [active, ...list];
}

/**
 * Replaces the list.
 *
 * Nothing is merged here: `lib/accounts` decided what the list is, and a write
 * that second-guessed it would be a second place the roster's rules live. Every
 * token goes to the secret store; each record keeps the rest.
 */
export function writeSessions(sessions: Session[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    const records: StoredSession[] = sessions.map((session) => {
      const key = tokenKey(session);
      hydrated.set(key, session.token);
      void secretSet(key, session.token);
      return { ...serializable(session), token: "", tokenStored: true };
    });
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(records));
  } catch {
    // Full or blocked storage: the accounts already signed in still work this
    // launch, they just will not all be found again next time.
  }
}

/** The stored list, without the active session folded in. Malformed entries are dropped. */
function readList(): Session[] {
  const sessions: Session[] = [];
  for (const record of readRawList()) {
    const token = record.token !== "" ? record.token : tokenFor(record);
    if (token === "") continue;
    sessions.push(serializable({ ...record, token }));
  }
  return sessions;
}

/** The raw records, tokens possibly moved out. Malformed entries are dropped. */
function readRawList(): StoredSession[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sessions: StoredSession[] = [];
    for (const entry of parsed) {
      const session = parseSession(entry);
      if (session !== null) sessions.push(session);
    }
    return sessions;
  } catch {
    return [];
  }
}

/** One stored record, or null. A malformed one is discarded, not thrown over. */
function readRecord(key: string): StoredSession | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    return parseSession(JSON.parse(raw) as unknown);
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/**
 * The stored fields, normalised.
 *
 * Anything without a server and a name is not a session. A token is optional
 * exactly when the record says the token has moved (`tokenStored`); a record that
 * carries neither is a record with nothing to authenticate with.
 */
function parseSession(value: unknown): StoredSession | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = value as Partial<StoredSession>;
  const tokenStored = parsed.tokenStored === true;
  const token =
    typeof parsed.token === "string" ? parsed.token : tokenStored ? "" : null;
  if (
    typeof parsed.serverUrl === "string" &&
    typeof parsed.email === "string" &&
    token !== null
  ) {
    return {
      ...serializable({
        serverUrl: parsed.serverUrl,
        // An unreadable prefix is not a reason to lose the account: the default is
        // what every session meant before the field existed.
        apiPath:
          typeof parsed.apiPath === "string" ? normalizeApiPath(parsed.apiPath) : DEFAULT_API_PATH,
        email: parsed.email,
        token,
      }),
      tokenStored,
    };
  }
  return null;
}

/** A session as it is written: the canonical API prefix, never a raw one. */
function serializable(session: Session): Session {
  return { ...session, apiPath: normalizeApiPath(session.apiPath) };
}
