/**
 * Device sync, as the Settings section drives it.
 *
 * The engine is `api/local/sync.ts` (one document, three-way merge against the
 * last agreement) and the transport is a `SyncProvider`. This module is the
 * third thing: what this device has chosen, and the run itself — so the section
 * draws rows and presses a button, and nothing in the UI touches a merge.
 *
 * Four rules it keeps.
 *
 * - **A run is unreachable without a provider and a folder.** `syncNow()` refuses
 *   before it calls the engine, because a sync with nowhere to write would build
 *   a document and throw it away. Both refusals are sentences, not exceptions: a
 *   settings row has room for one line and no room for a modal.
 * - **A failed run changes nothing.** The record is written only after the engine
 *   answers, so the agreement (`base`) and the last-run time are exactly what
 *   they were; the library is the engine's business and a read that throws
 *   reaches nothing at all.
 * - **One folder per provider, per profile.** The record lives under a device
 *   key scoped to the profile (`lib/sync-setup`), never in the synced settings
 *   document: a path is a fact about this computer.
 * - **No billing here.** Whether sync is paid for is
 *   `state/entitlements.svelte.ts`; this file would run the same for a reader
 *   who owns it and one who never did. The section decides what to draw, and
 *   only the section reads the entitlement.
 */
import { SYNC_FILE_NAME, syncOnce, type SyncPrefs, type SyncRun } from "../api/local/sync";
import { SYNC_PROVIDERS, syncProviderAt, type SyncProvider, type SyncProviderId } from "../api/local/sync-provider";
import { foldersAvailable } from "../api/local/sync-folder";
import type { LocalStore } from "../api/local/store";
import type { AccountIdentity } from "../lib/account-key";
import type { ReaderProfile } from "../api/profile";
import { describeLastSynced, emptySetup, folderFor, withFolder, withProvider, withRun, readSetup, writeSetup, type SyncSetup, SYNC_CHOICES } from "../lib/sync-setup";

/** Why something failed, as a line rather than a stack. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "The sync did not finish";
}

/**
 * Whether Settings draws the section at all.
 *
 * A library has to be **on this device** (a signed-in reader's library is
 * FreshRSS's, and it already keeps itself in step), and it has to **have feeds in
 * it**: nothing appears on first launch, because a reader with an empty library
 * has nothing to sync and must never be shown a price.
 *
 * A function rather than an expression inside the panel, so the two halves of
 * that sentence can be tested without drawing a sheet.
 */
export function showsDeviceSync(profile: ReaderProfile | null, feeds: number): boolean {
  return profile !== null && profile.kind === "local" && feeds > 0;
}

/** What to call this device in the document. */
function deviceName(): string {
  const platform = typeof navigator === "undefined" ? "" : (navigator.platform ?? "").trim();
  return platform === "" ? "this device" : platform;
}

export class DeviceSyncState {
  /** This device's choices: the provider, its folder, the agreement, the last run. */
  setup = $state<SyncSetup>(emptySetup());

  /** A run is in flight. The button says so and does nothing. */
  running = $state(false);

  /**
   * The one line under the rows: why a run did not happen, or why it failed.
   * Null when there is nothing to say — a run that worked speaks through the
   * "Last synced" row instead of a second sentence about it.
   */
  note = $state<string | null>(null);

  /** The store a run merges. Null while no library on this device is open. */
  private library = $state.raw<LocalStore | null>(null);

  /**
   * Whose record this is: the identity the device keys are scoped by, so a second
   * profile finds its own provider and its own folder.
   */
  private identity = $state.raw<AccountIdentity | null>(null);

  /** A provider that is not a folder on disk: the suite's, or a preview's. */
  private override = $state.raw<SyncProvider | null>(null);

  /** The provider the reader picked, or null before they have. */
  get provider(): SyncProviderId | null {
    return this.setup.provider;
  }

  /** Its label, for the rows that have to name it. */
  get providerLabel(): string {
    return this.setup.provider === null ? "" : SYNC_PROVIDERS[this.setup.provider].label;
  }

  /** The folder chosen for the provider in use, or "" when none has been. */
  get folder(): string {
    return folderFor(this.setup, this.setup.provider);
  }

  /** Whether the provider in use has a folder, which is what makes a run possible. */
  get hasFolder(): boolean {
    return this.folder !== "";
  }

  /** Whether this runtime can reach a folder at all; false in a browser tab. */
  get available(): boolean {
    return foldersAvailable();
  }

  /** Where the document is, for the row to print. */
  get filePath(): string {
    const folder = this.folder.replace(/\/+$/, "");
    return folder === "" ? "" : `${folder}/${SYNC_FILE_NAME}`;
  }

  /** The last run, in words. `now` is a parameter so the suite can fix the clock. */
  lastSyncedAt(now: number = Date.now()): string {
    return describeLastSynced(this.setup.lastSyncedAt, now);
  }

  /** The four services the section offers, in the order a reader looks for them. */
  get choices(): readonly SyncProviderId[] {
    return SYNC_CHOICES;
  }

  /** Whether a library is open on this device, which is the whole reach of a run. */
  get attached(): boolean {
    return this.library !== null;
  }

  /**
   * This device's library and record.
   *
   * `library` is the store a run merges, or null when the library lives on a
   * server; `identity` is what the device keys are scoped by, so a second profile
   * finds its own provider and its own folder rather than the last one's.
   *
   * `options.provider` is the suite's and a preview's way of replacing the folder
   * on disk. Nothing else passes one.
   */
  bind(
    library: LocalStore | null,
    identity: AccountIdentity | null,
    options: { provider?: SyncProvider | null } = {},
  ): void {
    this.library = library;
    this.identity = identity;
    this.override = options.provider ?? null;
    this.note = null;
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    this.setup = readSetup(storage, identity);
  }

  /** The reader picked a service. Its folder is remembered, so this may be all there is to do. */
  choose(provider: SyncProviderId | null): void {
    this.setup = withProvider(this.setup, provider);
    this.note = null;
    this.save();
  }

  /**
   * The reader chose the folder this service mirrors.
   *
   * The path is taken as given — `syncProviderAt` refuses an empty one and a
   * build that cannot reach a folder, and that refusal is a sentence the row
   * shows. A different folder is a different document, so the agreement goes
   * with the old one.
   */
  setFolder(path: string): void {
    const provider = this.setup.provider;
    if (provider === null) {
      this.note = "Choose a provider first";
      return;
    }
    this.setup = withFolder(this.setup, provider, path);
    this.note = null;
    this.save();
  }

  /**
   * Runs a sync now.
   *
   * Answers the run, or null when nothing ran — in which case `note` says why in
   * one line. The guards come first and in this order: no library, no provider,
   * no folder, no folder support on this runtime. Only then does the engine see
   * anything.
   *
   * `prefs` is the settings half of the document, injected by the panel from the
   * store that owns the preferences: this module runs the merge, it does not read
   * the reader's text size.
   */
  async syncNow(prefs: SyncPrefs): Promise<SyncRun | null> {
    const store = this.library;
    const provider = this.setup.provider;
    if (store === null) {
      this.note = "There is no library on this device to sync";
      return null;
    }
    if (provider === null) {
      this.note = "Choose a provider before syncing";
      return null;
    }
    if (!this.hasFolder) {
      this.note = `Choose the folder ${SYNC_PROVIDERS[provider].label} keeps in sync`;
      return null;
    }
    if (this.running) return null;

    let transport: SyncProvider;
    try {
      transport = this.override ?? syncProviderAt(provider, this.folder);
    } catch (error) {
      this.note = reasonOf(error);
      return null;
    }

    this.running = true;
    try {
      const run = await syncOnce({
        store,
        provider: transport,
        device: deviceName(),
        base: this.setup.base,
        prefs,
      });
      this.setup = withRun(this.setup, run.snapshot, Date.now());
      this.note = null;
      this.save();
      return run;
    } catch (error) {
      // The record is untouched: the agreement and the last-run time still
      // describe the last run that finished, so the next attempt compares
      // against the same base and nothing is lost.
      this.note = reasonOf(error);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Writes the record for the profile in use. */
  private save(): void {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    writeSetup(storage, this.identity, this.setup);
  }
}

export const deviceSync = new DeviceSyncState();
