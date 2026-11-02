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
import type { ReaderBackend } from "./backend";
import { GReaderBackend } from "./greader-backend";
import { transport } from "./transport";
import type { Session } from "./freshrss";
import { LocalBackend } from "./local/local-backend";
import { LocalStore } from "./local/store";
import { openLocalDatabase, type LocalDatabaseOptions } from "./local/open";
import { accountSlug, type AccountIdentity } from "../lib/account-key";
import { IdbJournalBank, WriteJournal } from "./offline/journal";
import { OfflineBackend } from "./offline/backend";

/**
 * The one place a server account's backend is built.
 *
 * There used to be two: this file built one when a session became a profile, and
 * `reader.svelte.ts` built one for a session that had none. Both produced the same
 * `GReaderBackend`, which made the duplicate look harmless — and it was, until
 * something had to be *wrapped around every server backend*. Offline writing is
 * exactly that: a mark made with no network is kept in front of the request, so the
 * wrapper has to be on every server backend, or the queue quietly misses whichever
 * path the reader happened to take.
 *
 * So: a server backend is built here, and only here. A caller that wants to decorate
 * one — a journal, a proxy, a recorder in a suite — wraps what this returns instead of
 * writing `new GReaderBackend` somewhere of its own.
 *
 * A library on this device is not built here and does not want to be: opening one is
 * asynchronous (a database has to open), and `openLocalProfile` owns that.
 */
export interface ServerBackendOptions {
  /**
   * A wrapper around the built backend: the whole point of the seam.
   *
   * Called with the built backend — the queued one, not the plain one, so a wrapper
   * sees what the reader sees — and expected to return something that still behaves
   * like a backend. Nothing here inspects the result, so a suite can hand in a
   * recorder and see exactly what the app asked for.
   */
  wrap?: (backend: ReaderBackend) => ReaderBackend;
  /**
   * The queue this account's marks go into. Built from the account when absent.
   *
   * Shells it in so a caller can share one queue across two backends for the same
   * account, which is what keeps a mark made through one visible to the other.
   */
  journal?: WriteJournal;
  /**
   * Whether read and star marks are queued at all. **On** everywhere in the app.
   *
   * Off is for a probe that wants the server's own answer to a write: `flush` is
   * then absent, which is the interface's way of saying nothing is ever queued.
   */
  queue?: boolean;
}

/**
 * One queue per account, for as long as the app is running.
 *
 * Two backends are built for a signed-in account — the profile's and the reader's
 * fallback — and they must share a queue: a mark recorded through one has to be
 * visible to the other, or the same post could be sent twice and the overlay could
 * paint the older answer. The slug is the only thing that identifies an account
 * here, so it is the key.
 */
const journals = new Map<string, WriteJournal>();

function journalFor(identity: AccountIdentity): WriteJournal {
  const slug = accountSlug(identity);
  let journal = journals.get(slug);
  if (journal === undefined) {
    journal = new WriteJournal(new IdbJournalBank(), slug);
    journals.set(slug, journal);
  }
  return journal;
}

/** The backend a signed-in server account is read through. */
export function serverBackend(
  session: Session,
  options: ServerBackendOptions = {},
): ReaderBackend {
  const plain: ReaderBackend = new GReaderBackend(transport, session);
  const built =
    options.queue === false
      ? plain
      : new OfflineBackend(plain, {
          journal: options.journal ?? journalFor({ serverUrl: session.serverUrl, email: session.email }),
        });
  return options.wrap === undefined ? built : options.wrap(built);
}

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
    backend: backend ?? serverBackend(session),
    session,
  };
}

/**
 * The library behind a profile, when the library is on this device.
 *
 * Device sync merges rows, so it needs the `LocalStore` and not the reading
 * seam; a signed-in profile answers `null`, because its library lives on the
 * server and FreshRSS already keeps it in step. Returns the store rather than
 * opening a second one: two handles on one SQLite file would be two writers on
 * the same rows for no reason.
 */
export function localStoreOf(profile: ReaderProfile | null): LocalStore | null {
  if (profile === null || profile.kind !== "local") return null;
  const backend = profile.backend;
  return backend instanceof LocalBackend ? backend.store : null;
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
