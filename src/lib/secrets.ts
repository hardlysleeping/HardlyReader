/**
 * Where a secret lives, when it should not be the page's own plain storage.
 *
 * One seam, three answers, and the seam never guesses which one it is on:
 *
 * - **native** — the desktop shell and the phone apps answer
 *   `secret_get` / `secret_set` / `secret_delete`, and the platform behind them
 *   is the OS's own store (Keychain on iOS, Keystore-backed preferences on
 *   Android, Secret Service on Linux). Nothing here knows which.
 * - **device** — a browser tab and the PWA have no OS store to ask, so the value
 *   stays in this device's own storage. `secretBackend()` says so, on purpose:
 *   a Settings row can then state the limit instead of implying a keychain the
 *   page does not have.
 *
 * Nothing in this module is allowed to be silent about which of the two it is —
 * "where is my token" must be answerable from the page itself.
 */

/** Which store the secrets are actually going into. */
export type SecretBackend = "native" | "device";

/**
 * The two things this module talks to, injected so the rules can be exercised
 * without a shell or a browser.
 *
 * `invoke` is Tauri's command channel; `storage` is the page's own store. A
 * caller that has neither (a test, a server render) gets the device branch with
 * an unavailable store, which reads as "no secret" rather than throwing.
 */
export interface SecretDeps {
  invoke?: (<T>(command: string, args?: Record<string, unknown>) => Promise<T>) | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** The prefix the device branch uses, so a secret is never mistaken for a setting. */
export const DEVICE_PREFIX = "hardlyreader.secret.";

/**
 * The shell's command channel, if this is the shell.
 *
 * Read off `globalThis` rather than imported from `@tauri-apps/api`: the module
 * has to be loadable in a browser tab and in the unit suites, where that import
 * would pull a package the page does not ship.
 */
function shell(): SecretDeps["invoke"] | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return typeof invoke === "function" ? (invoke as SecretDeps["invoke"]) : null;
}

function pageStore(): SecretDeps["storage"] | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/** The two channels, narrowed to "there" or "not there" — never undefined. */
interface Resolved {
  invoke: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

function resolve(deps: SecretDeps | undefined): Resolved {
  const invoke = deps && "invoke" in deps ? (deps.invoke ?? null) : shell();
  const storage = deps && "storage" in deps ? (deps.storage ?? null) : pageStore();
  return { invoke: invoke ?? null, storage: storage ?? null };
}

/**
 * Which store this device is using, asked without writing anything.
 *
 * A shell that does not implement the commands counts as `device`: the honest
 * answer to "is my token in the OS store" is no until something says yes.
 */
export function secretBackend(deps?: SecretDeps): SecretBackend {
  return resolve(deps).invoke === null ? "device" : "native";
}

/** The secret under `key`, or null when there is none (or no store to ask). */
export async function secretGet(key: string, deps?: SecretDeps): Promise<string | null> {
  const { invoke, storage } = resolve(deps);
  if (invoke !== null) {
    try {
      const value = await invoke("secret_get", { key });
      return typeof value === "string" && value !== "" ? value : null;
    } catch {
      // A shell that registers the command but has no store on this platform
      // answers an error. Treat it as "not there" and let the caller fall back,
      // rather than failing a launch over storage.
      return null;
    }
  }
  if (storage === null) return null;
  const raw = storage.getItem(`${DEVICE_PREFIX}${key}`);
  return raw === null || raw === "" ? null : raw;
}

/** Writes a secret. Returns false when there was nowhere to write it. */
export async function secretSet(key: string, value: string, deps?: SecretDeps): Promise<boolean> {
  const { invoke, storage } = resolve(deps);
  if (invoke !== null) {
    try {
      await invoke("secret_set", { key, value });
      return true;
    } catch {
      return false;
    }
  }
  if (storage === null) return false;
  try {
    storage.setItem(`${DEVICE_PREFIX}${key}`, value);
    return true;
  } catch {
    // Full or blocked storage: the session still works this launch.
    return false;
  }
}

/** Removes a secret. Absence is not an error. */
export async function secretDelete(key: string, deps?: SecretDeps): Promise<void> {
  const { invoke, storage } = resolve(deps);
  if (invoke !== null) {
    try {
      await invoke("secret_delete", { key });
    } catch {
      /* nothing to do: the caller is removing a sign-in that is already gone */
    }
    return;
  }
  if (storage === null) return;
  try {
    storage.removeItem(`${DEVICE_PREFIX}${key}`);
  } catch {
    /* same */
  }
}
