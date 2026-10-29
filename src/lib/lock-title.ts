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
 * - `missing` — this backend has no Hidden Categories to hold a passcode: the
 *   set is on this device, and a lock is not pretending otherwise.
 * - `local` — there is no server at all, so there is no service to connect.
 */
export type LockState = "ready" | "none" | "unknown" | "missing" | "local";

/**
 * Five answers, from the facts the band actually has.
 *
 * `store` is the hidden authority (`HiddenAuthority`): `"extension"` means the
 * backend is believed to carry Hidden Categories, so an unanswered state is a
 * server that has not said yet. `"local"` means nothing on the server can hold a
 * passcode at all — Miniflux, a stock FreshRSS, or a library on this device —
 * and saying "the server has not said" there would be a sentence about a route
 * that does not exist.
 *
 * `local` is its own case rather than a `missing` one: a library on this device
 * has no extension to ask, so "connect a service" is the whole of its answer,
 * and it is a different sentence from "this server is missing the piece".
 */
export function lockState(
  available: boolean,
  hasPasscode: boolean,
  hasServer = true,
  store: "extension" | "local" = "extension",
): LockState {
  if (store === "local") return hasServer ? "missing" : "local";
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
    case "missing":
      return "The lock needs Hidden Categories on the server — this set stays on this device";
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

/** Whether pressing the lock can do anything at all. */
export function lockUsable(state: LockState): boolean {
  return state === "ready" || state === "none";
}

/** The line under the passcode field, or nothing when it would not be true. */
export function lockHint(state: LockState): string | null {
  return state === "none" ? "Set a passcode to enable locking. One to six digits." : null;
}
