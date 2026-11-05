/**
 * Reading and writing the sidebar-chrome preference.
 *
 * Kept out of the runes module so the rules can be tested directly: the band's
 * collapse is pure state plus one storage key, and the interesting cases are a
 * first run, a relaunch, corrupt JSON and no storage at all.
 *
 * The key is per account. It used to be global, which was fine while this app
 * held one session and became wrong the moment a second login was possible: the
 * next account would inherit a folded band, a passcode pad and an auto-sync
 * schedule it never chose. The account is a hashed slug (`lib/account-key`), so no
 * address sits in a storage key, and the legacy global key is left where it is —
 * the first account adopts its contents once.
 */

import { readAccountValue, writeAccountValue, type AccountIdentity } from "./account-key";
import { AUTO_SYNC_DEFAULT_HOURS, parseAutoSyncHours, type AutoSyncHours } from "./auto-sync";
import {
  GESTURE_DEFAULTS,
  parseGestures,
  type GesturePrefs,
} from "./gestures";
import {
  REFRESH_ON_RETURN_DEFAULT,
  parseRefreshOnReturn,
  type RefreshOnReturn,
} from "./refresh-on-return";

export const CHROME_KEY = "hardlyreader.chrome.v1";

// This choice spans accounts on this device; never put it in an account's prefs
// blob (switching accounts must not silently turn the combined column back on).
export const MULTI_ACCOUNT_KEY = "hardlyreader.chrome.multiAccount";

export function readMultiAccount(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(MULTI_ACCOUNT_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeMultiAccount(storage: StorageLike | undefined, on: boolean): void {
  try {
    storage?.setItem(MULTI_ACCOUNT_KEY, JSON.stringify(on));
  } catch {
    // Blocked storage still permits the choice for this session.
  }
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface ChromePrefs {
  bandCollapsed: boolean;
  /** Whether the feed-indent slider is showing. Collapsed is the quiet default. */
  /**
   * Whether the passcode is entered on a tappable number pad instead of typed.
   *
   * Off by default: a keyboard is faster with a mouse and a physical keyboard,
   * and the pad exists for the phone, where the on-screen keyboard covers the
   * band it is unlocking. Turning it on is one choice, remembered per device and
   * per account.
   */
  pinPad: boolean;
  /**
   * Whether the app syncs by itself — once at launch and then every few hours.
   *
   * Off by default: a sync is five requests against someone else's server, and
   * doing that unprompted is a choice the user makes, not one the app makes for
   * them. It describes what this window does for one account, so it is stored
   * beside the rest of the chrome: a second login does not start syncing because
   * the first one did.
   */
  autoSync: boolean;
  /** Hours between automatic syncs, from `AUTO_SYNC_HOURS`. */
  autoSyncHours: AutoSyncHours;
  /**
   * What coming back to the window is worth: a threshold, always, or never.
   *
   * Five minutes by default. It sits beside the interval because both are about
   * this window's fetching, but it is not a second way to turn fetching off:
   * `never` silences the return check alone, and opening the app still syncs.
   */
  refreshOnReturn: RefreshOnReturn;
  /** The gestures this device answers to; see `lib/gestures.ts`. */
  gestures: GesturePrefs;
  /**
   * Whether the last few posts of every feed are kept on this device.
   *
   * On unless it was turned off: it is what makes a launch with no network show
   * something rather than an error, and it costs one small request per feed at
   * most twice a day (`lib/offline-copy.ts`). The row that turns it off says what
   * it costs, which is why the default is allowed to be on.
   */
  offlineCopy: boolean;
}

const DEFAULT_PREFS: ChromePrefs = {
  bandCollapsed: false,
  pinPad: false,
  autoSync: false,
  autoSyncHours: AUTO_SYNC_DEFAULT_HOURS,
  refreshOnReturn: REFRESH_ON_RETURN_DEFAULT,
  gestures: { ...GESTURE_DEFAULTS },
  offlineCopy: true,
};

/**
 * One read of the one key, so two flags cannot disagree about its contents.
 *
 * `account` is null before sign-in, and then this reads the legacy global key
 * exactly as it always did.
 */
function readPrefs(storage: StorageLike | undefined, account: AccountIdentity | null): ChromePrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = readAccountValue(storage, CHROME_KEY, account);
    if (raw === null) return { ...DEFAULT_PREFS };
    const saved = JSON.parse(raw) as {
      bandCollapsed?: unknown;
      pinPad?: unknown;
      autoSync?: unknown;
      autoSyncHours?: unknown;
      refreshOnReturn?: unknown;
      gestures?: unknown;
      offlineCopy?: unknown;
    };
    return {
      bandCollapsed: saved.bandCollapsed === true,
      pinPad: saved.pinPad === true,
      autoSync: saved.autoSync === true,
      autoSyncHours: parseAutoSyncHours(saved.autoSyncHours),
      refreshOnReturn: parseRefreshOnReturn(saved.refreshOnReturn),
      gestures: parseGestures(saved.gestures),
      // Written by a build that had the row; absent elsewhere, and then the default
      // stands rather than reading as "turned off".
      offlineCopy: saved.offlineCopy !== false,
    };
  } catch {
    // Corrupt JSON, or storage throwing: both quiet defaults are safe.
    return { ...DEFAULT_PREFS };
  }
}

/** Writes one flag without dropping the other: they share one key. */
function patchPrefs(
  storage: StorageLike | undefined,
  account: AccountIdentity | null,
  patch: Partial<ChromePrefs>,
): void {
  if (!storage) return;
  try {
    const next = { ...readPrefs(storage, account), ...patch };
    writeAccountValue(storage, CHROME_KEY, account, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the state still applies for this session.
  }
}

export function readBandCollapsed(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): boolean {
  return readPrefs(storage, account).bandCollapsed;
}

/** Off unless it was turned on: the pad is an opt-in, not a new default. */
export function readPinPad(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): boolean {
  return readPrefs(storage, account).pinPad;
}

export function writeBandCollapsed(
  storage: StorageLike | undefined,
  collapsed: boolean,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { bandCollapsed: collapsed });
}

export function writePinPad(
  storage: StorageLike | undefined,
  on: boolean,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { pinPad: on });
}

/** Off unless it was turned on: nothing syncs behind the user's back. */
export function readAutoSync(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): boolean {
  return readPrefs(storage, account).autoSync;
}

export function readAutoSyncHours(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): AutoSyncHours {
  return readPrefs(storage, account).autoSyncHours;
}

export function writeAutoSync(
  storage: StorageLike | undefined,
  on: boolean,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { autoSync: on });
}

export function writeAutoSyncHours(
  storage: StorageLike | undefined,
  hours: AutoSyncHours,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { autoSyncHours: parseAutoSyncHours(hours) });
}

/** Five minutes unless it was changed: a return is worth a fetch, a glance is not. */
export function readRefreshOnReturn(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): RefreshOnReturn {
  return readPrefs(storage, account).refreshOnReturn;
}

export function writeRefreshOnReturn(
  storage: StorageLike | undefined,
  value: RefreshOnReturn,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { refreshOnReturn: parseRefreshOnReturn(value) });
}

/** Kept on this device unless it was turned off. */
export function readOfflineCopy(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): boolean {
  return readPrefs(storage, account).offlineCopy;
}

export function writeOfflineCopy(
  storage: StorageLike | undefined,
  on: boolean,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { offlineCopy: on });
}

/** The gestures this device answers to, whole — one record, one write. */
export function readGestures(
  storage: StorageLike | undefined,
  account: AccountIdentity | null = null,
): GesturePrefs {
  return readPrefs(storage, account).gestures;
}

export function writeGestures(
  storage: StorageLike | undefined,
  value: GesturePrefs,
  account: AccountIdentity | null = null,
): void {
  patchPrefs(storage, account, { gestures: parseGestures(value) });
}

/** localStorage in a browser, undefined anywhere it does not exist. */
export function browserStorage(): StorageLike | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
