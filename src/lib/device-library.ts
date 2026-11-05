/**
 * The reader's answer to "use this device only", remembered on the device.
 *
 * The first screen offers two ways in: a sync account, or a library that lives
 * in this app. Signing in is remembered by the session store; this is the other
 * answer, so a device that chose it does not meet the sign-in screen again every
 * launch. It is device-scoped on purpose — a choice about *this* install, not
 * part of an account's prefs, and never carried anywhere by sync.
 *
 * A missing value is the same as "not chosen": storage that is unavailable (a
 * private window, a broken profile) answers `false` and the app still opens, and
 * a device already holding feeds counts as chosen without ever writing this.
 */
const KEY = "hardlyreader.device-library.v1";

/** True once this device has been told to use a library of its own. */
export function deviceLibraryChosen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Record the choice. A store that refuses it costs one screen next launch, nothing more. */
export function chooseDeviceLibrary(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* no storage: the library still opens, the answer is just not kept */
  }
}
