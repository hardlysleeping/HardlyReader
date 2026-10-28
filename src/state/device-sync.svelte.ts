/**
 * Device sync, as the Settings section drives it.
 *
 * The engine is `api/local/sync.ts` (one document, three-way merge against the
 * last agreement) and the transport is a `SyncProvider`. This module is the
 * third thing: what this device has chosen, and the run itself — so the section
 * draws rows and presses a button, and nothing in the UI touches a merge.
 *
 * Five rules it keeps.
 *
 * - **A run is unreachable without a provider and a folder.** `syncNow()` refuses
 *   before it calls the engine, because a sync with nowhere to write would build
 *   a document and throw it away. Both refusals are sentences, not exceptions: a
 *   settings row has room for one line and no room for a modal.
 * - **A failed run changes nothing.** The record is written only after the engine
 *   answers, so the agreement (`base`) and the last-run time are exactly what
 *   they were; the library is the engine's business and a read that throws
 *   reaches nothing at all.
 * - **Choosing another service is a migration, not a re-connect.** The provider
 *   that is *in use* changes only when `switchProvider` has read the old copy,
 *   merged it, written the new one and read it back. `pending` is the service the
 *   reader picked in the meantime, and it is not authority: a failed migration
 *   clears it, so the rows go back to the provider this device is actually on
 *   and the one line under them says which step stopped.
 * - **One folder per provider, per profile.** The record lives under a device
 *   key scoped to the profile (`lib/sync-setup`), never in the synced settings
 *   document: a path is a fact about this computer.
 * - **No billing here.** Whether sync is paid for is
 *   `state/entitlements.svelte.ts`; this file would run the same for a reader
 *   who owns it and one who never did. The section decides what to draw, and
 *   only the section reads the entitlement.
 */
import { SYNC_FILE_NAME, ProviderSwitchError, switchProvider, syncOnce, type SyncPrefs, type SyncRun, type SwitchRun } from "../api/local/sync";
import {
  exportArchive,
  importArchive,
  type ArchiveExport,
  type ArchiveImport,
} from "../api/local/sync-archive";
import { SYNC_PROVIDERS, syncProviderAt, type SyncProvider, type SyncProviderId } from "../api/local/sync-provider";
import { foldersAvailable } from "../api/local/sync-folder";
import type { LocalStore } from "../api/local/store";
import type { AccountIdentity } from "../lib/account-key";
import type { ReaderProfile } from "../api/profile";
import { describeLastSynced, emptySetup, folderFor, withFolder, withImport, withProvider, withRun, withSwitch, readSetup, writeSetup, type SyncSetup, SYNC_CHOICES } from "../lib/sync-setup";

/** What the paid tier adds for one backend — `upgradePitch` in `lib/capabilities`. */
type UpgradePitch = ReturnType<typeof import("../lib/capabilities").upgradePitch>;

/** Why something failed, as a line rather than a stack. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "The sync did not finish";
}

/**
 * Whether Settings draws the section at all, and it is the ladder's answer.
 *
 * Three cases, and they are three different sentences:
 *
 * - **A library on this device** has to have feeds in it: nothing appears on first
 *   launch, because a reader with an empty library has nothing to sync and must
 *   never be shown a price. What buying adds is the mirror of a library they
 *   already own.
 * - **A server that already carries every extra** (`pitch === "nothing"`) has
 *   nothing to sell, and the section draws the one line that says so instead of a
 *   price. Hiding it would leave a reader wondering what Sync is for; selling it
 *   would be selling them what their own server does.
 * - **A server missing some extras** is not offered the mirror yet: a run merges a
 *   `LocalStore`, and a server profile has no library on this device to hand the
 *   engine. The section stays away rather than selling a run that would refuse.
 *
 * A function rather than an expression inside the panel, so the four cases can be
 * tested without drawing a sheet.
 */
export function showsDeviceSync(
  profile: ReaderProfile | null,
  feeds: number,
  pitch: UpgradePitch,
): boolean {
  if (profile === null) return false;
  if (profile.kind === "local") return feeds > 0;
  return pitch === "nothing";
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

  /**
   * Providers by service, for the suite: a switch needs two folders it can drive
   * separately, and `override` can only ever be one.
   */
  private overrides = $state.raw<Partial<Record<SyncProviderId, SyncProvider>>>({});

  /**
   * The service the reader picked that this device has not moved to yet.
   *
   * Not authority: `setup.provider` is the provider the document lives with until
   * `switchProvider` has finished, and this is cleared on both a failure and a
   * success. It exists so the rows can show the folder of the service being
   * switched *to* while the migration runs.
   */
  pending = $state<SyncProviderId | null>(null);

  /**
   * The service this device left, after a switch that finished, so the panel can
   * say the old file is still where the reader put it. Cleared by the next choice.
   */
  movedFrom = $state<{ label: string; where: string } | null>(null);

  /** The provider the document lives with, or null before the reader has chosen. */
  get provider(): SyncProviderId | null {
    return this.setup.provider;
  }

  /**
   * The provider the rows are about: the one being switched to while a switch is
   * pending, and otherwise the one in use. Only drawing reads this — a run never
   * does, because a run must write where the document already is.
   */
  get shown(): SyncProviderId | null {
    return this.pending ?? this.setup.provider;
  }

  /** True while the reader has picked a service this device has not moved to. */
  get switching(): boolean {
    return this.pending !== null;
  }

  /** Its label, for the rows that have to name it. */
  get providerLabel(): string {
    return this.setup.provider === null ? "" : SYNC_PROVIDERS[this.setup.provider].label;
  }

  /** The folder chosen for the provider the rows are about, or "" when none has been. */
  get folder(): string {
    return folderFor(this.setup, this.shown);
  }

  /** Whether the provider the rows are about has a folder, which is what makes a run possible. */
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
   * disk, and `options.providers` the same per service — a switch needs two
   * folders, and one stand-in can only be one. Nothing else passes either.
   */
  bind(
    library: LocalStore | null,
    identity: AccountIdentity | null,
    options: { provider?: SyncProvider | null; providers?: Partial<Record<SyncProviderId, SyncProvider>> } = {},
  ): void {
    this.library = library;
    this.identity = identity;
    this.override = options.provider ?? null;
    this.overrides = options.providers ?? {};
    this.pending = null;
    this.movedFrom = null;
    this.note = null;
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    this.setup = readSetup(storage, identity);
  }

  /**
   * The reader picked a service.
   *
   * Three cases, and only the middle one is a migration:
   *
   * - the same service, or no service has been chosen yet — remembered, nothing
   *   else to do;
   * - a service with no folder here, or no library on this device — remembered
   *   too: there is no document to move, so there is nothing to migrate;
   * - otherwise the reader is *changing where the document lives*, and that is
   *   `switchProvider`'s job. The service in use does not change here.
   *
   * `prefs` is the settings half the migration needs. It is optional so a caller
   * that only wants to remember a choice — a suite, a preview — can still do so;
   * with the folder already known, the switch starts on this call.
   */
  choose(provider: SyncProviderId | null, prefs?: SyncPrefs): void {
    if (provider === this.setup.provider) {
      this.pending = null;
      this.note = null;
      return;
    }
    this.movedFrom = null;

    const inUse = this.setup.provider;
    const migrating =
      inUse !== null && this.library !== null && folderFor(this.setup, inUse) !== "" && provider !== null;

    if (!migrating) {
      this.setup = withProvider(this.setup, provider);
      this.pending = null;
      this.note = null;
      this.save();
      return;
    }

    this.pending = provider;
    this.note = null;
    // A service whose folder was chosen on an earlier visit needs nothing else:
    // the migration can run now. One without a folder waits for the picker, and
    // `setFolder` starts it.
    if (prefs !== undefined && folderFor(this.setup, provider) !== "") {
      void this.switchNow(prefs);
    }
  }

  /**
   * The reader chose the folder this service mirrors.
   *
   * The path is taken as given — `syncProviderAt` refuses an empty one and a
   * build that cannot reach a folder, and that refusal is a sentence the row
   * shows. A different folder for the provider **in use** is a different
   * document, so the agreement goes with the old one; a folder typed for the
   * service being switched to leaves it alone, because the document this device
   * is merging is still the old provider's.
   *
   * A switch that was waiting for this folder starts here.
   */
  setFolder(path: string, prefs?: SyncPrefs): void {
    const provider = this.shown;
    if (provider === null) {
      this.note = "Choose a provider first";
      return;
    }
    this.setup = withFolder(this.setup, provider, path);
    this.note = null;
    this.save();
    if (prefs !== undefined && this.pending === provider && provider !== this.setup.provider && this.hasFolder) {
      void this.switchNow(prefs);
    }
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
    // The folder of the provider the document is *with*, not the one the rows are
    // showing: a service the reader is switching to has no document to run on.
    const folder = folderFor(this.setup, provider);
    if (folder === "") {
      this.note = `Choose the folder ${SYNC_PROVIDERS[provider].label} keeps in sync`;
      return null;
    }
    if (this.running) return null;

    let transport: SyncProvider;
    try {
      transport = this.transportFor(provider, folder);
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

  /**
   * This device's library as an archive, or null when nothing was written.
   *
   * Not a sync and not a provider: a backup is the reader's own document, so this
   * needs a library and nothing else — no provider chosen, no folder, no
   * entitlement. `note` says why when it refuses, in the same one line a failed
   * run uses.
   */
  async exportArchiveNow(prefs: SyncPrefs): Promise<ArchiveExport | null> {
    const store = this.library;
    if (store === null) {
      this.note = "There is no library on this device to export";
      return null;
    }
    if (this.running) return null;
    this.running = true;
    try {
      return await exportArchive({
        store,
        device: deviceName(),
        base: this.setup.base,
        prefs,
      });
    } catch (error) {
      this.note = reasonOf(error);
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Merges an archive into this device's library.
   *
   * The same engine a sync runs — an import is a sync, not a replace — with the
   * last agreement as the three-way base when there is one. Nothing is written
   * to a provider: an archive is a file, not a place. The merged document
   * becomes this device's base so marks for posts it has not fetched yet are
   * still there when they arrive (`withImport`).
   *
   * A refusal — no library, a zip that is not an archive, a newer manifest —
   * lands in `note` and leaves the library, the record and the reader's settings
   * exactly as they were.
   */
  async importArchiveNow(bytes: Uint8Array, prefs: SyncPrefs): Promise<ArchiveImport | null> {
    const store = this.library;
    if (store === null) {
      this.note = "There is no library on this device to import into";
      return null;
    }
    if (this.running) return null;
    this.running = true;
    try {
      const result = await importArchive({
        store,
        device: deviceName(),
        base: this.setup.base,
        prefs,
        bytes,
      });
      this.setup = withImport(this.setup, result.snapshot);
      this.note = null;
      this.save();
      return result;
    } catch (error) {
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

  /**
   * The provider for one service, or the suite's stand-in for it.
   *
   * A build that cannot reach a folder at all (a browser tab) throws from
   * `syncProviderAt`, and that refusal is the sentence the rows show.
   */
  private transportFor(provider: SyncProviderId, folder: string): SyncProvider {
    return this.overrides[provider] ?? this.override ?? syncProviderAt(provider, folder);
  }

  /**
   * Moves the document to the service the reader picked.
   *
   * This is the whole of "a switch is a migration" in this module: the engine
   * reads the old copy, merges this library into it, writes the new copy, reads
   * it back and only then answers. Nothing here changes the provider in use
   * before that answer arrives, and a failure clears `pending` — so the rows go
   * back to the service this device is actually on, with one line naming the step
   * that stopped and saying that the old folder is still the provider.
   *
   * On success the record is written once: the new provider, the folder the
   * migration wrote, and **the document it wrote as the agreement**. That last
   * one is what stops a switched device from resurrecting the old provider's
   * state on its next run.
   *
   * Answers the migration, or null when there was nothing to do or it did not
   * finish.
   */
  async switchNow(prefs: SyncPrefs): Promise<SwitchRun | null> {
    const store = this.library;
    const target = this.pending;
    const inUse = this.setup.provider;
    if (store === null || target === null || inUse === null || target === inUse) return null;
    if (this.running) return null;

    const fromFolder = folderFor(this.setup, inUse);
    const toFolder = folderFor(this.setup, target);
    if (fromFolder === "" || toFolder === "") return null;

    let from: SyncProvider;
    let to: SyncProvider;
    try {
      from = this.transportFor(inUse, fromFolder);
      to = this.transportFor(target, toFolder);
    } catch (error) {
      // Step three of the migration: connecting. It is the one step the engine
      // cannot fail on, because the provider arrives as an argument.
      this.pending = null;
      this.note = new ProviderSwitchError(
        "connect",
        "to",
        SYNC_PROVIDERS[inUse].label,
        SYNC_PROVIDERS[target].label,
        reasonOf(error),
      ).message;
      return null;
    }

    this.running = true;
    try {
      const run = await switchProvider({
        store,
        from,
        to,
        device: deviceName(),
        base: this.setup.base,
        prefs,
      });
      this.setup = withSwitch(this.setup, target, run.snapshot, Date.now());
      this.pending = null;
      this.movedFrom = { label: SYNC_PROVIDERS[inUse].label, where: fromFolder };
      this.note = null;
      this.save();
      return run;
    } catch (error) {
      // The record is untouched — provider, folder, agreement and last-run time
      // all still describe the device that has not moved — and the engine's
      // sentence names the step that stopped.
      this.pending = null;
      this.note = reasonOf(error);
      return null;
    } finally {
      this.running = false;
    }
  }
}

export const deviceSync = new DeviceSyncState();
