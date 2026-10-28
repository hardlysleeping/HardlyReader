<script module lang="ts">
  import type { SyncPrefs } from "../api/local/sync";
  import type { PrefsDoc, PrefsNamespace } from "../lib/prefs-sync";
  import { prefs as accountPrefs } from "../state/prefs.svelte";
  import { reader } from "../state/reader.svelte";

  /**
   * What one run hands the engine.
   *
   * Three halves of one document: the settings, the sidebar's arrangement
   * (hidden, pins, both views, the indent, the two orders) and the reading
   * place. The engine merges each on its own stamp — `api/local/sync.ts` — and
   * the reader fills in and adopts the two that are its own. Nothing here
   * merges: `adopt` is called by the engine with the value its merge kept, and
   * each half hands it to the state that draws it.
   *
   * It lives at module scope, and is exported, for one reason: this is the seam
   * where the app joins the engine and the reader. Each side is proved on its
   * own (`tests/unit/authority.mjs`, `reader.svelte.ts`), and only this function
   * can show that a press in Settings actually carries them —
   * `tests/unit/device-sync-wiring.mjs`. A local profile is the only caller that
   * reaches it: `deviceSync.bind(localStoreOf(profile))` binds a library for a
   * profile read on this device and nothing else, and the run refuses before it
   * reads or writes when there is none.
   */
  export function syncPrefs(): SyncPrefs {
    return {
      local: accountPrefs.deviceDoc(),
      adopt: (doc: PrefsDoc, namespaces: PrefsNamespace[]) =>
        accountPrefs.adoptFromDevice(doc, namespaces),
      sidebar: {
        local: reader.sidebarDoc(),
        adopt: (doc) => reader.adoptSidebar(doc),
      },
      place: {
        local: reader.placeDoc(),
        adopt: (doc) => reader.adoptPlace(doc),
      },
    };
  }
</script>

<script lang="ts">
  /**
   * Device sync, in Settings.
   *
   * Two halves, and the entitlement alone decides which one is drawn:
   *
   * - no `cloudSync` — what syncing is for, and the one subscription that buys
   *   all four providers; and
   * - `cloudSync` — the provider, its folder, when it last ran and the button.
   *
   * Before either, one question the reader's own ladder answers (`reader.upgradePitch`):
   * a server that already carries every extra has **nothing** to buy, and the section
   * says so in a line rather than drawing a price for what that server does already.
   *
   * The rows are the card's own words. Nothing here merges, writes a document or
   * knows what a product id costs: `state/device-sync.svelte.ts` owns the run,
   * `state/entitlements.svelte.ts` owns what was bought, and this file is the
   * drawn result. The one thing that is not drawing is `syncPrefs()` — module
   * scope, above — which hands the engine the settings, the arrangement and the
   * place.
   *
   * Two rules the section keeps, both from the owner:
   *
   * - **A provider is a choice, and choosing one opens the folder picker.** All
   *   four services are behind the same purchase — picking Dropbox after iCloud
   *   asks for a folder, never for money — and each service remembers its own
   *   folder on this device (`lib/sync-setup`).
   * - **A failure is one line, never a modal.** A folder that cannot be read says
   *   so under the button and leaves the library, the agreement and the folder
   *   exactly as they were.
   */
  import { SYNC_PROVIDERS, type SyncProviderId } from "../api/local/sync-provider";
  import { describeCounts, describeImport } from "../api/local/sync-archive";
  import { saveArchiveFile } from "../lib/archive-file";
  import { localStoreOf, scopeIdentity, type ReaderProfile } from "../api/profile";
  import {
    SYNC_MONTHLY,
    SYNC_YEARLY,
    entitlement,
    type Product,
  } from "../state/entitlements.svelte";
  import { deviceSync } from "../state/device-sync.svelte";

  let { profile = null }: { profile?: ReaderProfile | null } = $props();

  /**
   * The record follows the profile the window is reading, so a second profile
   * finds its own provider and its own folder rather than the last one's. A
   * signed-in profile has no library on this device, and the section is not drawn
   * for it.
   */
  $effect(() => {
    deviceSync.bind(localStoreOf(profile), scopeIdentity(profile));
  });

  /** The one button: hand the engine the three halves and let it run. */
  function runSync(): void {
    void deviceSync.syncNow(syncPrefs());
  }

  /**
   * The archive rows: a copy the reader keeps, and one they bring back.
   *
   * Not a sync and not a provider — the export needs a library and nothing else,
   * and the import merges through the same engine a sync runs. Which is the whole
   * point: no service can hold this library hostage if the reader already has it
   * in a file of their own. `archiveNote` is the one line under the buttons,
   * because a settings sheet has room for one.
   */
  let archiveNote = $state<string | null>(null);
  let archiveBusy = $state(false);

  async function saveArchive(): Promise<void> {
    if (archiveBusy) return;
    archiveBusy = true;
    archiveNote = null;
    try {
      const archive = await deviceSync.exportArchiveNow(syncPrefs());
      if (archive === null) {
        archiveNote = deviceSync.note;
        return;
      }
      const saved = await saveArchiveFile(archive.bytes, describeCounts(archive.counts));
      archiveNote = saved.note;
    } catch (error) {
      archiveNote = error instanceof Error ? error.message : "The archive was not written.";
    } finally {
      archiveBusy = false;
    }
  }

  async function openArchive(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared at once, so choosing the same file twice is two presses rather
    // than a file input that has nothing to report the second time.
    input.value = "";
    if (file === undefined) return;
    if (archiveBusy) return;
    archiveBusy = true;
    archiveNote = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await deviceSync.importArchiveNow(bytes, syncPrefs());
      archiveNote = result === null ? deviceSync.note : describeImport(result);
    } catch (error) {
      archiveNote = error instanceof Error ? error.message : "The archive was not read.";
    } finally {
      archiveBusy = false;
    }
  }

  /** The path being typed. Seeded from the chosen provider's folder. */
  let typed = $state("");

  // A folder chosen elsewhere — or read back from this device's record — is what
  // the field starts from. Reading only `folder` keeps a keystroke from being undone.
  $effect(() => {
    typed = deviceSync.folder;
  });

  /**
   * The folder picker is open.
   *
   * Choosing a provider opens it — that is the moment the reader has to point at
   * the folder that service mirrors — and "Change" opens it for a folder that was
   * chosen before. The field takes focus when it opens, so a phone keyboard is
   * already up, and it closes again when a folder is used.
   */
  let picking = $state(false);
  let field = $state<HTMLInputElement | null>(null);

  /** The field is drawn while no folder has been chosen for this service, or on Change. */
  const showField = $derived(picking || !deviceSync.hasFolder);

  $effect(() => {
    if (!showField || field === null) return;
    field.focus();
    picking = false;
  });

  // The two prices of the one subscription. What the store says wins when there
  // is a store to ask — its price is already formatted and may be localised — and
  // otherwise these are the owner's own words, because a row that cannot say what
  // it costs is a row that cannot take the press either.
  const FALLBACK: Product[] = [
    { id: SYNC_YEARLY, price: "$9.99", period: "year" },
    { id: SYNC_MONTHLY, price: "$0.99", period: "month" },
  ];

  /**
   * Yearly first: it is the one the row recommends, and the recommendation is
   * drawn from the price, not asserted beside it.
   */
  const plans = $derived(
    (entitlement.offer.length > 0 ? entitlement.offer : FALLBACK)
      .slice()
      .sort((a, b) => (a.period === "year" ? -1 : b.period === "year" ? 1 : 0)),
  );

  /** The term the Start button buys. */
  let term = $state<string>(SYNC_YEARLY);

  /**
   * What to say when a press did not buy anything. The entitlement's own reason
   * first — it is the store's words — and otherwise the plain fact that this
   * build has no shop in it, which is not a failure and must not read like one.
   */
  let note = $state<string | null>(null);

  function planLabel(plan: Product): string {
    return `${plan.price} / ${plan.period === "year" ? "year" : "month"}`;
  }

  function saving(plan: Product): string | null {
    if (plan.period !== "year") return null;
    const monthly = plans.find((other) => other.period === "month");
    if (monthly === undefined) return null;
    const perYear = number(monthly.price) * 12;
    const yearly = number(plan.price);
    if (perYear <= 0 || yearly <= 0 || yearly >= perYear) return null;
    return `save ~${Math.round((1 - yearly / perYear) * 100)}%`;
  }

  /** The digits of a formatted price, or 0 when it cannot be read as one. */
  function number(price: string): number {
    const parsed = Number.parseFloat(price.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  let busy = $state(false);

  async function start(): Promise<void> {
    if (busy) return;
    note = null;
    busy = true;
    try {
      const bought = await entitlement.purchase(term);
      if (!bought) note = refusal();
    } finally {
      busy = false;
    }
  }

  async function restore(): Promise<void> {
    if (busy) return;
    note = null;
    busy = true;
    try {
      const restored = await entitlement.restore();
      if (!restored) note = refusal();
    } finally {
      busy = false;
    }
  }

  /** Why nothing was bought: the store's reason, or that there is no store here. */
  function refusal(): string {
    if (entitlement.reason !== null && entitlement.reason !== "") return entitlement.reason;
    return "HardlyReader Sync is not on sale in this build — it is bought in the App Store build.";
  }

  // What is for sale, once. A build with no shop answers instantly and says so;
  // asking again on every mount costs nothing and keeps the prices current.
  $effect(() => {
    void entitlement.loadProducts();
  });

  function choose(id: SyncProviderId): void {
    // Choosing another service is a migration: the state reads the old copy,
    // merges, writes the new one and reads it back before the provider in use
    // changes. The panel only has to open the picker when there is no folder for
    // the service yet — with one, the switch starts on this press.
    deviceSync.choose(id, syncPrefs());
    picking = !deviceSync.hasFolder;
    if (!picking) typed = deviceSync.folder;
  }

  function useFolder(): void {
    deviceSync.setFolder(typed, syncPrefs());
    if (deviceSync.hasFolder) picking = false;
  }

  /** The row's path, in one line: the tail is what tells the services apart. */
  const where = $derived(deviceSync.filePath);

  /**
   * What buying would add here, asked of the ladder rather than assumed.
   *
   * `nothing` is not a failure and not an empty section: it is the honest answer
   * for a server whose extensions already keep the hidden categories, the pins,
   * the ordering, the indent and the reading position.
   */
  const pitch = $derived(reader.upgradePitch);
</script>

{#if pitch === "nothing"}
  <!-- A server that carries every extra already: nothing to buy, and saying so is
       the whole of the section. -->
  <p class="lede">Nothing to buy</p>
  <p class="hint">
    This server's Hardly Read extensions keep hidden categories, pinned categories, the
    ordering, the sidebar indent and your reading position already. There is nothing for a
    subscription to add here.
  </p>
{:else if entitlement.cloudSync}
  <!-- Entitled: the four services, one folder each, and the run. -->
  <div class="active">
    <span class="name">HardlyReader Sync</span>
    <span class="tick" aria-label="active">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
      active
    </span>
  </div>

  <div class="row wide">
    <span class="key" id="sync-provider-key">Provider</span>
    <div class="choices" role="radiogroup" aria-labelledby="sync-provider-key">
      {#each deviceSync.choices as id (id)}
        <button
          class="pick"
          class:on={deviceSync.shown === id}
          role="radio"
          aria-checked={deviceSync.shown === id}
          aria-label={SYNC_PROVIDERS[id].label}
          title={SYNC_PROVIDERS[id].place}
          onclick={() => choose(id)}
        >
          <span class="dot" aria-hidden="true"></span>{SYNC_PROVIDERS[id].label}
        </button>
      {/each}
    </div>
  </div>

  {#if deviceSync.switching}
    <!-- The service being switched to is not in use yet, and the reader is about
         to point at its folder. Said in the row's own words so the picker is not
         mistaken for a finished move. -->
    <p class="hint">
      Moving to {SYNC_PROVIDERS[deviceSync.shown].label}: its folder is all that is
      missing. Nothing changes until the copy has been written there and read back.
    </p>
  {:else if deviceSync.provider !== null}
    <p class="hint">
      Switching service copies your library into the new folder and switches over
      only once it has read the copy back. The file in the old folder is never
      deleted — it stays where you put it.
    </p>
  {/if}

  <div class="row wide">
    <span class="key">Folder</span>
    {#if showField}
      <!-- The picker: a path, and one button that takes it. A folder is chosen
           once per service, so this is drawn only when there is none or when
           Change asks for it back. -->
      <div class="field">
        <input
          class="path"
          bind:this={field}
          type="text"
          aria-label="Sync folder"
          spellcheck="false"
          autocomplete="off"
          placeholder="~/…"
          disabled={deviceSync.shown === null}
          bind:value={typed}
        />
        <button
          class="do"
          disabled={deviceSync.shown === null || typed.trim() === ""}
          title="Use this folder for the shared document"
          onclick={useFolder}>Use</button>
      </div>
    {:else}
      <!-- Chosen once and remembered: the row is a value, not a form. The tail of
           a path is what tells two services apart, so it is shown in full as far
           as one line goes, with the whole of it on hover. -->
      <div class="field">
        <span class="path-line" title={where}>{deviceSync.folder}</span>
        <button
          class="do"
          title="Choose a different folder for this service"
          onclick={() => (picking = true)}>Change</button>
      </div>
    {/if}
  </div>

  {#if !deviceSync.hasFolder}
    <p class="hint">
      Point this at the {deviceSync.shown === null
        ? "folder your service syncs"
        : SYNC_PROVIDERS[deviceSync.shown].place}. It holds reading state, not articles.
    </p>
  {/if}

  <div class="row end">
    <span class="key">Last synced: <span class="when">{deviceSync.lastSyncedAt()}</span></span>
    <button
      class="do strong"
      aria-label="Sync now"
      disabled={deviceSync.running || !deviceSync.hasFolder || !deviceSync.available}
      title={deviceSync.hasFolder
        ? "Read the folder, merge both devices and write the result back"
        : "Choose a provider and its folder first"}
      onclick={runSync}
    >{deviceSync.running ? "Syncing…" : "Sync now"}</button>
  </div>

  {#if deviceSync.note !== null}
    <!-- One line, and it is the whole report: a run that failed says why here
         and leaves everything it did not finish alone. A switch that failed says
         which step stopped and that the old folder is still the provider. -->
    <p class="hint bad" role="status">{deviceSync.note}</p>
  {/if}

  {#if deviceSync.movedFrom !== null}
    <!-- The one thing a reader has to know after a migration: this app took a
         copy, and left theirs where it was. -->
    <p class="hint" role="status">
      Moved to {deviceSync.providerLabel}. The {deviceSync.movedFrom.label} file is
      still at {deviceSync.movedFrom.where} — this app never deletes it.
    </p>
  {/if}

  <p class="hint">
    Feeds, folders, read marks, stars, settings and reading position travel.
    Article text, pictures and fetch times stay on the device that fetched them.
  </p>
{:else}
  <!-- Free: what the feature is, and the one subscription that buys all four. -->
  <p class="lede">Sync across your devices</p>
  <p class="hint">
    Keep feeds, folders, read status, stars, preferences and reading position in
    sync. Use your own iCloud, Google Drive, Dropbox or OneDrive.
  </p>

  <div class="plans" role="radiogroup" aria-label="Billing period">
    {#each plans as plan (plan.id)}
      <button
        class="plan"
        class:on={term === plan.id}
        role="radio"
        aria-checked={term === plan.id}
        aria-label={planLabel(plan)}
        onclick={() => (term = plan.id)}
      >
        <span class="dot" aria-hidden="true"></span>{planLabel(plan)}
        {#if saving(plan) !== null}
          <span class="save">({saving(plan)})</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="actions">
    <button class="do strong" disabled={busy} onclick={() => void start()}>
      {busy ? "Working…" : "Start HardlyReader Sync"}
    </button>
    <button class="do" disabled={busy} onclick={() => void restore()}>Restore Purchase</button>
  </div>

  {#if note !== null}
    <!-- Why a purchase or a restore did not happen: the App Store is the only
         place this is sold, and a build without one says so instead of taking a
         press that cannot charge anything. -->
    <p class="hint bad" role="status">{note}</p>
  {/if}
{/if}

{#if deviceSync.attached}
  <!-- Portability, drawn whatever the entitlement says: a copy of the reader's
       own sync data is not something a subscription can gate, and the whole
       point of the feature is a library no provider can hold hostage. -->
  <div class="portable">
    <div class="row end">
      <span class="key">Archive</span>
      <div class="archive-actions">
        <button
          class="do"
          disabled={archiveBusy || deviceSync.running}
          title="Write a zip of your sync data"
          onclick={() => void saveArchive()}>Export archive</button>
        <label
          class="do"
          class:off={archiveBusy || deviceSync.running}
          title="Merge an archive into this library — nothing here is replaced">
          Import archive
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={archiveBusy || deviceSync.running}
            onchange={(event) => void openArchive(event)}
          />
        </label>
      </div>
    </div>
    <p class="hint">
      A copy of your sync data you can keep, or move to another provider.
    </p>
    {#if archiveNote !== null}
      <p class="hint" role="status">{archiveNote}</p>
    {/if}
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  /* The provider chips and the path both need the whole width on a phone, so
     the row is a wrapping pair: label on its own line, control under it. */
  .row.wide {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .row.end {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-dim);
  }

  .when {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .active {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 0 6px;
  }

  .name {
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  /* The tick is a mark, not a control: it says the entitlement is live. */
  .tick {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
    font-size: 11px;
  }

  .tick svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The four services: a grid rather than a wrapping run, so 390px draws two
     even rows instead of three and a stray. */
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 4px 6px;
    padding: 2px 0;
    width: 100%;
  }

  /* The two terms are a sentence with two choices in it, not a grid: they read
     as "$9.99 / year (save ~16%)   ·   $0.99 / month". */
  .plans {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    padding: 4px 0 6px;
  }

  .pick,
  .plan {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 5px;
    min-height: 32px;
    padding: 4px 9px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .plan {
    /* A thumb's height, the same floor the buttons use: a price is a choice, and
       a choice a thumb can miss is not one. */
    min-height: 32px;
    padding: 2px 2px;
    font-size: 12.5px;
  }

  .pick:hover,
  .plan:hover {
    background: var(--hover);
    color: var(--text);
  }

  .pick.on,
  .plan.on {
    color: var(--text);
  }

  .pick:focus-visible,
  .plan:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  /* The ring of a radio, drawn rather than borrowed: a platform radio is 13px
     and cannot be told from the label at arm's length. */
  .dot {
    display: inline-block;
    flex: 0 0 auto;
    width: 11px;
    height: 11px;
    border: 1px solid var(--muted);
    border-radius: 50%;
  }

  .on > .dot {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 3px var(--accent);
  }

  .save {
    color: var(--muted);
    font-size: 11px;
  }

  .field {
    display: flex;
    align-items: center;
    /* A flex item's automatic minimum is its content's: a path is one long
       unbreakable string, so without this the row is as wide as the path. */
    min-width: 0;
    max-width: 100%;
    flex: 1 1 100%;
    gap: 4px;
  }

  .path {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 32px;
    padding: 3px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .path::placeholder {
    color: var(--muted);
  }

  .path:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .path:focus-visible {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .do {
    flex: 0 0 auto;
    min-height: 32px;
    padding: 3px 11px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .do.strong {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft));
    color: var(--text);
  }

  .do:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--border);
  }

  .do:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .do:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 0 4px;
  }

  /* The two archive buttons, side by side where they fit and stacked where they
     do not: a phone held upright has 390px and neither label shortens. */
  .archive-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  /* The import is a label around a hidden input — the file picker cannot be
     styled, so the label is the control and the input is what it opens. */
  .portable input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .do {
    display: inline-flex;
    align-items: center;
  }

  .do.off {
    opacity: 0.45;
    cursor: default;
  }

  .actions .do {
    flex: 1 1 auto;
    justify-content: center;
    padding: 6px 10px;
    font-size: 12.5px;
  }

  .lede {
    margin: 2px 0 3px;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  .hint {
    margin: 0 0 3px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* A path is one line: the folder it names is long, and a wrapped path is a
     row that changes height as the reader moves between services. */
  .path-line {
    flex: 1 1 0;
    min-width: 0;
    align-self: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  /* A failure is a sentence the reader has to read, so it is not muted grey. */
  .bad {
    color: var(--text-dim);
  }
</style>
