import { DEFAULT_API_PATH, normalizeApiPath, type Session } from "./freshrss";

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
 * Session persistence. localStorage is enough while the only stored value is a
 * server-issued token; a real credential store is a later concern.
 *
 * The stored shape gained `apiPath` when the client stopped assuming FreshRSS's
 * URL. A session saved before that has no field, and it meant FreshRSS's
 * `/api/greader.php` — so it loads with that default instead of being thrown
 * away: an upgrade must never require signing in again.
 */
export function loadSession(): Session | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw === null) {
    return null;
  }

  try {
    const session = parseSession(JSON.parse(raw) as unknown);
    if (session !== null) return session;
  } catch {
    /* fall through and discard */
  }

  localStorage.removeItem(SESSION_KEY);
  return null;
}

export function saveSession(session: Session): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(serializable(session)));
}

/** Drops the active session alone. The list of accounts is `lib/accounts`' business. */
export function clearSession(): void {
  if (typeof localStorage === "undefined") return;
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
 * that second-guessed it would be a second place the roster's rules live.
 */
export function writeSessions(sessions: Session[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(sessions.map(serializable)));
  } catch {
    // Full or blocked storage: the accounts already signed in still work this
    // launch, they just will not all be found again next time.
  }
}

/** The stored list, without the active session folded in. Malformed entries are dropped. */
function readList(): Session[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sessions: Session[] = [];
    for (const entry of parsed) {
      const session = parseSession(entry);
      if (session !== null) sessions.push(session);
    }
    return sessions;
  } catch {
    return [];
  }
}

/** The stored fields, normalised. Anything without a server, a name and a token is not a session. */
function parseSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = value as Partial<Session>;
  if (
    typeof parsed.serverUrl === "string" &&
    typeof parsed.email === "string" &&
    typeof parsed.token === "string"
  ) {
    return serializable({
      serverUrl: parsed.serverUrl,
      // An unreadable prefix is not a reason to lose the account: the default is
      // what every session meant before the field existed.
      apiPath: typeof parsed.apiPath === "string" ? normalizeApiPath(parsed.apiPath) : DEFAULT_API_PATH,
      email: parsed.email,
      token: parsed.token,
    });
  }
  return null;
}

/** A session as it is written: the canonical API prefix, never a raw one. */
function serializable(session: Session): Session {
  return { ...session, apiPath: normalizeApiPath(session.apiPath) };
}
