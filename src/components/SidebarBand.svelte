<script lang="ts">
  import type { HiddenView } from "../api/hardlyread";
  import { chrome } from "../state/chrome.svelte";
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

  /**
   * The band answers a lock and an unlock with one small pulse of its own
   * colour — red going down, green coming back — rather than a light thrown
   * across the window. It is the band that changed, so the band is what
   * answers.
   */
  let pulse = $state<"lock" | "unlock" | null>(null);

  /** Whether the controls are being pulled out right now (see `.opening`). */
  let opening = $state(false);
  let reveal = $state<HTMLElement | undefined>(undefined);
  /** Natural height of the controls, so the expand can overshoot and settle. */
  let bandH = $state(0);

  let wasLocked = reader.hiddenLocked;
  let wasCollapsed = chrome.bandCollapsed;

  $effect(() => {
    const lockedNow = reader.hiddenLocked;
    if (lockedNow !== wasLocked) {
      wasLocked = lockedNow;
      pulse = lockedNow ? "lock" : "unlock";
    }
  });

  $effect(() => {
    const collapsedNow = chrome.bandCollapsed;
    if (collapsedNow !== wasCollapsed) {
      wasCollapsed = collapsedNow;
      // Only the way out gets the spring: closing by hand should feel like
      // putting something away, not like it is fighting back.
      if (!collapsedNow) opening = true;
    }
  });

  $effect(() => {
    if (chrome.bandCollapsed || reveal === undefined) return;
    const measured = reveal.scrollHeight;
    if (measured > 0 && measured !== bandH) bandH = measured;
  });

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

  /**
   * Locking is one press.
   *
   * The curtain is the point of the control: a confirmation step makes the
   * moment it is needed the moment it is slowest. If the extension has no
   * passcode yet there is nothing to lock *with*, so that is the only case that
   * opens a form, and it says so.
   */
  async function lockNow(event: MouseEvent): Promise<void> {
    if (!reader.hiddenHasPasscode) {
      lockOpen = true;
      void reader.loadHiddenState();
      return;
    }
    await reader.lockHidden();
    // Locking does not fold the band from here: the band itself folds on the
    // lock transition (see Sidebar), which also restores the fold state the user
    // chose when the curtain comes back up. This only closes the panel.
    if (reader.hiddenLocked) lockOpen = false;
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
      lockOpen = false;
    }
  }

</script>

<!-- The caret is a bar across the top of the band, not a button in the corner:
     collapsed, the bar is all that is left, and the controls drop out from
     under it. The arrow points up while they are showing (hide them) and down
     while they are hidden (bring them back), so the direction always describes
     what a click will do. -->
<div class="bandbox" class:collapsed={chrome.bandCollapsed} class:locked={locked}>
  {#if pulse}
    <span
      class="pulse {pulse}"
      aria-hidden="true"
      onanimationend={() => (pulse = null)}
    ></span>
  {/if}
  <!-- The caret is a bar across the top of the band, and it is always here —
       locked, collapsed, or neither. It used to be replaced by the unlock form
       while locked, which left no way to fold the band exactly when you might
       want to. What a lock hides is the pin/favourites area, not the way to
       fold things. The arrow points up while the controls are showing (hide
       them) and down while they are hidden (bring them back), so the direction
       always describes what a click will do. -->
  <button
    class="bar"
    onclick={() => chrome.toggleBand()}
    aria-expanded={!chrome.bandCollapsed}
    aria-label={chrome.bandCollapsed ? "Expand sidebar controls" : "Collapse sidebar controls"}
    title={chrome.bandCollapsed ? "Expand" : "Collapse"}
    >
    <svg class="caret" class:up={!chrome.bandCollapsed} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>
  {#if !chrome.bandCollapsed}
    <div
      class="reveal"
      class:opening
      bind:this={reveal}
      style="--band-h: {bandH}px"
      onanimationend={() => (opening = false)}
    >
    {#if locked}
      <form class="unlockbar" onsubmit={submitUnlock} aria-label="Locked">
      <svg class="key" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <input
      id="unlock-code"
      type="password"
      inputmode="numeric"
      maxlength="6"
      autocomplete="off"
      placeholder="Passcode"
      aria-label="Passcode to unlock hidden categories"
      bind:value={code}
      />
      <button type="submit" class="go" disabled={reader.hiddenBusy || code === ""}>Unlock</button>
      </form>
      {#if reader.lockNotice}
        <p class="notice" role="status">{reader.lockNotice}</p>
      {/if}
    {/if}
  {#if !locked}
      <div class="band">
      <button
      class="ctl hidden"
      class:on={hiddenView !== "hidden"}
      onclick={cycleHidden}
      disabled={!reader.hiddenAvailable}
      title={reader.hiddenAvailable
      ? `${HIDDEN_LABELS[hiddenView]} — click for ${HIDDEN_LABELS[nextHidden]}`
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
      <span class="lbl">{HIDDEN_LABELS[hiddenView]}</span>
      </button>

      <!-- One press locks. Nothing to confirm: the curtain is the point. -->
      <button
      class="ctl lock"
      onclick={lockNow}
      disabled={!reader.hiddenAvailable}
      title={reader.hiddenHasPasscode
      ? "Lock hidden categories"
      : "Set a passcode first"}
      aria-label="Lock hidden categories"
      >
      <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
      </svg>
      </button>

      <button
      class="ctl pin"
      class:on={pinView !== "all"}
      onclick={cyclePins}
      disabled={reader.favoritesBusy}
      title={`Favourites: ${PIN_VIEW_LABELS[pinView]} — click for ${
      PIN_VIEW_LABELS[nextPinView(pinView)]
      }${reader.favorites.available ? "" : " (Favorite Categories is not enabled)"}`}
      aria-label={`Favourites: ${PIN_VIEW_LABELS[pinView]}`}
      >
      <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" />
      </svg>
      <span class="lbl">{PIN_VIEW_LABELS[pinView]}</span>
      </button>
      </div>
    {/if}
    </div>
  {/if}
</div>

{#if lockOpen && !locked}
  <!-- Only reachable when the extension has no passcode: there is nothing to
       lock with, so the way to get one is set here. An existing passcode is
       changed on the extension's own page, as on the website. -->
  <div class="lockpanel" role="region" aria-label="Set a passcode">
    <form class="code" onsubmit={submitCode}>
      <label for="set-code">Set a passcode to enable locking</label>
      <input
        id="set-code"
        type="password"
        inputmode="numeric"
        maxlength="6"
        autocomplete="off"
        bind:value={code}
      />
      <button type="submit" class="primary" disabled={reader.hiddenBusy}>Save</button>
      <button type="button" onclick={() => ((lockOpen = false), (code = ""))}>Cancel</button>
    </form>
    <p class="hint">One to six digits. Clearing the passcode turns locking off.</p>
    {#if reader.lockNotice}
      <p class="notice" role="status">{reader.lockNotice}</p>
    {/if}
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

  /* Locked: the band is one row, and that row is the way back in. Sized to sit
     where the three controls were so the sidebar does not jump. */
  .unlockbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 2px 0;
  }

  .unlockbar .key {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--tone-lock-closed);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .unlockbar input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 7px;
    border: 1px solid color-mix(in srgb, var(--tone-lock-closed) 45%, transparent);
    border-radius: 7px;
    background: var(--sunken, #171717);
    color: inherit;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.18em;
  }

  .unlockbar input::placeholder {
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  .unlockbar input:focus-visible {
    outline: 2px solid var(--tone-lock-closed);
    outline-offset: 1px;
  }

  .unlockbar .go {
    flex: 0 0 auto;
    padding: 5px 9px;
    border: 1px solid color-mix(in srgb, var(--tone-lock-closed) 55%, transparent);
    border-radius: 7px;
    background: none;
    color: var(--tone-lock-closed);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .unlockbar .go:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .bandbox .notice {
    margin: 5px 0 0;
    font-size: 11px;
    color: var(--danger, #e06c75);
  }

  /* No box: the band is three separate cut-outs on the sidebar's own
     background, so nothing is drawn around them but their own outline. */
  .bandbox {
    position: relative;
    margin: 0 8px 6px;
  }

  /* Lock and unlock answer here: a thin ring that grows a hair and fades on the
     band's own edge. Red for the curtain going down, green for it coming back —
     the same two colours the controls already use, so nothing new is taught.
     Nothing is drawn over the window, and it is over in a third of a second. */
  .pulse {
    position: absolute;
    inset: -2px;
    border-radius: 12px;
    pointer-events: none;
    animation: hrs-bar-pulse 360ms ease-out both;
  }

  .pulse.lock {
    --pulse-tone: var(--tone-hidden, #e5484d);
  }

  .pulse.unlock {
    --pulse-tone: var(--tone-unlock, #3fbf6f);
  }

  /* The controls are pulled out from under the bar: clipped while they move,
     overshooting their own height and a couple of percent of scale before they
     settle. Quick — a quarter of a second — and the overshoot is small enough
     that it reads as weight, not as a bounce. */
  .reveal {
    overflow: hidden;
  }

  .reveal.opening {
    animation: band-unfold 260ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    transform-origin: top center;
  }

  @keyframes band-unfold {
    0% {
      max-height: 0;
      opacity: 0;
      transform: translateY(-3px) scaleY(0.92);
    }
    58% {
      max-height: calc(var(--band-h, 80px) + 7px);
      opacity: 1;
      transform: translateY(1px) scaleY(1.035);
    }
    82% {
      max-height: var(--band-h, 80px);
      transform: translateY(0) scaleY(0.995);
    }
    100% {
      max-height: var(--band-h, 80px);
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pulse-tone) 45%, transparent);
    }

    .reveal.opening {
      animation: none;
    }
  }

  /* Full-width caret bar: the handle for the whole band, in both states. Kept
     short — it is a handle, not a row, and with the search field above it the
     list has already paid for two strips. */
  .bar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 8px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    opacity: 0.45;
    cursor: pointer;
    border-radius: 6px;
  }

  /* Collapsed it is the only thing left of the band, so it keeps enough body to
     be a target without pretending to be a full row. */
  .bandbox.collapsed .bar {
    height: 12px;
  }

  .bar:hover,
  .bar:focus-visible {
    opacity: 1;
    background: var(--hover);
  }

  .bar .caret {
    width: 11px;
    height: 11px;
    transition: transform 0.15s ease;
  }

  .bar .caret.up {
    transform: rotate(180deg);
  }

  .band {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: stretch;
    gap: 6px;
    padding: 2px 2px 0;
  }

  /* A die-cut sticker: the glyph sits in its own outline with nothing filled
     behind it. Colour is the meaning — red is hidden, blue is pinned — and the
     fill only appears when that control has something switched on. */
  .ctl {
    --tone: var(--muted, #999);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 44px;
    padding: 5px 10px;
    border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
    border-radius: 10px;
    background: transparent;
    color: var(--tone);
    font: inherit;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      color 0.12s ease,
      transform 0.08s ease,
      box-shadow 0.12s ease;
  }

  .ctl.hidden {
    --tone: var(--tone-hidden);
  }

  .ctl.pin {
    --tone: var(--tone-favourite);
  }

  /* Lock reads as a state at a glance: yellow while open, orange once locked.
     The locked fill comes from `.on`, so the tone swap is the whole change. */
  .ctl.lock {
    --tone: var(--tone-lock-open);
    min-width: 44px;
  }

    .ctl:hover:not(:disabled) {
    border-color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--tone) 22%, transparent);
  }

  /* Pressed: the sticker takes the tone. Reads as "this is on", and the click
     is answered on the same frame the pointer goes down. */
  .ctl:active:not(:disabled) {
    transform: scale(0.95);
    background: color-mix(in srgb, var(--tone) 26%, transparent);
  }

  .ctl.on {
    background: color-mix(in srgb, var(--tone) 22%, transparent);
    border-color: var(--tone);
    color: var(--tone);
    box-shadow: 0 0 10px color-mix(in srgb, var(--tone) 24%, transparent);
  }

  .ctl.on:active:not(:disabled) {
    background: color-mix(in srgb, var(--tone) 34%, transparent);
  }

  .ctl:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .locked .ctl {
    min-height: 32px;
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
    opacity: 0.85;
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

</style>
