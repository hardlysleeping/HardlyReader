<script lang="ts">
  /**
   * Reading controls, in the bar.
   *
   * Two buttons that are used often enough to deserve a click — smaller text,
   * bigger text — and one that opens everything else (the Aa panel).
   *
   * The panel's rows live in `ReadingPanel.svelte`, because they are also the
   * Reading section of the settings panel: one set of rows, two frames. This
   * file is the frame the bar uses — the trigger and the fixed popover under it.
   */
  import { ROW_SCALE, TEXT_SCALE, atScaleLimit, scalePercent } from "../lib/reading-layout";
  import { reading } from "../state/reading.svelte";
  import ReadingPanel from "./ReadingPanel.svelte";

  /**
   * What the two bar buttons resize: the article's text, or — when no article is
   * on screen — the list's. One pair of buttons, pointing at the column the
   * reader is actually looking at. The panel below keeps both sizes named
   * explicitly, so each can still be set on its own.
   */
  let { target = "article", onopen }: { target?: "article" | "list"; onopen?: () => void } = $props();

  const onList = $derived(target === "list");
  const stepScaleSpec = $derived(onList ? ROW_SCALE : TEXT_SCALE);
  const stepValue = $derived(onList ? reading.rowScale : reading.textScale);
  const stepPercentReadout = $derived(scalePercent(stepValue, stepScaleSpec));
  const stepSmaller = $derived(atScaleLimit(stepValue, -1, stepScaleSpec));
  const stepBigger = $derived(atScaleLimit(stepValue, 1, stepScaleSpec));
  const stepWhat = $derived(onList ? "list text" : "text");

  function step(direction: 1 | -1): void {
    if (onList) reading.stepRowScale(direction);
    else reading.stepTextScale(direction);
  }

  let open = $state(false);

  /** Opened from the compact menu, where the Aa has no room to sit. */
  export function openPanel() {
    open = true;
    onopen?.();
  }

  /** Shut from elsewhere: one panel at a time in the bar. */
  export function closePanel() {
    open = false;
  }

  /** The Aa itself: open it, and say so, so the settings panel can stand down. */
  function toggle(): void {
    open = !open;
    if (open) onopen?.();
  }

  function close(): void {
    open = false;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  let panelEl = $state<HTMLElement | null>(null);
  let moreEl = $state<HTMLElement | null>(null);

  /**
   * A press anywhere else in the app closes it, the same as the settings panel:
   * a popover that stays open over whatever was just pressed is a popover that
   * took the press. The Aa button itself is exempt, so it still toggles.
   */
  $effect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelEl?.contains(target) || moreEl?.contains(target)) return;
      close();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });
</script>

<svelte:window onkeydown={open ? onkeydown : undefined} />

<div class="reading">
  <!-- The two that are pressed repeatedly live on the bar itself. -->
  <button
    class="step small"
    onclick={() => step(-1)}
    disabled={stepSmaller}
    aria-label={`Smaller ${stepWhat}`}
    title={`Smaller ${stepWhat} (${stepPercentReadout})`}
  >
    <span aria-hidden="true">A<span class="sign">−</span></span>
  </button>
  <button
    class="step big"
    onclick={() => step(1)}
    disabled={stepBigger}
    aria-label={`Bigger ${stepWhat}`}
    title={`Bigger ${stepWhat} (${stepPercentReadout})`}
  >
    <span aria-hidden="true">A<span class="sign">+</span></span>
  </button>

  <button
    class="more"
    bind:this={moreEl}
    class:on={open}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Reading options"
    title="Reading options"
    onclick={toggle}
  >
    <span aria-hidden="true">Aa</span>
  </button>
</div>

{#if open}
  <div class="panel" role="dialog" aria-label="Reading options" bind:this={panelEl}>
    <ReadingPanel ondone={close} />
  </div>
{/if}

<style>
  .reading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 3px;
  }

  .step,
  .more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .step:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .step:not(:disabled):hover,
  .more:hover,
  .more.on {
    background: var(--hover);
    color: var(--text);
  }

  .step:focus-visible,
  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .step.small {
    font-size: 12px;
  }

  .step.big {
    font-size: 14px;
  }

  .step .sign {
    font-size: 9px;
    vertical-align: super;
  }

  .more {
    font-size: 11px;
    letter-spacing: 0.01em;
  }

  /* Under the bar, on the same edge as the Options panel. Both are fixed
     because the header clips its own overflow. */
  .panel {
    position: fixed;
    /* Below the bar that opened it. 46 is a window's bar (42) plus a breath; the
       status bar's own inset is added on top, because a phone's bar starts below
       it and a panel at 46 would open over the bar's own controls. `--safe-top`
       is 0 in a window, so the number there is unchanged. */
    top: calc(46px + var(--safe-top, 0px));
    right: 12px;
    z-index: 61;
    width: 252px;
    /* A popup, not a page: capped short of the window so it never turns into a
       full-height column with a scrollbar down its whole side. Below this it
       scrolls, with the footer reachable. */
    max-height: min(72vh, 460px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 12px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    color: var(--text-dim);
  }

  /* On a phone the two quick buttons would crowd the bar; the same two
     commands are the first row of the panel. */
  @media (max-width: 520px) {
    .step {
      display: none;
    }
  }
</style>
