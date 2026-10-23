<script lang="ts">
  import { layout } from "../state/layout.svelte";

  let { which }: { which: "sidebar" | "list" } = $props();

  let dragging = $state(false);
  let frame = 0;
  let startX = 0;
  let startWidth = 0;

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startWidth = layout.width(which);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onpointermove(event: PointerEvent) {
    if (!dragging) return;
    const width = startWidth + (event.clientX - startX);
    // One update per frame: a fast drag fires more pointer events than a
    // layout can usefully absorb.
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout.dragTo(which, width);
    });
  }

  function end(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
      layout.dragTo(which, startWidth + (event.clientX - startX));
    }
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      layout.nudge(which, -1, event.shiftKey);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      layout.nudge(which, 1, event.shiftKey);
    }
  }

  const label = $derived(which === "sidebar" ? "Resize the feed list" : "Resize the post list");
</script>

<!-- A separator is the correct role for a split handle and it is interactive by
     design: pointer drag plus arrow keys when focused. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="gutter"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={layout.width(which)}
  aria-valuemin={200}
  aria-valuemax={layout.available}
  tabindex="0"
  {onpointerdown}
  {onpointermove}
  onpointerup={end}
  onpointercancel={end}
  ondblclick={() => layout.reset(which)}
  {onkeydown}
  title={`${label} — drag, double-click to reset, or focus and use ← →`}
>
  <span class="line"></span>
</div>

<style>
  .gutter {
    position: relative;
    display: flex;
    justify-content: center;
    cursor: col-resize;
    touch-action: none;
    background: transparent;
    /* The line is 1px; the hit area is the whole 6px track, so a drag does not
       need pixel accuracy. */
    padding: 0;
    border: 0;
  }

  .line {
    width: 1px;
    height: 100%;
    background: var(--line, #2f2f2f);
    transition: background 0.12s ease;
  }

  .gutter:hover .line,
  .gutter:focus-visible .line,
  .gutter.dragging .line {
    background: var(--accent, #0078e0);
  }

  .gutter:focus-visible {
    outline: none;
  }

  .gutter:focus-visible .line {
    width: 2px;
  }
</style>
