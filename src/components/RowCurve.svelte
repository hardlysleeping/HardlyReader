<script lang="ts">
  /**
   * How far a row turns, in one popup on the list's own bar.
   *
   * The shape has two ends and the shapes are two: the pill turns its two
   * right-hand corners, the foot turns its two bottom ones. Only one of them is
   * on screen at a time, so only one is offered — a slider for the shape that is
   * not drawn is a slider that moves nothing and says nothing about why. It
   * changes the list as it is dragged: no apply, no preview mode, because the
   * list is the preview. Zero squares the corner; the top of the range is a full
   * semicircle at a row's height.
   *
   * It lives here rather than in the reading panel because it is a thing you
   * change while looking at rows, and the panel is a thing you open once.
   */
  import { ROW_CURVE } from "../lib/list-view";
  import { reading } from "../state/reading.svelte";

  /** The shape the rows are drawn in, which is the one whose corner this is. */
  const footed = $derived(reading.rowsEnd === "half");
  const which = $derived(footed ? "Foot corners" : "Pill ends");
  const value = $derived(footed ? reading.curveHalf : reading.curvePill);

  let open = $state(false);
  let wrap = $state<HTMLElement | undefined>(undefined);

  function close(): void {
    open = false;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  /** A press anywhere else closes it, the way a menu should. */
  function onpointerdown(event: PointerEvent): void {
    if (!open) return;
    if (wrap && !wrap.contains(event.target as Node)) close();
  }
</script>

<svelte:window onkeydown={open ? onkeydown : undefined} onpointerdown={onpointerdown} />

<div class="wrap" bind:this={wrap}>
  <button
    class="corner"
    class:on={open}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Row corners"
    title={`How far the ${footed ? "foot" : "pill"}'s corners turn`}
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 13V8.5A5.5 5.5 0 0 1 8.5 3H13" />
      <path d="M3 13h4.5" />
    </svg>
  </button>

  {#if open}
    <div class="panel" role="dialog" aria-label={which}>
      <!-- One shape is drawn, so one corner is offered. The other keeps its
           number, unshown, and is there when that shape is. -->
      <div class="line">
        <span class="key">{which}</span>
        <input
          type="range"
          min={ROW_CURVE.min}
          max={ROW_CURVE.max}
          step={ROW_CURVE.step}
          {value}
          aria-label={`${which} radius, ${value} pixels`}
          oninput={(event) =>
            reading.setCurve(footed ? "half" : "pill", Number(event.currentTarget.value))}
        />
        <span class="value">{value}</span>
      </div>

      <!-- Which way that turn faces. The pill turns a side, the foot an edge, and each is asked
           for in the words of the shape on screen: a "Top" button beside a pill would be a control
           that moves nothing. -->
      <div class="line">
        <span class="key">{footed ? "Edge" : "Side"}</span>
        <div class="seg" role="group" aria-label={footed ? "Which edge the foot turns" : "Which side the pill turns"}>
          {#if footed}
            <button
              class:on={reading.turnEdge === "bottom"}
              aria-pressed={reading.turnEdge === "bottom"}
              title="The foot turns at the bottom of each row"
              onclick={() => reading.setTurnEdge("bottom")}
            >Bottom</button>
            <button
              class:on={reading.turnEdge === "top"}
              aria-pressed={reading.turnEdge === "top"}
              title="The foot turns at the top of each row, accent and all"
              onclick={() => reading.setTurnEdge("top")}
            >Top</button>
          {:else}
            <button
              class:on={reading.turnSide === "right"}
              aria-pressed={reading.turnSide === "right"}
              title="The pill turns its right-hand corners"
              onclick={() => reading.setTurnSide("right")}
            >Right</button>
            <button
              class:on={reading.turnSide === "left"}
              aria-pressed={reading.turnSide === "left"}
              title="The pill turns its left-hand corners, accent and all"
              onclick={() => reading.setTurnSide("left")}
            >Left</button>
            <button
              class:on={reading.turnSide === "both"}
              aria-pressed={reading.turnSide === "both"}
              title="The pill turns at both ends"
              onclick={() => reading.setTurnSide("both")}
            >Both</button>
          {/if}
        </div>
        <span class="value"></span>
      </div>

      <div class="foot">
        <span class="hint">pixels of turn · 0 is square</span>
        <button class="reset" onclick={() => reading.resetCurves()}>Reset</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }

  .corner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 21px;
    height: 19px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .corner svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .corner:hover,
  .corner.on {
    color: var(--text);
    background: var(--hover);
  }

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    /* Hung from the button's left edge, not its right: the button sits in the
       middle of the bar, and a panel that grew leftwards would leave the column
       and be cut off by it. */
    left: -6px;
    z-index: 60;
    width: 232px;
    max-width: calc(100vw - 24px);
    padding: 10px 12px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
  }

  .line {
    display: grid;
    grid-template-columns: 74px 1fr 26px;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .key {
    color: var(--muted);
  }

  .value {
    color: var(--text-dim);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  .foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding-top: 2px;
  }

  .hint {
    color: var(--muted);
    font-size: 11px;
  }

  .seg {
    display: inline-flex;
    grid-column: 2 / 4;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
  }

  .seg button {
    flex: 1 1 auto;
    padding: 3px 6px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .seg button.on {
    color: var(--text);
    background: var(--hover);
  }

  .seg button:hover {
    color: var(--text);
  }

  .reset {
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .reset:hover {
    color: var(--text);
    background: var(--hover);
  }
</style>
