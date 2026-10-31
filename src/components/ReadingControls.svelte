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
  import { layout } from "../state/layout.svelte";
  import { reading } from "../state/reading.svelte";
  import ReadingPanel from "./ReadingPanel.svelte";
  import Sheet from "./Sheet.svelte";

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

  /**
   * A phone gets the sheet, everything else keeps the popover.
   *
   * The popover is right for a window: it opens beside the button that asked
   * for it and leaves the article alone. On a phone it opened in the top
   * corner, over the text you were reading, with no handle and no gesture back
   * — so the same rows now come up from the bottom edge, under the thumb, and
   * are pushed back down the way they arrived.
   */
  const onPhone = $derived(layout.device === "phone");

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
   * The panel is a popover over the window, but it is mounted inside the bar
   * that opens it — and on a phone that bar is `overflow: hidden` and carries
   * the navigation material, whose `backdrop-filter` makes it the containing
   * block for `position: fixed` children. A fixed panel inside it was therefore
   * positioned against the bar and clipped to the bar's own 74px: it measured
   * 252×405 in the right place, painted nothing, and every point inside its
   * rectangle hit the list underneath, so a phone could not open its reading
   * options at all. Moving the node into `body` on mount is the smallest fix
   * that gives the panel the window as its parent: the styles travel with it
   * (Svelte scoping is a class), the click-outside test is `contains` on the
   * node, and the only thing it read from an ancestor — where it opens — is
   * `--rc-panel-top`, which a phone now declares on the root.
   */
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  /**
   * A press anywhere else in the app closes it, the same as the settings panel:
   * a popover that stays open over whatever was just pressed is a popover that
   * took the press. The Aa button itself is exempt, so it still toggles.
   */
  $effect(() => {
    // The sheet is modal and owns its own dismissal: a press inside it must not
    // read as a press outside the old popover and close it under the finger.
    if (!open || onPhone) return;
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
  {#if onPhone}
    <Sheet label="Reading options" onclose={close}>
      <ReadingPanel ondone={close} />
    </Sheet>
  {:else}
    <div class="panel" role="dialog" aria-label="Reading options" bind:this={panelEl} use:portal>
      <ReadingPanel ondone={close} />
    </div>
  {/if}
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
    /* Below the bar that opened it. The bar is not the same height in the two
       headers that mount this component — a window's is 42px, a phone's is 36px
       under the part of the status bar it does not spend — so the host declares
       where the panel belongs and this is only the window's answer: 42 + 4 of
       breath. A phone sets `--rc-panel-top` to its own 36 + 4 + the inset it
       sits under (`--safe-top - 24`, the same number `app.css` gives the
       header). One number here opened the panel 2px *inside* the window's bar
       and 30px below the phone's, which is why it is a variable now. */
    top: var(--rc-panel-top, 46px);
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
