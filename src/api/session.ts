import { DEFAULT_API_PATH, normalizeApiPath, type Session } from "./freshrss";

const STORAGE_KEY = "hardlyreader.session";

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
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.serverUrl === "string" &&
      typeof parsed.email === "string" &&
      typeof parsed.token === "string"
    ) {
      return {
        serverUrl: parsed.serverUrl,
        // An unreadable prefix is not a reason to lose the account: the default
        // is what every session meant before the field existed.
        apiPath: typeof parsed.apiPath === "string" ? normalizeApiPath(parsed.apiPath) : DEFAULT_API_PATH,
        email: parsed.email,
        token: parsed.token,
      };
    }
  } catch {
    /* fall through and discard */
  }

  localStorage.removeItem(STORAGE_KEY);
  return null;
}

export function saveSession(session: Session): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...session, apiPath: normalizeApiPath(session.apiPath) }),
  );
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
