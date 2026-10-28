/**
 * Where the sync document lives.
 *
 * `sync.ts` merges a document; what it used to be handed was a folder, which put
 * a filesystem path inside the engine. It now asks a **provider** for the
 * document and hands the merged one back. Four members, no more: read it, write
 * it, say which service this is, and say where it writes in words a reader
 * understands.
 *
 * **Everything in v1 is folder-backed, including the four clouds.** iCloud
 * Drive, Google Drive, Dropbox and OneDrive here are *names for a folder the
 * reader's own sync client already mirrors* — not integrations. There is no
 * CloudKit, no Drive or Dropbox or OneDrive API, no OAuth, no account created,
 * asked for or stored, and nothing in this file opens a socket. The reader picks
 * the folder their client keeps in sync; the provider records which service that
 * folder belongs to so the panel can say where the file went. A provider today is
 * therefore a label plus a folder.
 *
 * That is the seam, and it is the whole reason for it: when one of these becomes
 * a real integration it grows a provider of its own with the same four members —
 * CloudKit, or an OAuth token — and `sync.ts` does not change. It is also why
 * `id` is a union of services rather than a boolean per service: a build that has
 * two of them cannot describe itself with flags without lying about the third.
 *
 * The merge vocabulary still says "the folder's copy" (`SyncConflict.kept`) for
 * the other device's side of a document. That is the merge's language and it is
 * deliberately untouched; a provider changes where the bytes live, not how two
 * libraries are reconciled.
 */
import { LocalStorageError } from "./driver";
import { MemorySyncFolder, syncFolderAt, type SyncFolder } from "./sync-folder";

/** Every place a document can live in this build. */
export type SyncProviderId = "icloud" | "gdrive" | "dropbox" | "onedrive" | "folder";

/** What the engine needs from wherever the document lives. */
export interface SyncProvider {
  readonly id: SyncProviderId;
  readonly label: string;
  /** The document, or null when nothing has been written there yet. */
  read(): Promise<string | null>;
  /** Replaces the document in one step, so a reader never sees half of one. */
  write(document: string): Promise<void>;
  /** For the UI: where it writes, in words a reader understands. */
  describe(): string;

  /*
   * Path-scoped members, for the canonical file set in `docs/sync-format.md`.
   *
   * Optional so that every provider written against the single document keeps working while the
   * engine moves to `manifest.json`, `library.json`, `state.json`, `preferences.json`,
   * `positions.json`, `tombstones.json` and `devices.json`. A provider that implements only
   * `read`/`write` keeps handing over the whole document; one that implements these can be asked for
   * one file at a time, which is what makes a position write not rewrite the library.
   *
   * **Bytes, not strings.** Encryption sits above this layer — one implementation encrypts the
   * canonical files and every provider receives the same encrypted bytes — so a provider must never
   * assume the payload is text. A provider that only speaks strings can decode UTF-8 and say so.
   *
   * `revision` is the change detector a provider can offer natively (an ETag, a version, a modified
   * time). It is optional too: an engine that cannot ask compares the bytes it already has.
   */
  readFile?(path: string): Promise<Uint8Array | null>;
  writeFile?(path: string, data: Uint8Array): Promise<void>;
  deleteFile?(path: string): Promise<void>;
  list?(path: string): Promise<SyncFile[]>;
  revision?(path: string): Promise<string | null>;
}

/** One file in a provider's folder, as `list()` reports it. */
export interface SyncFile {
  /** Path relative to the sync folder, e.g. `library.json`. */
  readonly path: string;
  readonly size: number;
  /** The provider's own change marker, when it has one. */
  readonly revision: string | null;
}

/**
 * The reader-facing name and place of each id.
 *
 * `place` is the folder-backed truth of v1: the line a panel can show without
 * promising an integration that does not exist. It names the service because the
 * folder *is* the service's folder, mirrored by the service's own client.
 */
export const SYNC_PROVIDERS: Readonly<
  Record<SyncProviderId, { readonly label: string; readonly place: string }>
> = {
  icloud: {
    label: "iCloud Drive",
    place: "the iCloud Drive folder your Mac or iPhone already keeps in sync",
  },
  gdrive: {
    label: "Google Drive",
    place: "the Google Drive folder your Drive app already keeps in sync",
  },
  dropbox: {
    label: "Dropbox",
    place: "the Dropbox folder your Dropbox app already keeps in sync",
  },
  onedrive: {
    label: "OneDrive",
    place: "the OneDrive folder your OneDrive app already keeps in sync",
  },
  folder: {
    label: "A folder",
    place: "a folder on this device, or on a network share",
  },
};

/** Every id, for a panel that lists them. Ordered as a reader would look. */
export const SYNC_PROVIDER_IDS: readonly SyncProviderId[] = [
  "icloud",
  "gdrive",
  "dropbox",
  "onedrive",
  "folder",
];

/**
 * A folder, wearing the name of the service it belongs to.
 *
 * The folder does the work (`sync-folder.ts`, and `src-tauri/src/sync.rs` on the
 * desktop); this class is what lets the engine stop knowing that. `where` is the
 * path the reader chose, when the caller knows it — a panel does, a test need
 * not.
 */
export class FolderSyncProvider implements SyncProvider {
  readonly id: SyncProviderId;
  readonly label: string;
  private readonly folder: SyncFolder;
  private readonly where: string;

  constructor(id: SyncProviderId, folder: SyncFolder, where = "") {
    this.id = id;
    this.label = SYNC_PROVIDERS[id].label;
    this.folder = folder;
    this.where = where.trim();
  }

  async read(): Promise<string | null> {
    return this.folder.read();
  }

  async write(document: string): Promise<void> {
    await this.folder.write(document);
  }

  describe(): string {
    const place = SYNC_PROVIDERS[this.id].place;
    return this.where === "" ? place : `${place}: ${this.where}`;
  }
}

/**
 * A provider that lives in this process only.
 *
 * A `MemorySyncFolder` with an id, so the suite can drive two simulated devices
 * through the merge without a filesystem. Its id is `folder` because that is
 * what it stands in for: a place both devices can see. It is never offered to a
 * reader — it forgets everything when the process ends.
 */
export class MemorySyncProvider extends MemorySyncFolder implements SyncProvider {
  readonly id: SyncProviderId = "folder";
  readonly label = SYNC_PROVIDERS.folder.label;

  describe(): string {
    return "a folder that lives only in memory, for tests";
  }
}

/**
 * A provider for a folder the reader chose, named by the service they picked.
 *
 * The path rules are `syncFolderAt`'s: a folder needs a path, and a build that
 * cannot reach a folder on the device (a browser tab) is refused here rather than
 * offered a switch that does nothing. No service account is involved in any id —
 * see the top of this file.
 */
export function syncProviderAt(id: SyncProviderId, path: string): SyncProvider {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new LocalStorageError("A sync folder needs a path before it can hold anything");
  }
  return new FolderSyncProvider(id, syncFolderAt(trimmed), trimmed);
}
