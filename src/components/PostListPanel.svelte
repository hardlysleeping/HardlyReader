<script lang="ts">
  /**
   * The post list's shape, as rows.
   *
   * These four answers — how a row ends, how far that end turns, whether a
   * picture fills it, and how many tiles are across a grid — used to sit on the
   * bar above the posts, on a phone as much as on a window. On a phone that bar
   * is the width of one column: the four controls that decide what you are
   * looking at had to share it with four more that decide how it looks, and the
   * shapes lost.
   *
   * So on a phone the shapes stay on the bar and these move here, in the
   * settings sheet the `•••` opens. Every one of them writes the same store the
   * bar's own control wrote (`reading.setRowsEnd`, `setCurve`, `toggleFlushThumb`,
   * `setGridColumns`), so a phone and a desktop cannot end up with two different
   * lists.
   *
   * The rows follow the bar *view for view*, the way the bar does: the ends and
   * the corners are there for the two shapes that have an end, the picture fill
   * only for Rows, the ruler only for Grid. A row that changes nothing on screen
   * is a row that reads as broken.
   */
  import {
    GRID_COLUMNS_DEFAULT,
    GRID_COLUMN_MAX,
    GRID_COLUMN_MIN,
    ROW_CURVE,
    gridColumnValue,
  } from "../lib/list-view";
  import { reading } from "../state/reading.svelte";

  /** The shape the rows are drawn in, which is the one whose corner this is. */
  const footed = $derived(reading.rowsEnd === "half");
  const curve = $derived(footed ? reading.curveHalf : reading.curvePill);
  const which = $derived(footed ? "Foot corners" : "Pill ends");
  const tiles = $derived(gridColumnValue(reading.gridColumns));
</script>

<div class="row">
  <span class="key">Row ends</span>
  <div class="seg wide" role="group" aria-label="How a row ends">
    <button
      class:on={!footed}
      aria-pressed={!footed}
      onclick={() => reading.setRowsEnd("pill")}
      title="Rows turn at both right-hand corners, as a half pill"
    >Pill</button>
    <button
      class:on={footed}
      aria-pressed={footed}
      onclick={() => reading.setRowsEnd("half")}
      title="Rows turn at the bottom, with the accent running along their foot"
    >Foot</button>
  </div>
</div>

<div class="row">
  <span class="key">{which}</span>
  <div class="slide" role="group" aria-label={`${which} radius`}>
    <input
      type="range"
      min={ROW_CURVE.min}
      max={ROW_CURVE.max}
      step={ROW_CURVE.step}
      value={curve}
      aria-label={`${which} radius, ${curve} pixels`}
      oninput={(event) => reading.setCurve(footed ? "half" : "pill", Number(event.currentTarget.value))}
    />
    <span class="value">{curve}</span>
  </div>
</div>

<!-- Which way that turn faces: the pill turns a side, the foot an edge. Same pair of settings as
     the corner popup on the bar, because a phone has no bar to reach them from. -->
<div class="row">
  <span class="key">{footed ? "Foot edge" : "Pill side"}</span>
  <div class="seg wide" role="group" aria-label={footed ? "Which edge the foot turns" : "Which side the pill turns"}>
    {#if footed}
      <button
        class:on={reading.turnEdge === "bottom"}
        aria-pressed={reading.turnEdge === "bottom"}
        onclick={() => reading.setTurnEdge("bottom")}
        title="The foot turns at the bottom of each row"
      >Bottom</button>
      <button
        class:on={reading.turnEdge === "top"}
        aria-pressed={reading.turnEdge === "top"}
        onclick={() => reading.setTurnEdge("top")}
        title="The foot turns at the top of each row, accent and all"
      >Top</button>
    {:else}
      <button
        class:on={reading.turnSide === "right"}
        aria-pressed={reading.turnSide === "right"}
        onclick={() => reading.setTurnSide("right")}
        title="The pill turns its right-hand corners"
      >Right</button>
      <button
        class:on={reading.turnSide === "left"}
        aria-pressed={reading.turnSide === "left"}
        onclick={() => reading.setTurnSide("left")}
        title="The pill turns its left-hand corners, accent and all"
      >Left</button>
      <button
        class:on={reading.turnSide === "both"}
        aria-pressed={reading.turnSide === "both"}
        onclick={() => reading.setTurnSide("both")}
        title="The pill turns at both ends"
      >Both</button>
    {/if}
  </div>
</div>

<!-- Only where a picture has an end to fill: in Cards and Grid the picture is
     the shape, so the row would move nothing. -->
{#if reading.listView === "regular"}
  <div class="row">
    <span class="key">Picture fill</span>
    <button
      class="toggle"
      class:on={reading.flushThumb}
      aria-pressed={reading.flushThumb}
      onclick={() => reading.toggleFlushThumb()}
      title={reading.flushThumb
        ? "The picture fills the row's end, and the row cuts it — press to sit it inside the row again"
        : "The picture sits inside the row — press to have it fill the end, corner and all"}
    >
      {reading.flushThumb ? "On" : "Off"}
    </button>
  </div>
{/if}

<!-- The ruler moves off the bar with the rest of it, and appears in the one view
     that has tiles to count. `auto` stays a button of its own: it is not a
     number of tiles, it is "as many as fit", so it must not be reachable by
     dragging past the end of a range. -->
{#if reading.listView === "grid"}
  <div class="row">
    <span class="key">Tiles across</span>
    <div class="sizer" role="group" aria-label="Tiles per row">
      <button
        class:on={reading.gridColumns === "auto"}
        aria-pressed={reading.gridColumns === "auto"}
        onclick={() => reading.setGridColumns(GRID_COLUMNS_DEFAULT)}
        title="As many tiles as fit, the size they have always been"
      >auto</button>
      <input
        type="range"
        min={GRID_COLUMN_MIN}
        max={GRID_COLUMN_MAX}
        step="1"
        value={tiles}
        aria-label="Tiles across"
        title={`${tiles} tiles across: fewer, larger squares`}
        oninput={(event) => reading.setGridColumns(Number(event.currentTarget.value))}
      />
      <span class="value">{tiles}</span>
    </div>
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

  .key {
    flex: 1 1 auto;
    min-width: 0;
  }

  .value {
    min-width: 1.6rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text);
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

  /* Two words of unequal length: equal halves so the pair reads as one control
     instead of two buttons that happen to sit together. */
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

  /* The slider and its number: the number is the answer, the slider is how it is
     changed, and the number keeps its place while the thumb moves. */
  .slide {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 132px;
  }

  .slide input[type="range"],
  .sizer input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: var(--accent);
  }

  .sizer {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 132px;
  }

  .sizer button {
    flex: 0 0 auto;
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

  .sizer button.on {
    border-color: var(--accent);
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
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

  /* A thumb, not a pointer: the sheet's rows are reached by finger on the device
     that draws this section, so the slider's box grows to a tap while the track
     keeps its size. */
  @media (pointer: coarse) {
    .slide input[type="range"],
    .sizer input[type="range"] {
      height: 34px;
      touch-action: none;
    }

    .seg button,
    .sizer button,
    .toggle {
      height: 30px;
    }
  }
</style>
