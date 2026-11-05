/**
 * Whose settings these are.
 *
 * A feed server is a place feeds live. It is not a person, and it is not where
 * a preference belongs: signing into a second FreshRSS on the same device used
 * to hand you that server's copy of the layout, the text size and the theme (or
 * a bare default), because every one of those keys was scoped to
 * `accountSlug(serverUrl|email)` — the *feed account*. The owner's rule, and the
 * one this file exists for: *"all the settings that are kept should be
 * hardlyreader account based not based off whatever sync account they have
 * connected, with freshrss ofc being the exception if they have the correct
 * extensions"*.
 *
 * So there are two settings scopes and no more:
 *
 * - **The HardlyReader account**, when this device is signed into one
 *   (`identity.userId`). Settings follow the person: two servers, one set of
 *   panes.
 * - **This device**, when it is not. A stable pseudo-account, so a device with
 *   no account still has exactly one bucket and a legacy key still migrates.
 *
 * What is *not* here, on purpose — these belong to a feed store, not a person,
 * because their ids are that server's own:
 *
 * - the sidebar arrangement (`hardlyreader.prefs.v1`: pins, hidden, feed order,
 *   category order, indent) and the reading place, which the FreshRSS extensions
 *   also own on the server side;
 * - the offline copy and the extension-state snapshot (per feed account);
 * - the stream and body caches (already slugged per feed account, `state/persist`).
 *
 * Theme keeps its own device-wide key (`state/theme.svelte`), which is the same
 * bucket this file would give it with no account — it travels with the person
 * through the prefs document, not through that key.
 *
 * A server is still allowed to carry settings: the per-account
 * `/v1/preferences` route stays as a **mirror** of this person's document
 * (`state/prefs.svelte`), so someone with no HardlySyncing subscription keeps
 * moving settings between devices on the same server. The document is the
 * person's; the server is only carriage.
 */
import {
  accountSlug,
  adoptAccountValue,
  readAccountValue,
  scopedKey,
  storedAccount,
  writeAccountValue,
  type AccountIdentity,
  type KeyStore,
} from "./account-key";
import { IDENTITY_KEY } from "./identity-key";

/** The pseudo-account a server address can never take, because of the scheme. */
export const PERSON_SERVER = "hardlyreader://person";

/** The bucket a device with no account keeps its settings in. */
export const DEVICE_IDENTITY: AccountIdentity = {
  serverUrl: "hardlyreader://device",
  email: "device",
};

/** One stored string, or nothing. A store that throws is a store with no answer. */
function read(storage: KeyStore | undefined, key: string): string | null {
  if (storage === undefined) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The HardlyReader account on this device, from the identity record's `userId`.
 *
 * Storage only — no client, no token, no request — because a store that reads
 * this at launch must not depend on the network. A record this build cannot read
 * (no `userId`, a corrupt blob) is no account: settings then live on the device,
 * which is where they came from anyway.
 */
export function personIdentity(storage: KeyStore | undefined): AccountIdentity | null {
  const raw = read(storage, IDENTITY_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown };
    if (typeof parsed.userId !== "string" || parsed.userId === "") return null;
    return { serverUrl: PERSON_SERVER, email: parsed.userId };
  } catch {
    return null;
  }
}

/** The scope a setting is read and written in: the person, or this device. */
export function settingsAccount(storage: KeyStore | undefined): AccountIdentity {
  return personIdentity(storage) ?? DEVICE_IDENTITY;
}

/**
 * A settings value, with the move off per-server keys done once.
 *
 * Order: this scope's own copy, then any pre-scoping global key (through the
 * existing ownership rule), then the copy the previous build wrote under the
 * **feed account** that is signed in now — which is what an upgrade has, since
 * every settings key was scoped that way until this file existed. The adoption
 * claims the key for this scope, so a second person on the device starts from
 * defaults instead of inheriting a stranger's panes.
 */
export function readSettings(storage: KeyStore | undefined, base: string): string | null {
  if (storage === undefined) return null;
  const scope = settingsAccount(storage);
  const own = readAccountValue(storage, base, scope);
  if (own !== null) return own;

  const feed = storedAccount(storage);
  if (feed === null) return null;
  const carried = read(storage, scopedKey(base, feed));
  if (carried === null) return null;
  adoptAccountValue(storage, base, scope, carried);
  // A refusal (another scope already owns the base) is still a "no" here: the
  // value was read from a key this scope may not claim, so it is not returned.
  const claimed = read(storage, scopedKey(base, scope));
  return claimed === carried ? carried : null;
}

/** Write a settings value in this scope. Never touches the feed account's key. */
export function writeSettings(
  storage: KeyStore | undefined,
  base: string,
  value: string,
): void {
  if (storage === undefined) return;
  writeAccountValue(storage, base, settingsAccount(storage), value);
}

/** The key a settings scope writes, for tests and for a storage dump. */
export function settingsKey(storage: KeyStore | undefined, base: string): string {
  return scopedKey(base, settingsAccount(storage));
}

/** The slug this scope is filed under — the same tag a storage dump shows. */
export function settingsSlug(storage: KeyStore | undefined): string {
  return accountSlug(settingsAccount(storage));
}
