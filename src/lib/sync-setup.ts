/**
 * What this device has chosen about its sync, and where the folder is.
 *
 * A local library has no server, so the two devices agree through a document in
 * a folder the reader already syncs themselves (`api/local/sync.ts`). Two facts
 * belong to *this device* and to no account in the cloud: which service the
 * reader picked (iCloud, Google Drive, Dropbox, OneDrive), and the folder that
 * service mirrors. A path is a statement about this computer's drives, so it is
 * stored under a **device key** — localStorage, scoped to the profile the way
 * every other per-account preference is — and never enters the synced settings
 * document (`lib/prefs-sync`). A folder that travelled would arrive on the other
 * device as a path that does not exist there.
 *
 * One folder per provider, remembered separately: a reader who tries iCloud and
 * then moves to Dropbox keeps the iCloud path for the day they move back, and
 * switching service never asks for money again (four providers, one entitlement
 * — `state/entitlements.svelte.ts`).
 *
 * This file is the rules, without a store: parse, choose, remember, say how long
 * ago. `state/device-sync.svelte.ts` is the runes wrapper that owns the run.
 */
import { readAccountValue, writeAccountValue, type AccountIdentity, type KeyStore } from "./account-key";
import type { SyncProviderId } from "../api/local/sync-provider";
import { parseSyncSnapshot, type SyncSnapshot } from "../api/local/sync";

/** The record's key. Scoped per profile by `account-key`; never in the prefs doc. */
export const SYNC_SETUP_KEY = "hardlyreader.sync.setup.v1";

/**
 * What a sync is asked to keep in step, in the UI's words.
 *
 * The four the owner sells behind one subscription. `folder` exists in
 * `SyncProviderId` for a plain directory (a network share, a USB stick) and is
 * deliberately not offered here: the section is about moving between devices
 * through a service the reader already has.
 */
export const SYNC_CHOICES: readonly SyncProviderId[] = ["icloud", "gdrive", "dropbox", "onedrive"];

/** This device's choices, as stored. */
export interface SyncSetup {
  /** Which service the reader picked, or null before they have. */
  provider: SyncProviderId | null;
  /** One folder per service, as typed. A missing entry is one never chosen. */
  folders: Partial<Record<SyncProviderId, string>>;
  /** Milliseconds of the last successful run; 0 when there has not been one. */
  lastSyncedAt: number;
  /** The last agreement, for the provider in use. Null before the first run. */
  base: SyncSnapshot | null;
}

/** Nothing chosen yet: a device that has never synced. */
export function emptySetup(): SyncSetup {
  return { provider: null, folders: {}, lastSyncedAt: 0, base: null };
}

/** Whether a value is one of the four the section offers. */
export function isSyncChoice(value: unknown): value is SyncProviderId {
  return typeof value === "string" && (SYNC_CHOICES as readonly string[]).includes(value);
}

/**
 * The stored record, read defensively.
 *
 * Every field is untrusted: this is localStorage, and an older or newer build
 * may have written something else. A record this build cannot read is a device
 * that has not synced yet — not an error worth a dialog, and never a reason to
 * throw on the path that draws Settings.
 */
export function parseSetup(raw: string | null): SyncSetup {
  const setup = emptySetup();
  if (raw === null || raw === "") return setup;

  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return setup;
  }
  if (saved === null || typeof saved !== "object") return setup;
  const record = saved as Record<string, unknown>;

  if (isSyncChoice(record.provider)) setup.provider = record.provider;

  const folders = record.folders;
  if (folders !== null && typeof folders === "object") {
    for (const id of SYNC_CHOICES) {
      const path = (folders as Record<string, unknown>)[id];
      if (typeof path === "string" && path.trim() !== "") setup.folders[id] = path.trim();
    }
  }

  if (typeof record.lastSyncedAt === "number" && Number.isFinite(record.lastSyncedAt)) {
    setup.lastSyncedAt = record.lastSyncedAt > 0 ? record.lastSyncedAt : 0;
  }

  if (record.base !== null && record.base !== undefined) {
    // Through the document's own parser: a base this build cannot read is
    // dropped, and the next run starts a fresh agreement instead of merging
    // against a shape it does not understand.
    try {
      setup.base = parseSyncSnapshot(JSON.stringify(record.base));
    } catch {
      setup.base = null;
    }
  }

  return setup;
}

/** The record as it is written back. */
export function serializeSetup(setup: SyncSetup): string {
  return JSON.stringify({
    provider: setup.provider,
    folders: setup.folders,
    lastSyncedAt: setup.lastSyncedAt,
    base: setup.base,
  });
}

/** The folder chosen for one service, or "" when none has been. */
export function folderFor(setup: SyncSetup, provider: SyncProviderId | null): string {
  if (provider === null) return "";
  return setup.folders[provider] ?? "";
}

/**
 * The reader picked a service.
 *
 * Switching service is not a new document in the same place: another provider is
 * another folder, so the agreement and the last-run time go with the old one.
 * They are *kept* under the provider they were made with — the folders stay —
 * so switching back finds its own path and does not resurrect a merge base that
 * belonged to a different file.
 */
export function withProvider(setup: SyncSetup, provider: SyncProviderId | null): SyncSetup {
  if (provider === setup.provider) return setup;
  return { ...setup, provider, lastSyncedAt: 0, base: null };
}

/**
 * The reader chose the folder for the service in use.
 *
 * A different folder is a different document, even under the same service name,
 * so the agreement goes: keeping a base from another folder would report every
 * record in the new file as a change made here.
 */
export function withFolder(setup: SyncSetup, provider: SyncProviderId, path: string): SyncSetup {
  const trimmed = path.trim();
  const folders = { ...setup.folders };
  if (trimmed === "") delete folders[provider];
  else folders[provider] = trimmed;
  const moved = (setup.folders[provider] ?? "") !== trimmed;
  return {
    ...setup,
    folders,
    lastSyncedAt: moved ? 0 : setup.lastSyncedAt,
    base: moved ? null : setup.base,
  };
}

/** A run finished. Its document is the new agreement. */
export function withRun(setup: SyncSetup, base: SyncSnapshot, at: number): SyncSetup {
  return { ...setup, base, lastSyncedAt: at };
}

/**
 * How long ago the last run was, in the row's words.
 *
 * Rounded down and singular/plural in full ("1 minute ago", "3 days ago"), so the
 * line reads as a sentence rather than a counter. `0` is a device that has not
 * synced, which the row says plainly instead of "0 seconds ago".
 */
export function describeLastSynced(at: number, now: number): string {
  if (at <= 0) return "Never";
  const seconds = Math.max(1, Math.floor((now - at) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Reads this profile's record, or the empty one when there is none. */
export function readSetup(
  storage: KeyStore | undefined,
  identity: AccountIdentity | null,
): SyncSetup {
  return parseSetup(readAccountValue(storage, SYNC_SETUP_KEY, identity));
}

/** Writes this profile's record. Best effort: a full store still syncs today. */
export function writeSetup(
  storage: KeyStore | undefined,
  identity: AccountIdentity | null,
  setup: SyncSetup,
): void {
  writeAccountValue(storage, SYNC_SETUP_KEY, identity, serializeSetup(setup));
}
