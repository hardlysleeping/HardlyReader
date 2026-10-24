/**
 * Reading and writing the sidebar-chrome preference.
 *
 * Kept out of the runes module so the rules can be tested directly: the band's
 * collapse is pure state plus one storage key, and the interesting cases are a
 * first run, a relaunch, corrupt JSON and no storage at all.
 */

import { AUTO_SYNC_DEFAULT_HOURS, parseAutoSyncHours, type AutoSyncHours } from "./auto-sync";

export const CHROME_KEY = "hardlyreader.chrome.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface ChromePrefs {
  bandCollapsed: boolean;
  /** Whether the feed-indent slider is showing. Collapsed is the quiet default. */
  indentOpen: boolean;
  /**
   * Whether the passcode is entered on a tappable number pad instead of typed.
   *
   * Off by default: a keyboard is faster with a mouse and a physical keyboard,
   * and the pad exists for the phone, where the on-screen keyboard covers the
   * band it is unlocking. Turning it on is one choice, remembered per device.
   */
  pinPad: boolean;
  /**
   * Whether the app syncs by itself — once at launch and then every few hours.
   *
   * Off by default: a sync is five requests against someone else's server, and
   * doing that unprompted is a choice the user makes, not one the app makes for
   * them. Per device, like the rest of this file: it describes what this window
   * does, not the account.
   */
  autoSync: boolean;
  /** Hours between automatic syncs, from `AUTO_SYNC_HOURS`. */
  autoSyncHours: AutoSyncHours;
}

const DEFAULT_PREFS: ChromePrefs = {
  bandCollapsed: false,
  indentOpen: false,
  pinPad: false,
  autoSync: false,
  autoSyncHours: AUTO_SYNC_DEFAULT_HOURS,
};

/** One read of the one key, so two flags cannot disagree about its contents. */
function readPrefs(storage: StorageLike | undefined): ChromePrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(CHROME_KEY);
    if (raw === null) return { ...DEFAULT_PREFS };
    const saved = JSON.parse(raw) as {
      bandCollapsed?: unknown;
      indentOpen?: unknown;
      pinPad?: unknown;
      autoSync?: unknown;
      autoSyncHours?: unknown;
    };
    return {
      bandCollapsed: saved.bandCollapsed === true,
      indentOpen: saved.indentOpen === true,
      pinPad: saved.pinPad === true,
      autoSync: saved.autoSync === true,
      autoSyncHours: parseAutoSyncHours(saved.autoSyncHours),
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

/** Off unless it was turned on: the pad is an opt-in, not a new default. */
export function readPinPad(storage: StorageLike | undefined): boolean {
  return readPrefs(storage).pinPad;
}

export function writeBandCollapsed(storage: StorageLike | undefined, collapsed: boolean): void {
  patchPrefs(storage, { bandCollapsed: collapsed });
}

export function writeIndentOpen(storage: StorageLike | undefined, open: boolean): void {
  patchPrefs(storage, { indentOpen: open });
}

export function writePinPad(storage: StorageLike | undefined, on: boolean): void {
  patchPrefs(storage, { pinPad: on });
}

/** Off unless it was turned on: nothing syncs behind the user's back. */
export function readAutoSync(storage: StorageLike | undefined): boolean {
  return readPrefs(storage).autoSync;
}

export function readAutoSyncHours(storage: StorageLike | undefined): AutoSyncHours {
  return readPrefs(storage).autoSyncHours;
}

export function writeAutoSync(storage: StorageLike | undefined, on: boolean): void {
  patchPrefs(storage, { autoSync: on });
}

export function writeAutoSyncHours(storage: StorageLike | undefined, hours: AutoSyncHours): void {
  patchPrefs(storage, { autoSyncHours: parseAutoSyncHours(hours) });
}

/** localStorage in a browser, undefined anywhere it does not exist. */
export function browserStorage(): StorageLike | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
