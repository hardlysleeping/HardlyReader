<script lang="ts">
  /**
   * One picture, whole, on the app's own background.
   *
   * A grid tile is a square crop: the one view whose shape throws away most of
   * a picture. Pressing a tile therefore opens the picture rather than the post —
   * and a long press on the tile still opens the post, so the tap changed meaning
   * in exactly one view and nothing was taken away.
   *
   * It walks the frames it was opened with (see `state/carousel.svelte.ts`), so
   * the swipe goes where the grid would have gone. The picture is `contain`, not
   * `cover`: a viewer that crops is the crop the reader just asked to escape.
   *
   * It portals itself into `body` for the reason `Sheet` documents: it is mounted
   * inside the view, and a `position: fixed` overlay left in a pane that carries
   * `backdrop-filter` or a transform is clipped to that pane.
   */
  import { onMount } from "svelte";
  import { isRead, isStarred } from "../api/freshrss";
  import { feedNameOf } from "../lib/byline";
  import { relativeTime } from "../lib/format";
  import { closesOnDrag, dragProgress, stepsForTravel } from "../lib/carousel";
  import { carousel } from "../state/carousel.svelte";
  import { picture as drawPicture } from "../state/pictures.svelte";

  /** The one node this component owns: the whole overlay moves as one. */
  let shell = $state<HTMLElement | null>(null);

  const session = $derived(carousel.session);
  const frame = $derived(carousel.frame);
  const store = $derived(session?.store ?? null);

  /** How far the picture has been dragged, in CSS pixels. */
  let dx = $state(0);
  let dy = $state(0);
  let dragging = $state(false);

  /** Pinch and double-tap zoom, 1 = fit the screen. */
  let zoom = $state(1);

  /** Pointers down, so a pinch can be told from a swipe. */
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchFrom = 0;
  let pinchBase = 1;
  let startX = 0;
  let startY = 0;
  let lastTap = 0;

  function close(): void {
    zoom = 1;
    dx = 0;
    dy = 0;
    carousel.close();
  }

  function step(delta: number): void {
    carousel.step(delta);
    zoom = 1;
    dx = 0;
    dy = 0;
  }

  function down(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinchFrom = Math.hypot(first.x - second.x, first.y - second.y);
      pinchBase = zoom;
      return;
    }
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    dy = 0;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent): void {
    const known = pointers.get(event.pointerId);
    if (known === undefined) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchFrom > 0) {
      const [first, second] = [...pointers.values()];
      const now = Math.hypot(first.x - second.x, first.y - second.y);
      zoom = Math.min(4, Math.max(1, (pinchBase * now) / pinchFrom));
      return;
    }

    if (!dragging) return;
    // Zoomed in, a drag pans the picture instead of walking the carousel: the
    // swipe is how you leave, and it cannot also be how you look closer.
    if (zoom > 1) {
      dx = event.clientX - startX;
      dy = event.clientY - startY;
      return;
    }
    dx = event.clientX - startX;
    dy = event.clientY - startY;
  }

  function up(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    if (pointers.size > 0) {
      if (pointers.size === 0) dragging = false;
      return;
    }
    if (!dragging) return;
    dragging = false;

    if (zoom > 1) {
      dx = 0;
      dy = 0;
      return;
    }

    // A downward drag past the distance is a dismissal; the fade already said so.
    if (dy > 0 && closesOnDrag(dy) && Math.abs(dy) > Math.abs(dx)) {
      close();
      return;
    }

    const steps = stepsForTravel(dx);
    if (steps > 0 && Math.abs(dx) > Math.abs(dy)) {
      step(dx < 0 ? steps : -steps);
      return;
    }

    // A tap that never moved, twice in a row, is a request to look closer.
    const now = performance.now();
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && now - lastTap < 320) {
      zoom = zoom > 1 ? 1 : 2;
      lastTap = 0;
    } else if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      lastTap = now;
    }
    dx = 0;
    dy = 0;
  }

  function cancel(): void {
    pointers.clear();
    dragging = false;
    dx = 0;
    dy = 0;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (session === null) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
  }

  onMount(() => {
    const box = shell;
    if (box === null) return;
    document.body.appendChild(box);
    box.focus({ preventScroll: true });
    return () => box.remove();
  });

  /** The picture in front is drawn by the action; the neighbours are asked for. */
  $effect(() => {
    if (frame === null) return;
    void frame.id;
    carousel.warm();
  });
</script>

<svelte:window onkeydown={onkeydown} />

<div
  class="shell"
  bind:this={shell}
  class:hidden={session === null}
  role="dialog"
  aria-modal="true"
  aria-label={frame === null ? "Picture" : frame.item.title}
  tabindex="-1"
>
  {#if session !== null}
    <button
      class="scrim"
      aria-label="Close the picture"
      tabindex="-1"
      style="opacity:{dragging || dy > 0 ? 1 - dragProgress(dy) * 0.7 : 1}"
      onclick={close}
    ></button>

    <div
      class="stage"
      role="presentation"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={cancel}
    >
      {#if frame !== null}
        <img
          class="shot"
          class:zoomed={zoom > 1}
          style:transform={`translate(${zoom > 1 ? dx : 0}px, ${dy > 0 ? dy : 0}px) scale(${zoom})`}
          style:opacity={dragging || dy > 0 ? 1 - dragProgress(dy) * 0.6 : 1}
          use:drawPicture={{ url: frame.url, variant: "full" }}
          alt={frame.item.title ?? ""}
          decoding="async"
          referrerpolicy="no-referrer"
          draggable="false"
        />
      {/if}
    </div>

    <div class="chrome">
      <header class="top">
        <button class="round" aria-label="Close the picture" onclick={close}>×</button>
        <p class="counter">
          {carousel.index + 1} / {session.frames.length}
        </p>
      </header>

      {#if frame !== null}
        <footer class="band">
          <p class="caption">
            <span class="title">{frame.item.title}</span>
            <span class="from">
              {feedNameOf(frame.item)}
              {#if relativeTime(frame.item.timestampUsec, frame.item.published)}
                · {relativeTime(frame.item.timestampUsec, frame.item.published)}
              {/if}
            </span>
          </p>
          <div class="acts">
            <button
              class="round prev"
              aria-label="Previous picture"
              onclick={() => step(-1)}>‹</button
            >
            {#if store !== null}
              <button
                class="round"
                class:on={isStarred(frame.item)}
                aria-label={isStarred(frame.item) ? "Remove star" : "Star this post"}
                onclick={() => void store.toggleStar(frame.item)}
                ><span aria-hidden="true">★</span></button
              >
              <button
                class="round"
                aria-label={isRead(frame.item) ? "Mark unread" : "Mark read"}
                onclick={() => void store.setRead(frame.item, !isRead(frame.item))}
                ><span aria-hidden="true">✓</span></button
              >
            {/if}
            <button class="round next" aria-label="Next picture" onclick={() => step(1)}>›</button
            >
          </div>
        </footer>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The shell is out of the layout: it lives in `body`, and everything inside it
     is positioned against the window. */
  .shell {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: contents;
  }

  .shell.hidden {
    display: none;
  }

  .scrim {
    position: fixed;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--bg);
    opacity: 1;
    transition: opacity 220ms ease;
  }

  .stage {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    touch-action: none;
  }

  .shot {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
    transition: transform 180ms ease, opacity 220ms ease;
    will-change: transform;
  }

  .shot.zoomed {
    transition: none;
    cursor: grab;
  }

  .chrome {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
  }

  .chrome button {
    pointer-events: auto;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: calc(env(safe-area-inset-top, 0px) + 8px) 12px 0;
  }

  .counter {
    margin: 0;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--muted);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(8px);
  }

  .round {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border: 0;
    border-radius: 50%;
    font-size: 17px;
    color: var(--text);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(8px);
    box-shadow: var(--edge-soft) 0 0 0 1px inset;
  }

  .round.on {
    color: var(--accent);
  }

  /* The words get the whole width and the controls sit under them: side by side
     on a phone, four 38px targets left the title truncated to "Boots and Sa…". */
  .band {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 14px 14px calc(env(safe-area-inset-bottom, 0px) + 14px);
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--bg) 92%, transparent),
      transparent
    );
  }

  .caption {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 0;
    min-width: 0;
    pointer-events: auto;
  }

  .title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 14px;
    line-height: 1.3;
    color: var(--text);
  }

  .from {
    font-size: 12px;
    color: var(--muted);
  }

  .acts {
    display: flex;
    flex: none;
    gap: 8px;
    justify-content: flex-end;
  }

  /* A phone in landscape is 390pt tall: the band keeps one line of caption and
     the four controls, and the picture gets the rest. */
  @media (orientation: landscape) {
    .band {
      padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .shot,
    .scrim {
      transition: none;
    }
  }
</style>
