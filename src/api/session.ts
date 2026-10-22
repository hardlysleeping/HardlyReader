import type { Session } from "./freshrss";

const STORAGE_KEY = "hardlyread.session";

/**
 * Session persistence. localStorage is enough while the only stored value is a
 * server-issued token; a real credential store is a later concern.
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
      return { serverUrl: parsed.serverUrl, email: parsed.email, token: parsed.token };
    }
  } catch {
    /* fall through and discard */
  }

  localStorage.removeItem(STORAGE_KEY);
  return null;
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
