<script lang="ts">
  import type { HiddenView } from "../api/hardlyread";
  import { PIN_VIEW_LABELS, nextPinView } from "../state/pins";
  import { reader } from "../state/reader.svelte";

  /** Hidden Categories' own words for its three views, in its own order. */
  const HIDDEN_CYCLE: HiddenView[] = ["hidden", "revealed", "only"];
  const HIDDEN_LABELS: Record<HiddenView, string> = {
    hidden: "Hidden",
    revealed: "Revealed",
    only: "Only",
  };

  let lockOpen = $state(false);
  let code = $state("");
  let changing = $state(false);

  const hiddenView = $derived(reader.hiddenView);
  const nextHidden = $derived(HIDDEN_CYCLE[(HIDDEN_CYCLE.indexOf(hiddenView) + 1) % HIDDEN_CYCLE.length]);
  const locked = $derived(reader.hiddenLocked);
  const pinView = $derived(reader.pinView);

  function cycleHidden() {
    if (!reader.hiddenAvailable || locked) return;
    void reader.setHiddenView(nextHidden);
  }

  function cyclePins() {
    void reader.cyclePinView();
  }

  async function submitUnlock(event: SubmitEvent) {
    event.preventDefault();
    if (code === "" || reader.hiddenBusy) return;
    const ok = await reader.unlockHidden(code);
    if (ok) {
      code = "";
      lockOpen = false;
    }
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    if (reader.hiddenBusy) return;
    const ok = await reader.setHiddenPasscode(code);
    if (ok) {
      code = "";
      changing = false;
    }
  }

  async function lockNow() {
    await reader.lockHidden();
    if (reader.hiddenLocked) lockOpen = false;
  }
</script>

<!-- The caret is a bar across the top of the band, not a button in the corner:
     collapsed, the bar is all that is left, and the controls drop out from
     under it. The arrow points up while they are showing (hide them) and down
     while they are hidden (bring them back), so the direction always describes
     what a click will do. -->
<div class="bandbox" class:collapsed={reader.bandCollapsed} class:locked={reader.hiddenLocked}>
  <button
    class="bar"
    onclick={() => reader.toggleBand()}
    aria-expanded={!reader.bandCollapsed}
    aria-label={reader.bandCollapsed ? "Show sidebar controls" : "Hide sidebar controls"}
    title={reader.bandCollapsed ? "Show controls" : "Hide controls"}
  >
    <svg class="caret" class:up={!reader.bandCollapsed} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>

  {#if !reader.bandCollapsed}
    <div class="band">
    <button
      class="ctl"
      class:active={hiddenView !== "hidden"}
      onclick={cycleHidden}
      disabled={!reader.hiddenAvailable || locked || reader.hiddenBusy}
      title={reader.hiddenAvailable
        ? locked
          ? "Locked"
          : `${HIDDEN_LABELS[hiddenView]} — click for ${HIDDEN_LABELS[nextHidden]}`
        : "Hidden Categories is not enabled on this server"}
      aria-label={`Hidden categories: ${HIDDEN_LABELS[hiddenView]}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {#if hiddenView === "hidden"}
          <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.1 4.2M6.6 6.6C4.3 8 2.7 10.2 2 12c1 2.5 5 7 10 7a9.9 9.9 0 0 0 5.4-1.6" />
        {:else}
          <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" />
          <circle cx="12" cy="12" r="3" />
        {/if}
      </svg>
      {#if !locked}<span class="lbl">{HIDDEN_LABELS[hiddenView]}</span>{/if}
    </button>

    <button
      class="ctl lock"
      class:active={locked}
      onclick={() => (lockOpen = !lockOpen)}
      disabled={!reader.hiddenAvailable}
      aria-expanded={lockOpen}
      title={locked ? "Locked" : "Unlocked"}
      aria-label={locked ? "Hidden categories are locked" : "Hidden categories are unlocked"}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        {#if locked}
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        {:else}
          <path d="M8 11V8a4 4 0 0 1 7.5-2" />
        {/if}
      </svg>
    </button>

    <button
      class="ctl"
      class:active={pinView !== "all"}
      onclick={cyclePins}
      disabled={reader.favoritesBusy}
      title={`${PIN_VIEW_LABELS[pinView]} — click for ${PIN_VIEW_LABELS[nextPinView(pinView)]}${
        reader.pinSource === "local" ? " (pins kept on this device)" : ""
      }`}
      aria-label={`Pins: ${PIN_VIEW_LABELS[pinView]}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" />
      </svg>
      {#if !locked}<span class="lbl">{PIN_VIEW_LABELS[pinView]}</span>{/if}
    </button>
  </div>
  {/if}
</div>

  {#if lockOpen}
    <div class="lockpanel" role="region" aria-label="Lock">
      {#if locked}
        <form class="code" onsubmit={submitUnlock}>
          <label for="unlock-code">Passcode</label>
          <input
            id="unlock-code"
            type="password"
            inputmode="numeric"
            maxlength="6"
            autocomplete="off"
            bind:value={code}
          />
          <button type="submit" class="primary" disabled={reader.hiddenBusy || code === ""}>Unlock</button>
        </form>
      {:else if reader.hiddenHasPasscode && !changing}
        <div class="row">
          <button class="primary" onclick={lockNow} disabled={reader.hiddenBusy}>Lock now</button>
          <button onclick={() => ((changing = true), (code = ""))}>Change passcode</button>
        </div>
      {:else}
        <form class="code" onsubmit={submitCode}>
          <label for="set-code">
            {reader.hiddenHasPasscode ? "New passcode" : "Set a passcode to enable locking"}
          </label>
          <input
            id="set-code"
            type="password"
            inputmode="numeric"
            maxlength="6"
            autocomplete="off"
            bind:value={code}
          />
          <button type="submit" class="primary" disabled={reader.hiddenBusy}>Save</button>
          {#if reader.hiddenHasPasscode}
            <button type="button" onclick={() => ((changing = false), (code = ""))}>Cancel</button>
          {/if}
        </form>
        {#if !reader.hiddenHasPasscode}
          <p class="hint">One to six digits. Clearing the passcode turns locking off.</p>
        {/if}
      {/if}
      {#if reader.lockNotice}
        <p class="notice" role="status">{reader.lockNotice}</p>
      {/if}
      <button class="close" onclick={() => ((lockOpen = false), (changing = false), (code = ""))}>Close</button>
    </div>
  {/if}

<style>
  .lockpanel .code {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .lockpanel .code label {
    flex: 1 1 100%;
    font-size: 11px;
    color: var(--muted);
  }

  .lockpanel .code input {
    flex: 1 1 4.5rem;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--sunken, #171717);
    color: inherit;
    font: inherit;
    letter-spacing: 0.15em;
  }

  .lockpanel .row {
    display: flex;
    gap: 6px;
  }

  .lockpanel .primary {
    border-color: var(--accent);
    color: var(--accent);
  }

  .lockpanel .hint {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--muted);
  }

  .lockpanel .notice {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--danger, #e06c75);
  }

  .bandbox {
    margin: 6px 8px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--band, #2f2f2f);
  }

  .bandbox.locked {
    background: var(--band-locked, #212121);
  }

  /* Full-width caret bar: the handle for the whole band, in both states. */
  .bar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 14px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    opacity: 0.5;
    cursor: pointer;
  }

  .bandbox.collapsed .bar {
    height: 20px;
  }

  .bar:hover,
  .bar:focus-visible {
    opacity: 1;
    background: var(--hover);
  }

  .bar .caret {
    width: 14px;
    height: 14px;
    transition: transform 0.15s ease;
  }

  .bar .caret.up {
    transform: rotate(180deg);
  }

  .band {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: stretch;
    gap: 4px;
    padding: 0 4px 4px;
  }

  .ctl {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 40px;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
  }

  .ctl.lock {
    min-width: 40px;
  }

  .ctl:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .ctl.active {
    color: var(--text);
    border-color: var(--accent, #0062b7);
  }

  .ctl:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .locked .ctl {
    min-height: 30px;
  }

  svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .lbl {
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .lockpanel {
    margin: -2px 8px 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .lockpanel p {
    margin: 0 0 6px;
  }

  .close {
    border: 0;
    background: none;
    color: var(--accent, #0078e0);
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
</style>
