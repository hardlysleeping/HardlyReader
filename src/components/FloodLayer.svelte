<script lang="ts">
  /**
   * The layer that draws action feedback.
   *
   * Fixed and click-through, so it can sit over every pane without touching
   * layout or hit-testing. Each flood is one element that animates opacity and
   * transform only — both are composited, so a hide on a loaded feed does not
   * cost a layout pass — and removes itself when its animation ends.
   */
  import { FLOOD_MS, floodTone } from "../lib/floods";
  import { floods } from "../state/floods.svelte";

  const LIFE = FLOOD_MS;
</script>

<div class="layer" aria-hidden="true">
  {#each floods.floods as flood (flood.id)}
    <span
      class="flood"
      data-kind={flood.kind}
      style="--x: {flood.x}px; --y: {flood.y}px; --tone: {floodTone(flood.kind)}; --life: {LIFE}ms; --strength: {flood.strength}"
      onanimationend={() => floods.retire(flood.id)}
    ></span>
  {/each}
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 55;
    overflow: hidden;
    pointer-events: none;
  }

  .flood {
    position: absolute;
    left: var(--x);
    top: var(--y);
    /* A quiet flood is a smaller light as well as a dimmer one: shrinking the
       disc keeps the shape readable instead of showing a faint full-size circle. */
    width: calc(170px * (0.55 + 0.45 * var(--strength, 1)));
    height: calc(170px * (0.55 + 0.45 * var(--strength, 1)));
    translate: -50% -50%;
    border-radius: 50%;
    /* Light, not a coloured blob: bright centre, tinted edge, nothing at the
       rim, so it reads as a glow leaving rather than a circle appearing. */
    background: radial-gradient(
      circle at 50% 55%,
      color-mix(in srgb, var(--tone) 55%, #fff 18%) 0%,
      color-mix(in srgb, var(--tone) 34%, transparent) 38%,
      color-mix(in srgb, var(--tone) 10%, transparent) 62%,
      transparent 74%
    );
    mix-blend-mode: screen;
    opacity: 0;
    will-change: transform, opacity;
    animation: flood var(--life) cubic-bezier(0.16, 0.84, 0.24, 1) forwards;
  }

  /* Out and up: rises, spreads, and is gone before the eye settles on it. */
  @keyframes flood {
    0% {
      opacity: 0;
      transform: translate3d(0, 12px, 0) scale(0.42);
    }
    16% {
      opacity: calc(0.9 * var(--strength, 1));
    }
    55% {
      opacity: calc(0.42 * var(--strength, 1));
    }
    100% {
      opacity: 0;
      transform: translate3d(0, -46px, 0) scale(1.55);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    /* The store does not emit these at all under reduced motion; this is a
       second belt for anything that reaches the layer some other way. */
    .flood {
      animation: none;
      opacity: 0;
    }
  }
</style>
