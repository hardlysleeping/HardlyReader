<script lang="ts">
  import { STACK_GUTTER, STACK_SHARE, clampShare, type StackPane } from "../lib/panes";
  import { layout } from "../state/layout.svelte";

  /**
   * `axis="x"` is the seam between two columns; `axis="y"` is the seam between
   * the stacked posts and the article.
   *
   * One component, because the hard parts are the same in both directions —
   * pointer capture, one update per animation frame, one write on release,
   * arrow keys when focused — and only the coordinate and what is resized
   * change. The stacked seam moves a share of the column rather than a width,
   * so a window resize keeps the split instead of reinterpreting "half".
   *
   * The stacked seam is also where the two panes are arranged: swap which one
   * is on top, or tuck one of them away for a moment. Three real buttons, so a
   * press is a press and a drag is still a drag — they sit on the seam without
   * being part of its hit area (`pointer-events` on the buttons only).
   *
   * `fold` is the other seam's control: the feeds column's seam carries the way
   * to fold the feeds away, in two panes only. It is a chip on the same pattern
   * — a real button beside the separator rather than inside it — and it keeps
   * out of the way until the seam is hovered or focused, because the seam's job
   * is still to be dragged.
   */
  let {
    which = "sidebar",
    axis = "x",
    fold = false,
  }: { which?: "sidebar" | "list"; axis?: "x" | "y"; fold?: boolean } = $props();

  let dragging = $state(false);
  let frame = 0;
  let startPos = 0;
  let startWidth = 0;
  let startShare: number = STACK_SHARE.fallback;
  /** The stacked column's height, measured when the drag starts. */
  let track = 0;

  const vertical = $derived(axis === "y");

  /** Which pane is in which slot. Posts on top unless the order is swapped. */
  const top = $derived(layout.stackTop);
  const bottom = $derived(layout.stackBottom);
  const tuck = $derived(layout.stackTuck);
  /**
   * The seam drawn over a single expanded pane.
   *
   * A tuck leaves one pane filling the column, so there is no row for the seam
   * to sit in. It is drawn over the pane instead — at the same share it had —
   * so the drag handle and its three controls never move out from under the
   * pointer, and the split that comes back is visible while the pane is away.
   */
  const overlaid = $derived(vertical && layout.stacked && tuck !== null);

  const name = (pane: StackPane): string => (pane === "posts" ? "post list" : "article");
  const topName = $derived(name(top));
  const bottomName = $derived(name(bottom));
  const tuckedName = $derived(tuck === "top" ? topName : tuck === "bottom" ? bottomName : "");

  /** Where the overlaid seam sits: the split, less half its own thickness. */
  const offset = $derived(
    `calc(${(layout.stackShare * 100).toFixed(2)}% - ${STACK_GUTTER / 2}px)`,
  );

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0) return;
    dragging = true;
    startPos = vertical ? event.clientY : event.clientX;
    if (vertical) {
      startShare = layout.stackShare;
      // The seam's wrapper is the grid child, so the column it splits is that
      // wrapper's parent — and that is true in both states, because a tucked
      // seam is still drawn inside the column it belongs to.
      const host = (event.currentTarget as HTMLElement).closest<HTMLElement>(".seam")?.parentElement;
      track = host === null || host === undefined ? 0 : host.getBoundingClientRect().height;
    } else {
      startWidth = layout.width(which);
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  /** Where the pointer says the seam is now. */
  function apply(x: number, y: number): void {
    if (vertical) {
      const room = Math.max(1, track - STACK_GUTTER);
      layout.dragShare(clampShare(startShare + (y - startPos) / room, track));
      return;
    }
    layout.dragTo(which, startWidth + (x - startPos));
  }

  function onpointermove(event: PointerEvent) {
    if (!dragging) return;
    // The coordinates are read now, not inside the frame: the event is gone by
    // then, and one update per animation frame is all a layout can absorb.
    const x = event.clientX;
    const y = event.clientY;
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      apply(x, y);
    });
  }

  function end(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
      apply(event.clientX, event.clientY);
    }
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    // One write per drag, at the end: the per-frame updates only move pixels.
    if (vertical) layout.commitShare();
    else layout.commit();
  }

  function onkeydown(event: KeyboardEvent) {
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const onward = vertical ? "ArrowDown" : "ArrowRight";
    if (event.key !== back && event.key !== onward) return;
    event.preventDefault();
    const direction = event.key === onward ? 1 : -1;
    if (vertical) layout.nudgeShare(direction * (event.shiftKey ? 0.08 : 0.02));
    else layout.nudge(which, direction, event.shiftKey);
  }

  function reset(): void {
    if (vertical) layout.resetShare();
    else layout.reset(which);
  }

  const label = $derived(
    vertical
      ? `Resize the ${topName} and the ${bottomName}`
      : which === "sidebar"
        ? "Resize the feed list"
        : "Resize the post list",
  );

  const keys = $derived(vertical ? "↑ ↓" : "← →");

  /** The stacked seam's position, as the percentage its two panes are split by. */
  const percent = $derived(Math.round(layout.stackShare * 100));

  /**
   * What the split is, in words, including anything that is away right now.
   *
   * The number alone is honest but not sufficient: with a pane tucked the seam
   * is over one pane, and a screen reader has to be told that the percentage is
   * where the hidden pane will come back to.
   */
  const valueText = $derived(
    vertical
      ? `${percent}% ${topName}${tuck === null ? "" : `, ${tuckedName} tucked away`}`
      : undefined,
  );
</script>

<div
  class="seam"
  class:overlaid
  style:top={overlaid ? offset : undefined}
>
  <!-- A separator is the correct role for a split handle and it is interactive
       by design: pointer drag plus arrow keys when focused. The arrangement
       controls are siblings, not children: a widget role makes its descendants
       presentational, so buttons inside it would vanish for a screen reader. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="gutter"
    class:dragging
    class:vertical
    role="separator"
    aria-orientation={vertical ? "horizontal" : "vertical"}
    aria-label={label}
    aria-valuenow={vertical ? percent : layout.width(which)}
    aria-valuemin={vertical ? Math.round(STACK_SHARE.min * 100) : layout.minSidebar}
    aria-valuemax={vertical ? Math.round(STACK_SHARE.max * 100) : layout.available}
    aria-valuetext={valueText}
    tabindex="0"
    {onpointerdown}
    {onpointermove}
    onpointerup={end}
    onpointercancel={end}
    ondblclick={reset}
    {onkeydown}
    title={`${label} — drag, double-click to reset, or focus and use ${keys}`}
  >
    <span class="line"></span>
  </div>

  {#if vertical}
    <!-- The arrangement, in the seam where the two panes meet: swap the order,
         tuck the top pane, tuck the bottom one. Both tucks are toggles, so the
         way back is the control that hid the pane — which is why the seam stays
         here, over the pane that stayed, when one of them is away. -->
    <div class="ctl-bar" role="group" aria-label="Stacked panes">
      <button
        type="button"
        disabled={tuck !== null}
        aria-pressed={layout.stackSwapped}
        aria-label="Swap the post list and the article"
        title={tuck === null
          ? `Put the ${bottomName} above the ${topName}`
          : "Show both panes to swap them"}
        onclick={() => layout.toggleStackSwap()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.5 13V3.4M3 6l2.5-2.6L8 6" />
          <path d="M10.5 3v9.6M8 10l2.5 2.6L13 10" />
        </svg>
      </button>
      <button
        type="button"
        aria-expanded={tuck !== "top"}
        aria-label={tuck === "top" ? `Show the ${topName}` : `Tuck the ${topName} away`}
        title={tuck === "top"
          ? `Show the ${topName} again`
          : `Tuck the ${topName} away — it is the top of the column`}
        onclick={() => layout.tuckStack("top")}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 2.5h11" />
          <path d="M8 13.4V6.4M5 9.4l3-3 3 3" />
        </svg>
      </button>
      <button
        type="button"
        aria-expanded={tuck !== "bottom"}
        aria-label={tuck === "bottom" ? `Show the ${bottomName}` : `Tuck the ${bottomName} away`}
        title={tuck === "bottom"
          ? `Show the ${bottomName} again`
          : `Tuck the ${bottomName} away — it is the bottom of the column`}
        onclick={() => layout.tuckStack("bottom")}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 13.5h11" />
          <path d="M8 2.6v7M5 6.6l3 3 3-3" />
        </svg>
      </button>
    </div>
  {/if}

  {#if fold}
    <!-- The fold, offered where the feeds meet the rest of the frame: one real
         button on a chip that straddles the seam. A press collapses the feeds;
         a drag anywhere else on the seam is still a drag, because the chip
         passes pointer events through to the gutter beneath it. -->
    <div class="fold-bar" role="group" aria-label="Feeds pane">
      <button
        type="button"
        aria-label="Collapse the feeds pane"
        title="Collapse the feeds pane"
        onclick={() => layout.toggleSidebar()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3.5 5.5 8 10 12.5" />
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  /* The seam is the grid child now, and the whole of it is the drag surface:
     a wrapper so the arrangement controls can sit beside the separator rather
     than inside it. */
  .seam {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    /* Above the panes: the controls straddle the seam and must not be covered
       by a pane that happens to be positioned. */
    z-index: 2;
  }

  /* One pane is tucked away: the seam is drawn over the pane that stayed, at
     the split, so the handle and its controls stay exactly where they were and
     the column reads as one pane expanded rather than as a pane missing. */
  .seam.overlaid {
    position: absolute;
    left: 0;
    right: 0;
    height: 6px;
  }

  .gutter {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: col-resize;
    touch-action: none;
    background: transparent;
    /* The line is 1px; the hit area is the whole 6px track, so a drag does not
       need pixel accuracy. */
    padding: 0;
    border: 0;
  }

  .gutter.vertical {
    cursor: row-resize;
  }

  .line {
    width: 1px;
    height: 100%;
    background: var(--line, #2f2f2f);
    transition: background 0.12s ease;
  }

  /* The same seam, seen from the other side: full width, one pixel tall. */
  .gutter.vertical .line {
    width: 100%;
    height: 1px;
  }

  /* Over a pane's own content a 1px rule reads as a scratch on the page, so it
     is drawn quieter until the seam is used — the chip is what says "seam". */
  .seam.overlaid .line {
    background: color-mix(in srgb, var(--line, #2f2f2f) 50%, transparent);
  }

  .gutter:hover .line,
  .gutter:focus-visible .line,
  .gutter.dragging .line {
    background: var(--accent);
  }

  .gutter:focus-visible {
    outline: none;
  }

  .gutter:focus-visible .line {
    width: 2px;
  }

  .gutter.vertical:focus-visible .line {
    width: 100%;
    height: 2px;
  }

  /* Three presses on a chip straddling the seam. The chip itself takes no
     pointer events, so the pixels between the buttons are still the seam's and
     a drag started there is a drag. */
  .ctl-bar {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    gap: 1px;
    padding: 1px;
    border: 1px solid var(--edge-soft);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 90%, transparent);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.22);
    pointer-events: none;
  }

  .ctl-bar button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 17px;
    height: 17px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    pointer-events: auto;
    transition: color 0.12s ease, background-color 0.12s ease;
  }

  .ctl-bar button svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ctl-bar button:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  /* The state is on the button, not only in the layout: a swapped order and a
     tucked half both show which one they are. */
  .ctl-bar button[aria-pressed="true"],
  .ctl-bar button[aria-expanded="false"] {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }

  /* Disabled is visible rather than silent: with one pane tucked there is no
     pair to reorder, and a button that looks pressable and does nothing is
     worse than one that says it cannot. */
  .ctl-bar button:disabled {
    opacity: 0.3;
    cursor: default;
  }

  /* The fold's chip, at the middle of the feeds seam: a narrow pill with the
     way to fold the feeds away.
     It is only drawn while the seam is being used. `opacity` alone would leave
     an invisible control sitting on the drag surface, so the pointer events
     travel with it — and a button that has been tabbed to is inside the seam,
     which is what `:focus-within` answers, so keyboard users are never hunting
     for something they cannot see. */
  .fold-bar {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    padding: 2px;
    border: 1px solid var(--edge-soft);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.22);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }

  .seam:hover .fold-bar,
  .seam:focus-within .fold-bar {
    opacity: 1;
    pointer-events: auto;
  }

  /* Narrow: the track is 6px, so the pill grows in height rather than in width
     and the chevron stays the whole of it. */
  .fold-bar button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 11px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    transition: color 0.12s ease, background-color 0.12s ease;
  }

  .fold-bar button:hover {
    color: var(--text);
    background: var(--hover);
  }

  .fold-bar button svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
