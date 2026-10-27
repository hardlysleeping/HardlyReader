/**
 * The folder the sync document lives in.
 *
 * A local library has no server, so the shared copy of it is a file in a folder
 * the reader already syncs themselves: an iCloud Drive folder, a Google Drive
 * folder, a directory on a network share. This file is the only thing that
 * touches such a folder, and it is deliberately three methods wide — read the
 * document, write the document, and nothing else.
 *
 * Two shapes, for the same reason `open.ts` has two: the desktop build asks
 * Rust, a test asks an object. The memory folder is also the honest answer for
 * a runtime that cannot reach a folder at all (a browser tab), where the panel
 * says so rather than offering a switch that does nothing.
 *
 * The webview never names a file. It names a *folder*, and `src-tauri/src/sync.rs`
 * decides what goes inside it — a page that could name any path could write any
 * file, and this one only ever needs to write its own.
 */
import { LocalStorageError } from "./driver";

export interface SyncFolder {
  /** The document as the folder holds it, or null when nothing has been written. */
  read(): Promise<string | null>;
  /** Replaces the document in one step, so a reader never sees half of one. */
  write(contents: string): Promise<void>;
}

/** Whether this runtime can reach a folder on the device at all. */
export function foldersAvailable(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

/**
 * A folder on this device, through the two commands in `src-tauri/src/sync.rs`.
 *
 * `invoke` is imported on use rather than at the top of the file: a browser
 * build has no Tauri core to load, and a module that throws on import would take
 * the whole panel with it.
 */
export class NativeSyncFolder implements SyncFolder {
  private readonly path: string;

  constructor(path: string) {
    this.path = path.trim();
  }

  async read(): Promise<string | null> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("sync_read", { folder: this.path });
  }

  async write(contents: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sync_write", { folder: this.path, contents });
  }
}

/**
 * A folder that lives in this process only.
 *
 * Used by the suite, and by anything that wants to exercise a sync without a
 * filesystem. It refuses nothing and forgets everything when the process ends,
 * which is exactly the shape of a test double and exactly why it is not offered
 * to a reader as a place to keep their library.
 */
export class MemorySyncFolder implements SyncFolder {
  /** Every write, in order, so a test can count what a quiet sync did not do. */
  readonly writes: string[] = [];

  private contents: string | null;
  /** Set to make the next read fail, the way a folder with no permission does. */
  readError: Error | null = null;
  /** Set to make the next write fail. */
  writeError: Error | null = null;

  constructor(contents: string | null = null) {
    this.contents = contents;
  }

  async read(): Promise<string | null> {
    if (this.readError !== null) {
      const error = this.readError;
      this.readError = null;
      throw error;
    }
    return this.contents;
  }

  async write(contents: string): Promise<void> {
    if (this.writeError !== null) {
      const error = this.writeError;
      this.writeError = null;
      throw error;
    }
    this.contents = contents;
    this.writes.push(contents);
  }

  /** What the folder holds now, for a test that wants to parse it. */
  peek(): string | null {
    return this.contents;
  }
}

/** The folder for a path the reader chose, or a refusal a panel can show. */
export function syncFolderAt(path: string): SyncFolder {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new LocalStorageError("A sync folder needs a path before it can hold anything");
  }
  if (!foldersAvailable()) {
    throw new LocalStorageError(
      "This build cannot reach a folder on the device, so a sync folder needs the desktop app",
    );
  }
  return new NativeSyncFolder(trimmed);
}
