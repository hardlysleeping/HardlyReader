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
 * - `unknown` — a server that was supposed to answer did not: say that, not
 *   something about passcodes.
 *
 * There used to be two more, `missing` and `local`, both saying "a lock needs a
 * connected service". That stopped being true when the device that keeps the
 * hidden set started keeping its passcode too: a library with no server locks its
 * own categories, and so does a server whose reader has no Hidden Categories
 * extension. A control that refuses to do what it can do is its own kind of lie.
 */
export type LockState = "ready" | "none" | "unknown";

/**
 * Three answers, from the facts the band actually has.
 *
 * `store` is the hidden authority (`HiddenAuthority`): `"extension"` means the
 * backend is believed to carry Hidden Categories, so an unanswered state is a
 * server that has not said yet. `"local"` means the set and its passcode live on
 * this device — a library with no server, or a server with no extension — where
 * there is nothing to ask and the answer is already in hand.
 */
export function lockState(
  available: boolean,
  hasPasscode: boolean,
  hasServer = true,
  store: "extension" | "local" = "extension",
): LockState {
  // The device that keeps the set keeps the code: no route to wait on, so no unknown.
  if (store === "local" || !hasServer) return hasPasscode ? "ready" : "none";
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

/** Whether pressing the lock can do anything at all. */
export function lockUsable(state: LockState): boolean {
  return state === "ready" || state === "none";
}

/** The line under the passcode field, or nothing when it would not be true. */
export function lockHint(state: LockState): string | null {
  return state === "none" ? "Set a passcode to enable locking. One to six digits." : null;
}
