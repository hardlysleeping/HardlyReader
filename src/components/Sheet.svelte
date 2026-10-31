<script lang="ts">
  /**
   * A sheet that comes up from the bottom edge and is pushed back down.
   *
   * Used by the reading options on a phone, where the panel used to be a
   * popover in the top corner. The grabber is the whole gesture: drag it down
   * and the sheet follows the finger; let go past a third of its height, or
   * flick it, and it closes. Drag up and it gives a little and stops, because
   * there is nothing above it to reveal.
   *
   * It portals itself into `body` for the reason `ReadingControls` already
   * documents: the bar it opens from carries `backdrop-filter`, which makes it
   * the containing block for `position: fixed` children, so a sheet left inside
   * it is clipped to the bar.
   */
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { scrimOpacity, sheetOffset, sheetSettles } from "../lib/sheet";

  let {
    label,
    onclose,
    children,
  }: { label: string; onclose: () => void; children: Snippet } = $props();

  let el = $state<HTMLElement | null>(null);
  let height = $state(0);
  let offset = $state(0);
  let dragging = $state(false);

  /** Where the finger started, and the last sample, for the flick's velocity. */
  let startY = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;

  function measure(): void {
    height = el?.getBoundingClientRect().height ?? 0;
  }

  onMount(() => {
    const node = el;
    if (node === null) return;
    document.body.appendChild(node);
    measure();
    node.focus({ preventScroll: true });
    return () => node.remove();
  });

  function grab(event: PointerEvent): void {
    // A mouse's right button is a context menu, not a drag.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragging = true;
    startY = lastY = event.clientY;
    lastAt = performance.now();
    velocity = 0;
    measure();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function drag(event: PointerEvent): void {
    if (!dragging) return;
    const now = performance.now();
    const elapsed = now - lastAt;
    if (elapsed > 0) velocity = (event.clientY - lastY) / elapsed;
    lastY = event.clientY;
    lastAt = now;
    offset = sheetOffset(event.clientY - startY, height);
  }

  function release(): void {
    if (!dragging) return;
    dragging = false;
    if (sheetSettles(offset, height, velocity) === "dismiss") {
      onclose();
      return;
    }
    offset = 0;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydown={onkeydown} />

<button
  class="scrim"
  style="opacity:{scrimOpacity(offset, height)}"
  aria-label="Close {label}"
  tabindex="-1"
  onclick={onclose}
></button>

<section
  class="sheet"
  bind:this={el}
  role="dialog"
  aria-modal="true"
  aria-label={label}
  tabindex="-1"
  style="transform: translateY({offset}px)"
  class:dragging
>
  <div
    class="grab"
    role="presentation"
    onpointerdown={grab}
    onpointermove={drag}
    onpointerup={release}
    onpointercancel={release}
  >
    <span class="bar"></span>
  </div>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 68;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(0 0 0 / 100%);
    transition: opacity 180ms ease;
  }

  .sheet {
    position: fixed;
    z-index: 69;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    max-height: 82vh;
    border-top: 1px solid var(--edge, var(--border));
    border-radius: 16px 16px 0 0;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 -18px 44px rgb(0 0 0 / 45%);
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    /* The finger owns the position while it is down; the spring is only for
       the trip back to rest, so the sheet never lags the hand. */
    transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .sheet.dragging {
    transition: none;
  }

  .sheet:focus {
    outline: none;
  }

  /* The handle is the gesture and nothing else: 22px of height, a 36×4 bar, and
     `touch-action: none` so a drag on it is not read as a scroll of the body
     underneath. The body below keeps its own scrolling. */
  .grab {
    flex: none;
    display: grid;
    place-items: center;
    height: 22px;
    touch-action: none;
    cursor: grab;
  }

  .dragging .grab {
    cursor: grabbing;
  }

  .bar {
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: var(--muted);
    opacity: 0.55;
  }

  /* The panels that ride in here are bare rows with no gutter of their own —
     they were designed for a 252px popover that supplied one. */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 14px 8px;
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .scrim {
      transition: none;
    }
  }
</style>
