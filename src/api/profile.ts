/**
 * Who is reading, and where their articles come from.
 *
 * Until this file existed, "who is using HardlyReader" was a `Session` — a server
 * URL, an email and a token. That was true while the app could only read a
 * FreshRSS account, and it stops being true the moment the library can live on
 * the device: a `Session` would then have to be invented, with a fake URL and a
 * fake token, to mean "no server at all". Faking a credential to describe the
 * absence of one is how a login gate ends up in front of a local library.
 *
 * A profile is the honest version. It says which of the two things is answering
 * (`kind`), carries the backend that answers it, and — for the scoped device
 * keys in `lib/account-key` — carries a `slug`. The slug is the only part the
 * layout, prefs, pins and caches care about, so those stores keep working for a
 * library with no account behind it.
 *
 * `ReaderProfile.session` exists on the sync side alone. Code that genuinely
 * needs a server (the FreshRSS extension state, pairing, change-watch) asks for
 * `profile.session` and gets `null` for a local library, rather than a value it
 * would have to test the truthiness of on every call.
 */
import { GReaderBackend } from "./greader-backend";
import { transport } from "./transport";
import type { ReaderBackend } from "./backend";
import type { Session } from "./freshrss";
import { LocalBackend } from "./local/local-backend";
import { LocalStore } from "./local/store";
import { openLocalDatabase, type LocalDatabaseOptions } from "./local/open";
import { accountSlug, type AccountIdentity } from "../lib/account-key";

/**
 * The device-side identity a local library scopes its stored state by.
 *
 * `AccountIdentity` is what every scoped key helper already hashes, and a local
 * library needs exactly that: a stable, secret-free tag so its layout, prefs,
 * pins and caches are its own. It is not a session — there is no token, no API
 * path, and nothing that would let anyone authenticate with it. The scheme is
 * spelled `device://` so a hashed key can never be mistaken for a server's.
 */
export const LOCAL_SCOPE_IDENTITY: AccountIdentity = { serverUrl: "device://local", email: "local" };

/** The slug a local library stores its device keys under. */
export const LOCAL_PROFILE_SLUG = accountSlug(LOCAL_SCOPE_IDENTITY);

/** A library that lives on this device. No server, no sign-in, no token. */
export interface LocalProfile {
  readonly kind: "local";
  readonly slug: typeof LOCAL_PROFILE_SLUG;
  /** What the account panel calls this library. */
  readonly label: string;
  readonly backend: ReaderBackend;
  readonly session: null;
}

/** A library served by FreshRSS, Miniflux, Tiny Tiny RSS or The Old Reader. */
export interface SyncProfile {
  readonly kind: "greader";
  /** The account slug, so device keys stay scoped exactly as they were. */
  readonly slug: string;
  readonly label: string;
  readonly backend: ReaderBackend;
  readonly session: Session;
}

export type ReaderProfile = LocalProfile | SyncProfile;

/**
 * The identity a profile's device keys are scoped by.
 *
 * One function so no caller has to branch on `kind` to find out whose layout it
 * is about to read: a sync profile answers with its session (which carries the
 * server and the email), a local one with the device identity above.
 */
export function scopeIdentity(profile: ReaderProfile | null): AccountIdentity | null {
  if (profile === null) return null;
  return profile.kind === "greader" ? profile.session : LOCAL_SCOPE_IDENTITY;
}

/** The device-side identity a profile scopes its stored state by. */
export function profileSlug(profile: ReaderProfile): string {
  return profile.slug;
}

/** The server session, or `null` when there is no server behind this profile. */
export function sessionOf(profile: ReaderProfile): Session | null {
  return profile.kind === "greader" ? profile.session : null;
}

/** A profile for a library already open in this window. */
export function localProfile(backend: ReaderBackend, label = "On this device"): LocalProfile {
  return { kind: "local", slug: LOCAL_PROFILE_SLUG, label, backend, session: null };
}

/** A profile for a signed-in account, using the backend it already had. */
export function syncProfile(session: Session, backend?: ReaderBackend): SyncProfile {
  return {
    kind: "greader",
    slug: accountSlug(session),
    label: session.email,
    backend: backend ?? new GReaderBackend(transport, session),
    session,
  };
}

/**
 * Opens (or creates) the library on this device.
 *
 * The engine is chosen by `openLocalDatabase` — SQLite inside the desktop and
 * phone apps, IndexedDB in a browser tab — and the caller gets a profile it can
 * hand straight to the reader. First launch is this call and nothing else: an
 * empty SQLite file opens in milliseconds, where a server probe is a network
 * round-trip that can fail.
 */
export async function openLocalProfile(
  options: LocalDatabaseOptions & { label?: string } = {},
): Promise<LocalProfile> {
  const database = await openLocalDatabase(options);
  const store = new LocalStore(database);
  const backend = new LocalBackend(store, options.label === undefined ? {} : { deviceName: options.label });
  return localProfile(backend, options.label ?? "On this device");
}
