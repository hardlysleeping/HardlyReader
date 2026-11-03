<script lang="ts">
  /**
   * The Aa panel's rows, without the Aa.
   *
   * The same rows are now drawn in two places: the panel that drops from the Aa
   * in the bar, and the Reading section of the settings panel. So the rows are
   * one component and each surface supplies its own frame — the bar's is a fixed
   * popover, the settings panel's is a section of a sheet. A second hand-written
   * copy of these eight rows is how the two surfaces drift apart.
   *
   * Everything below is one setting for every post and every feed. Sizing per
   * post would mean deciding again each time you open something, and an A+ that
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
    STEP_PERCENTS,
    THUMB_SCALE,
    THUMB_SIDES,
    thumbWidthPx,
    THUMB_SIDE_LABELS,
    atScaleLimit,
    isDefaultLayout,
    scalePercent,
  } from "../lib/reading-layout";
  import { reading } from "../state/reading.svelte";
  import { reader } from "../state/reader.svelte";
  import { layout } from "../state/layout.svelte";
  import { EFFORT_MAX, EFFORT_MIN, swipePxFor } from "../lib/scroll-advance";
  import { FLIP_EDGE } from "../lib/reading-layout";
  import IndentControl from "./IndentControl.svelte";

  /**
   * The frame's own verb, if it has one: the bar's popover closes, a section
   * does not. Passed in rather than called, so this component never has to know
   * which surface it is in.
   */
  let { ondone }: { ondone?: () => void } = $props();

  const textPercent = $derived(scalePercent(reading.textScale, TEXT_SCALE));
  const rowPercent = $derived(scalePercent(reading.rowScale, ROW_SCALE));
  const thumbPercent = $derived(scalePercent(reading.thumbScale, THUMB_SCALE));
  const smallerTextAtLimit = $derived(atScaleLimit(reading.textScale, -1, TEXT_SCALE));
  const biggerTextAtLimit = $derived(atScaleLimit(reading.textScale, 1, TEXT_SCALE));
  const smallerThumbAtLimit = $derived(atScaleLimit(reading.thumbScale, -1, THUMB_SCALE));
  const biggerThumbAtLimit = $derived(atScaleLimit(reading.thumbScale, 1, THUMB_SCALE));

  /**
   * How big the picture actually ends up, in pixels.
   *
   * A percentage on its own is abstract — it multiplies the row scale and a
   * 48px base — so the row says what it means: the width the next thumbnail
   * will have.
   */
  const thumbPx = $derived(thumbWidthPx(reading.rowScale, reading.thumbScale));

  /**
   * The drag distance, in pixels, that the effort setting draws on a phone.
   *
   * The desktop's row says "×1.5" because a wheel is counted in notches; a thumb
   * is counted in where the finger has to get to, so the same store is shown
   * here as the distance it actually is.
   */
  const swipePx = $derived(swipePxFor(reading.scrollEffort));
  /** The same distance said as a share of the screen it is dragged on. */
  const screenShare = $derived(
    Math.round((swipePx / Math.max(1, typeof window === "undefined" ? 800 : window.innerHeight)) * 100),
  );
  const phone = $derived(layout.device === "phone");
  const atDefaults = $derived(
    isDefaultLayout({
      textScale: reading.textScale,
      rowScale: reading.rowScale,
      leading: reading.leading,
      align: reading.textAlign,
      thumbScale: reading.thumbScale,
      thumbSide: reading.thumbSide,
      imageScale: reading.imageScale,
      articleImage: reading.articleImage,
      stepPercent: reading.stepPercent,
    }),
  );
</script>

<!-- The indent of the feed names, first because it is about the column this
     panel is a sibling of: a phone has no sidebar footer to keep it in, so it
     was only in Settings → Feeds, two doors away from the Aa that a reader
     opens while looking at the list. One slider — `IndentControl` — mounted in
     both places, same store, same write. -->
<div class="row">
  <span class="key">Feed indent</span>
  <IndentControl id="reading-indent" />
  <span class="indent-px">{reader.sidebarIndent.px}</span>
</div>

<div class="row">
  <span class="key">Text size</span>
  <div class="stepper" role="group" aria-label="Text size">
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
  <span class="key">List size</span>
  <div class="stepper" role="group" aria-label="List size">
    <button onclick={() => reading.stepRowScale(-1)} aria-label="Smaller rows">−</button>
    <span class="value">{rowPercent}</span>
    <button onclick={() => reading.stepRowScale(1)} aria-label="Bigger rows">+</button>
  </div>
</div>

<div class="group">
  <span class="group-label">Thumbnails</span>

  <div class="row">
    <span class="key">Position</span>
    <div class="seg wide" role="group" aria-label="Thumbnail position">
      {#each THUMB_SIDES as side (side)}
        <button
          class:on={reading.thumbSide === side}
          aria-pressed={reading.thumbSide === side}
          onclick={() => reading.setThumbSide(side)}
          title={`Thumbnails on the ${THUMB_SIDE_LABELS[side].toLowerCase()}`}
        >{THUMB_SIDE_LABELS[side]}</button>
      {/each}
    </div>
  </div>

  <div class="row">
    <span class="key">Size</span>
    <div
      class="stepper"
      role="group"
      aria-label="Thumbnail size"
      title={reading.thumbSide === "off"
        ? "Thumbnails are off — this size applies when you turn them back on"
        : `${thumbPercent} of the row size (${thumbPx}px wide)`}
    >
      <button
        onclick={() => reading.stepThumbScale(-1)}
        disabled={smallerThumbAtLimit}
        aria-label="Smaller thumbnails"
      >−</button>
      <span class="value">{thumbPercent}</span>
      <button onclick={() => reading.stepThumbScale(1)} disabled={biggerThumbAtLimit} aria-label="Bigger thumbnails">
        +
      </button>
    </div>
  </div>

  <div class="row">
    <span class="key">Above text</span>
    <button
      class="toggle"
      class:on={reading.articleImage}
      aria-pressed={reading.articleImage}
      onclick={() => reading.toggleArticleImage()}
      title="Show the post's picture above the text when the feed sends one"
    >
      {reading.articleImage ? "On" : "Off"}
    </button>
  </div>
</div>


<!-- A multi-picture card turns its page when an edge is tapped, and opens the
     post from the middle. How much of the card is "an edge" is a taste, and
     it only means anything in Cards, so it appears there. -->
{#if reading.listView === "cards"}
  <div class="row">
    <span class="key">Flip edges</span>
    <div class="stepper" role="group" aria-label="Flip edges"
      title={`The outer ${reading.flipEdge}% of each side turns the page; the middle opens the post`}>
      <button onclick={() => reading.setFlipEdge(reading.flipEdge - 5)} disabled={reading.flipEdge <= FLIP_EDGE.min} aria-label="Narrower flip edges">−</button>
      <span class="value">{reading.flipEdge}%</span>
      <button onclick={() => reading.setFlipEdge(reading.flipEdge + 5)} disabled={reading.flipEdge >= FLIP_EDGE.max} aria-label="Wider flip edges">+</button>
    </div>
  </div>
{/if}

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

<!-- Read state is a reading preference like any other, so it lives here with
     its options named instead of leaving an icon to be discovered. Manual is
     the default: opening a post is not reading it. -->
<div class="row">
  <span class="key">Mark read</span>
  <div class="seg" role="group" aria-label="When a post is marked read">
    <button
      class:on={!reading.autoMarkRead}
      aria-pressed={!reading.autoMarkRead}
      onclick={() => reading.setAutoMarkRead(false)}
      title="Posts stay unread until you mark them"
    >Manual</button>
    <button
      class:on={reading.autoMarkRead}
      aria-pressed={reading.autoMarkRead}
      onclick={() => reading.setAutoMarkRead(true)}
      title={`Mark a post read once it has been open for ${reading.autoMarkSeconds} seconds`}
    >Auto {reading.autoMarkSeconds}s</button>
  </div>
</div>

<!-- A phone's answer to the wheel's "Scroll effort" row in Settings: the same
     store, said in the unit a thumb is measured in. 273px is a third of a
     390-wide phone, which is the number that tells you whether the drag is too
     long — a multiplier does not. Gated on the phone because a cursor has no
     drag to shorten; a desktop keeps the multiplier row in Settings. -->
{#if phone}
  <div class="row">
    <span class="key">Drag to next</span>
    <div
      class="stepper"
      role="group"
      aria-label="How far to drag before the next post"
      title={`${swipePx}px of thumb fills the pull — ${screenShare}% of this screen's height`}
    >
      <button
        onclick={() => reading.stepScrollEffort(-1)}
        disabled={reading.scrollEffort <= EFFORT_MIN}
        aria-label="Shorter drag"
      >−</button>
      <span class="value">{swipePx}px</span>
      <button
        onclick={() => reading.stepScrollEffort(1)}
        disabled={reading.scrollEffort >= EFFORT_MAX}
        aria-label="Longer drag"
      >+</button>
    </div>
  </div>

  <!-- Off is the quiet switch the owner kept: let go and the next post simply
       loads. On, the last stretch of the pull slides this post away and shows
       the next one's headline behind it. -->
  <div class="row">
    <span class="key">Reveal next</span>
    <button
      class="toggle"
      class:on={reading.apexPeek}
      aria-pressed={reading.apexPeek}
      onclick={() => reading.setApexPeek(!reading.apexPeek)}
      title={reading.apexPeek
        ? "At the end of the pull this post slides away and the next one shows behind it"
        : "The pull only fills its line; the next post loads when you let go"}
    >
      {reading.apexPeek ? "On" : "Off"}
    </button>
  </div>
{/if}

<!-- At the bottom because it governs the whole panel rather than one row:
     every − and + above moves by this much. -->
<div class="row step-row">
  <span class="key">Step</span>
  <div class="seg" role="group" aria-label="Size step">
    {#each STEP_PERCENTS as percent (percent)}
      <button
        class:on={reading.stepPercent === percent}
        aria-pressed={reading.stepPercent === percent}
        onclick={() => reading.setStepPercent(percent)}
        title={`Each press changes a size by ${percent}%`}
      >{percent}%</button>
    {/each}
  </div>
</div>

<div class="row end">
  <button class="reset" onclick={() => reading.resetReadingLayout()} disabled={atDefaults}>
    Reset to defaults
  </button>
  <!-- Only where there is something to close: this is the bar's popover, not a
       section of the settings panel. -->
  {#if ondone}
    <button class="done" onclick={ondone}>Done</button>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  /* A block of related rows. The hairline does the grouping so the labels can
     stay short: "Position", "Size", "Above text" only read as one thing under
     the word Pictures. */
  .group {
    margin-top: 5px;
    padding-top: 4px;
    border-top: 1px solid var(--border-soft);
  }

  .group-label {
    display: block;
    padding: 2px 0 1px;
    font-size: 9.5px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim);
    opacity: 0.75;
  }

  /* The step sits apart from the rows it governs, on the far side of the
     hairline that opens the footer. */
  .row.step-row {
    margin-top: 5px;
    padding-top: 6px;
    border-top: 1px solid var(--border-soft);
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

  /* Three words of unequal length: equal thirds so the group reads as one
     control instead of three buttons that happen to sit together. */
  .seg.wide {
    flex: 0 0 132px;
  }

  .seg.wide button {
    flex: 1 1 0;
    padding: 0 2px;
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

  /* The number the slider is sitting on, at the row's end: the slider alone
     says "somewhere in the middle" where a pixel width says where. */
  .indent-px {
    min-width: 20px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    text-align: right;
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
</style>
