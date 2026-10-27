/**
 * What the lock button may honestly say about itself.
 *
 * The button needs one of three answers, and until this file existed it had two:
 * a passcode, or none. That made "Set a passcode first" the label for a state it
 * had not measured — a PWA served from another origin cannot read the adapter's
 * state at all, so `hasPasscode` came back false and the app told the reader
 * there was no passcode on an account that had one. Absence of an answer is not
 * an answer, and a control must not claim a fact it has not been told.
 *
 * So `unknown` is its own case, and each case has its own sentence:
 *
 * - `ready` — the extension answered and has a passcode: the lock can be pressed.
 * - `none` — the extension answered and has no passcode: setting one is the step.
 * - `unknown` — nobody answered: say that, not something about passcodes.
 */
export type LockState = "ready" | "none" | "unknown" | "local";

/**
 * Four answers, from the three facts the band actually has.
 *
 * `local` is its own case rather than an `unknown` server: a library on this
 * device has no extension to ask, so "the server has not said" would be a
 * sentence about a server that does not exist.
 */
export function lockState(available: boolean, hasPasscode: boolean, hasServer = true): LockState {
  if (!hasServer) return "local";
  if (!available) return "unknown";
  return hasPasscode ? "ready" : "none";
}

/** The tooltip for the band's lock control. */
export function lockTitle(state: LockState): string {
  switch (state) {
    case "ready":
      return "Lock hidden categories";
    case "none":
      return "Set a passcode first";
    case "unknown":
      return "This server has not said whether a passcode is set";
    case "local":
      return "Locking needs a connected service";
  }
}

/**
 * Whether pressing the lock should open the passcode panel.
 *
 * Only when there is provably no passcode to lock with. Pressing a lock on an
 * account that has one should lock it, and pressing one that answered nothing
 * should say nothing rather than ask for a code the server may already hold.
 */
export function lockOpensPanel(state: LockState): boolean {
  return state === "none";
}

/** The line under the passcode field, or nothing when it would not be true. */
export function lockHint(state: LockState): string | null {
  return state === "none" ? "Set a passcode to enable locking. One to six digits." : null;
}
