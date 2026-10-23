/**
 * Reading and writing the sidebar-chrome preference.
 *
 * Kept out of the runes module so the rules can be tested directly: the band's
 * collapse is pure state plus one storage key, and the interesting cases are a
 * first run, a relaunch, corrupt JSON and no storage at all.
 */

export const CHROME_KEY = "hardlyreader.chrome.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readBandCollapsed(storage: StorageLike | undefined): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(CHROME_KEY);
    if (raw === null) return false;
    const saved = JSON.parse(raw) as { bandCollapsed?: unknown };
    return saved.bandCollapsed === true;
  } catch {
    // Corrupt JSON, or storage throwing: an expanded band is the safe default.
    return false;
  }
}

export function writeBandCollapsed(storage: StorageLike | undefined, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(CHROME_KEY, JSON.stringify({ bandCollapsed: collapsed }));
  } catch {
    // Full or blocked storage: the state still applies for this session.
  }
}

/** localStorage in a browser, undefined anywhere it does not exist. */
export function browserStorage(): StorageLike | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
