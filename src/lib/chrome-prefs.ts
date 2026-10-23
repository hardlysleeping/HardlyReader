/**
 * Reading and writing the sidebar-chrome preference.
 *
 * Kept out of the runes module so the rules can be tested directly: the band's
 * collapse is pure state plus one storage key, and the interesting cases are a
 * first run, a relaunch, corrupt JSON and no storage at all.
 */

export const CHROME_KEY = "hardlyreader.chrome.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface ChromePrefs {
  bandCollapsed: boolean;
  /** Whether the feed-indent slider is showing. Collapsed is the quiet default. */
  indentOpen: boolean;
}

const DEFAULT_PREFS: ChromePrefs = { bandCollapsed: false, indentOpen: false };

/** One read of the one key, so two flags cannot disagree about its contents. */
function readPrefs(storage: StorageLike | undefined): ChromePrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(CHROME_KEY);
    if (raw === null) return { ...DEFAULT_PREFS };
    const saved = JSON.parse(raw) as { bandCollapsed?: unknown; indentOpen?: unknown };
    return {
      bandCollapsed: saved.bandCollapsed === true,
      indentOpen: saved.indentOpen === true,
    };
  } catch {
    // Corrupt JSON, or storage throwing: both quiet defaults are safe.
    return { ...DEFAULT_PREFS };
  }
}

/** Writes one flag without dropping the other: they share one key. */
function patchPrefs(storage: StorageLike | undefined, patch: Partial<ChromePrefs>): void {
  if (!storage) return;
  try {
    const next = { ...readPrefs(storage), ...patch };
    storage.setItem(CHROME_KEY, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the state still applies for this session.
  }
}

export function readBandCollapsed(storage: StorageLike | undefined): boolean {
  return readPrefs(storage).bandCollapsed;
}

/**
 * The indent slider starts collapsed.
 *
 * It is a number you set once and a 12px-tall slider you then look at forever;
 * collapsed shows the value as text and costs one click to open.
 */
export function readIndentOpen(storage: StorageLike | undefined): boolean {
  return readPrefs(storage).indentOpen;
}

export function writeBandCollapsed(storage: StorageLike | undefined, collapsed: boolean): void {
  patchPrefs(storage, { bandCollapsed: collapsed });
}

export function writeIndentOpen(storage: StorageLike | undefined, open: boolean): void {
  patchPrefs(storage, { indentOpen: open });
}

/** localStorage in a browser, undefined anywhere it does not exist. */
export function browserStorage(): StorageLike | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
