<script lang="ts">
  /**
   * Reading controls, in the bar.
   *
   * Two buttons that are used often enough to deserve a click — smaller text,
   * bigger text — and one that opens everything else: list size, line spacing,
   * paragraph indent, and which edge the text hangs from.
   *
   * All of it is one setting for every post and every feed. Sizing per post
   * would mean deciding again each time you open something, and an A+ that
   * means something different depending on what is on screen is worse than no
   * A+ at all.
   */
  import {
    ALIGN_LABELS,
    LEADING_LABELS,
    LEADING_ORDER,
    ROW_SCALE,
    TEXT_ALIGNS,
    TEXT_SCALE,
    atScaleLimit,
    isDefaultLayout,
    scalePercent,
  } from "../lib/reading-layout";
  import { reading } from "../state/reading.svelte";

  let open = $state(false);

  const textPercent = $derived(scalePercent(reading.textScale, TEXT_SCALE));
  const rowPercent = $derived(scalePercent(reading.rowScale, ROW_SCALE));
  const smallerTextAtLimit = $derived(atScaleLimit(reading.textScale, -1, TEXT_SCALE));
  const biggerTextAtLimit = $derived(atScaleLimit(reading.textScale, 1, TEXT_SCALE));
  const atDefaults = $derived(
    isDefaultLayout({
      textScale: reading.textScale,
      rowScale: reading.rowScale,
      leading: reading.leading,
      indent: reading.indentParagraphs,
      align: reading.textAlign,
    }),
  );

  function close(): void {
    open = false;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={open ? onkeydown : undefined} />

<div class="reading">
  <!-- The two that are pressed repeatedly live on the bar itself. -->
  <button
    class="step small"
    onclick={() => reading.stepTextScale(-1)}
    disabled={smallerTextAtLimit}
    aria-label="Smaller text"
    title={`Smaller text (${textPercent})`}
  >
    <span aria-hidden="true">A<span class="sign">−</span></span>
  </button>
  <button
    class="step big"
    onclick={() => reading.stepTextScale(1)}
    disabled={biggerTextAtLimit}
    aria-label="Bigger text"
    title={`Bigger text (${textPercent})`}
  >
    <span aria-hidden="true">A<span class="sign">+</span></span>
  </button>

  <button
    class="more"
    class:on={open}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Reading options"
    title="Reading options"
    onclick={() => (open = !open)}
  >
    <span aria-hidden="true">Aa</span>
  </button>
</div>

{#if open}
  <div class="panel" role="dialog" aria-label="Reading options">
    <div class="row">
      <span class="key" id="text-size-label">Text size</span>
      <div class="stepper" role="group" aria-labelledby="text-size-label">
        <button
          onclick={() => reading.stepTextScale(-1)}
          disabled={smallerTextAtLimit}
          aria-label="Smaller text"
        >−</button>
        <span class="value">{textPercent}</span>
        <button onclick={() => reading.stepTextScale(1)} disabled={biggerTextAtLimit} aria-label="Bigger text">
          +
        </button>
      </div>
    </div>

    <div class="row">
      <span class="key" id="row-size-label">List size</span>
      <div class="stepper" role="group" aria-labelledby="row-size-label">
        <button onclick={() => reading.stepRowScale(-1)} aria-label="Smaller rows">−</button>
        <span class="value">{rowPercent}</span>
        <button onclick={() => reading.stepRowScale(1)} aria-label="Bigger rows">+</button>
      </div>
    </div>

    <div class="row">
      <span class="key">Line spacing</span>
      <div class="seg" role="group" aria-label="Line spacing">
        {#each LEADING_ORDER as leading (leading)}
          <button
            class:on={reading.leading === leading}
            aria-pressed={reading.leading === leading}
            onclick={() => reading.setLeading(leading)}
          >{LEADING_LABELS[leading]}</button>
        {/each}
      </div>
    </div>

    <div class="row">
      <span class="key">Align</span>
      <div class="seg" role="group" aria-label="Text alignment">
        {#each TEXT_ALIGNS as align (align)}
          <button
            class:on={reading.textAlign === align}
            aria-pressed={reading.textAlign === align}
            onclick={() => reading.setTextAlign(align)}
            aria-label={ALIGN_LABELS[align]}
            title={ALIGN_LABELS[align]}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" class={align}>
              {#if align === "left"}
                <path d="M2 4h12M2 8h8M2 12h12" />
              {:else if align === "center"}
                <path d="M2 4h12M4 8h8M2 12h12" />
              {:else}
                <path d="M2 4h12M6 8h8M2 12h12" />
              {/if}
            </svg>
          </button>
        {/each}
      </div>
    </div>

    <div class="row">
      <span class="key">Paragraph indent</span>
      <button
        class="toggle"
        class:on={reading.indentParagraphs}
        aria-pressed={reading.indentParagraphs}
        onclick={() => reading.toggleIndentParagraphs()}
      >
        {reading.indentParagraphs ? "On" : "Off"}
      </button>
    </div>

    <div class="row end">
      <button class="reset" onclick={() => reading.resetReadingLayout()} disabled={atDefaults}>
        Reset to defaults
      </button>
      <button class="done" onclick={close}>Done</button>
    </div>
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
    top: 46px;
    right: 12px;
    z-index: 61;
    width: 252px;
    padding: 8px 12px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    color: var(--text-dim);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  .row.end {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
  }

  .value {
    min-width: 3.1rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .stepper button {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .stepper button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .seg {
    display: flex;
    gap: 2px;
  }

  .seg button {
    min-width: 26px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .seg button.on {
    border-color: var(--accent);
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .seg svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    display: block;
  }

  .toggle {
    min-width: 44px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .toggle.on {
    border-color: var(--accent);
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .reset,
  .done {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .reset:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .done {
    border-color: var(--accent);
    color: var(--text);
  }

  /* On a phone the two quick buttons would crowd the bar; the same two
     commands are the first row of the panel. */
  @media (max-width: 520px) {
    .step {
      display: none;
    }
  }
</style>
