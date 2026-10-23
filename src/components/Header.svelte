<script lang="ts">
  import type { Snippet } from "svelte";

  import { syncDescription, syncReadout } from "../lib/sync-progress";
  import { reader } from "../state/reader.svelte";
  import ReadingControls from "./ReadingControls.svelte";
  import ThemePanel from "./ThemePanel.svelte";

  let {
    title = "HardlyReader",
    subtitle = "",
    controls,
    onsignout,
    ontogglesidebar,
  }: {
    /** Layout controls, owned by the view rather than by the header. */
    controls?: Snippet;
    title?: string;
    subtitle?: string;
    onsignout?: () => void;
    ontogglesidebar?: () => void;
  } = $props();

  /** The reader owns the steps; the header only reads them. */
  const refreshing = $derived(reader.sync.active);
  const readout = $derived(syncReadout(reader.sync));
  const description = $derived(syncDescription(reader.sync));

  /**
   * The bar answers a finished sync the way the band answers a lock and an
   * unlock: one thin ring on its own edge, in the sync colour, gone in a third
   * of a second. The control is in this bar, so this is the bar that changes.
   */
  let pulse = $state(false);
  /**
   * A tick for a moment after the last fetch lands.
   *
   * The resting glyph is a pair of arrows, not a ring, so "finished" can never
   * be mistaken for a spinner that stopped mid-turn — and for a second after it
   * is done it is a tick, which is the one shape that cannot mean "working".
   */
  let justFinished = $state(false);
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  let wasActive = reader.sync.active;
  $effect(() => {
    const activeNow = reader.sync.active;
    if (wasActive && !activeNow) {
      wasActive = false;
      pulse = true;
      justFinished = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      tickTimer = setTimeout(() => {
        tickTimer = null;
        justFinished = false;
      }, 1200);
    } else if (!wasActive && activeNow) {
      wasActive = true;
      justFinished = false;
      if (tickTimer !== null) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    }
  });

  $effect(() => () => {
    if (tickTimer !== null) clearTimeout(tickTimer);
  });

  /** What the control says it is, which is also what it just did. */
  const label = $derived(justFinished ? "Synced" : description);

  async function refresh() {
    await reader.refresh();
  }
</script>

<header class="bar">
  {#if pulse}
    <span class="pulse" aria-hidden="true" onanimationend={() => (pulse = false)}></span>
  {/if}
  <button class="icon menu" onclick={() => ontogglesidebar?.()} aria-label="Show feeds">☰</button>
  <span class="brand">{title}</span>
  {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
  <!-- Signing out belongs with the account it signs out of, not at the far end
       of the bar beside the refresh control. -->
  <button class="signout" onclick={() => onsignout?.()}>Sign out</button>

  <div class="spacer"></div>

  {@render controls?.()}
  <ReadingControls />
  <ThemePanel />

  <!-- The count and the percentage for as long as the sync lasts. The bar for
       the same numbers is the seam under this header, drawn full width there
       rather than as a stub beside the button: one progress, one place. It sits
       still to the left of the button so the control you just pressed does not
       move. -->
  {#if refreshing}
    <span
      class="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={reader.sync.total}
      aria-valuenow={reader.sync.done}
      aria-valuetext={description}
      title={description}
    >
      <span class="readout">{readout}</span>
    </span>
  {/if}

  <button
    class="sync"
    class:busy={refreshing}
    class:done={justFinished}
    onclick={refresh}
    disabled={refreshing}
    aria-label={label}
    title={label}
  >
    {#if justFinished}
      <!-- Done: a tick, briefly. -->
      <svg class="glyph tick" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5 10.2 17.7 19 7.5" />
      </svg>
    {:else}
      <!-- Two arrows chasing each other: the sync mark, drawn as strokes so it
           stays crisp at 16px. At rest it is still; while syncing the whole mark
           turns, which is unmistakably "working" next to a mark that is not. -->
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 0 1-14.8 5.7" />
        <path d="M3.5 12a8.5 8.5 0 0 1 14.8-5.7" />
        <path d="M18.3 2.9v3.8h-3.8" />
        <path d="M5.7 21.1v-3.8h3.8" />
      </svg>
    {/if}
  </button>
</header>

<style>
  /* A title bar, not a toolbar: enough height to hold a 34px control with air
     around it, and no more. */
  .bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 42px;
    flex: 0 0 42px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .brand {
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .subtitle {
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }

  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }







  .signout {
    flex: 0 0 auto;
    margin-left: 6px;
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .signout:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border);
  }

  /* Sync is the one control in this bar that changes what you are looking at,
     so it gets room to be aimed at rather than being a 28px glyph wedged
     between two others. */
  .sync {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    margin-left: 8px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
    color: var(--tone-sync);
    border-color: color-mix(in srgb, var(--tone-sync) 28%, var(--border));
    font: inherit;
    line-height: 1;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  /* Sync keeps its own colour, chosen in Options, because it is the one control
     that means "ask the server", not "change the view". */
  .sync:hover:not(:disabled) {
    color: var(--tone-sync);
    background: color-mix(in srgb, var(--tone-sync) 12%, transparent);
    border-color: color-mix(in srgb, var(--tone-sync) 60%, transparent);
  }

  .sync:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .glyph {
    display: block;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    overflow: visible;
  }

  /* While syncing the whole mark turns. Nothing else moves: a second animation
     under a spinning mark was what made the control look busy after it had
     finished. */
  .sync.busy .glyph {
    animation: turn 820ms linear infinite;
  }

  /* Done, for a second: the tick takes the full sync colour and the button's
     edge lights up, so "finished" is a different picture from "idle" and from
     "working" rather than a ring that happens to be still. */
  .sync.done {
    color: var(--tone-sync);
    border-color: color-mix(in srgb, var(--tone-sync) 65%, var(--border));
    background: color-mix(in srgb, var(--tone-sync) 10%, transparent);
  }

  .glyph.tick {
    stroke-width: 2.3;
  }

  /* The same ring the band draws on a lock or an unlock, in the sync colour. */
  .pulse {
    position: absolute;
    inset: 0;
    border-radius: 0;
    pointer-events: none;
    --pulse-tone: var(--tone-sync);
    animation: hrs-bar-pulse 360ms ease-out both;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  /* The progress readout: a thin bar with the fraction over it, inside the
     header row so nothing else shifts when it appears. */
  .progress {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    margin-left: 8px;
    animation: arrive 160ms ease-out;
  }

  .readout {
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--tone-sync) 55%, var(--muted));
    line-height: 1;
    white-space: nowrap;
  }

  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sync.busy .glyph,
    .progress {
      animation: none;
    }

    .pulse {
      animation: none;
      box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--tone-sync) 45%, transparent);
    }
  }

  /* The drawer toggle only exists where the sidebar is a drawer. */
  @media (min-width: 840px) {
    .menu {
      display: none;
    }
  }
</style>
