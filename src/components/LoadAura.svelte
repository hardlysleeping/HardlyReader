<script lang="ts">
  /**
   * The seam between the header and the panes, used as a very quiet activity
   * light.
   *
   * The header already says *what* is happening; this only says *that* the app
   * is waiting on something, without a spinner in the corner of the eye. It
   * sits in the one place that costs no layout: the few pixels between the bar
   * and the panes, which would otherwise be a plain line.
   *
   * A sync reports a real fraction, so that one draws as a determinate fill; a
   * stream fetch or a write has no honest percentage, so it gets a slow sweep
   * instead of a fake one.
   */
  import { reader } from "../state/reader.svelte";

  const waiting = $derived(
    reader.sync.active ||
      reader.loadingList ||
      reader.loadingMore ||
      reader.hiddenBusy ||
      reader.favoritesBusy ||
      reader.feedBusy ||
      [...reader.busyItems.values()].some(Boolean),
  );

  /** A sync has its own colour everywhere else, so it has it here too. */
  const syncing = $derived(reader.sync.active);

  const fraction = $derived(
    reader.sync.active && reader.sync.total > 0 ? reader.sync.done / reader.sync.total : null,
  );
</script>

<div class="aura" class:on={waiting} class:syncing aria-hidden="true">
  <span class="track">
    {#if fraction !== null}
      <span class="fill" style="width: {(fraction * 100).toFixed(1)}%"></span>
    {:else}
      <span class="sweep"></span>
    {/if}
  </span>
</div>

<style>
  /* The slot is always here, so nothing moves when activity starts. */
  .aura {
    position: relative;
    flex: none;
    height: 3px;
    background: var(--border);
  }

  .track {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--accent) 55%, transparent),
      var(--accent)
    );
    box-shadow: 0 0 7px 1px color-mix(in srgb, var(--accent) 45%, transparent);
    transition: width 220ms ease;
  }

  /* The sync tone, when the work is a sync: the header's own colour, at the
     width of the window instead of a stub beside the button. */
  .aura.syncing .fill {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--tone-sync) 55%, transparent),
      var(--tone-sync)
    );
    box-shadow: 0 0 7px 1px color-mix(in srgb, var(--tone-sync) 45%, transparent);
  }

  .aura.syncing .sweep {
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--tone-sync) 60%, transparent),
      transparent
    );
  }

  .aura.syncing::after {
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--tone-sync) 42%, transparent),
      color-mix(in srgb, var(--tone-sync) 8%, transparent) 55%,
      transparent
    );
  }

  /* Idle means no animation at all: a compositor loop ticking behind an
     invisible strip is still work on a phone. */
  .aura:not(.on) .sweep,
  .aura:not(.on) .fill {
    animation: none;
  }

  .sweep {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 32%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--accent) 70%, transparent) 45%,
      var(--accent) 60%,
      transparent
    );
    animation: sweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes sweep {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(330%);
    }
  }

  /* The bloom, spilling down over the panes rather than up into the bar. Soft,
     short, and gone the moment the work is. */
  .aura::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 16px;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--accent) 42%, transparent),
      color-mix(in srgb, var(--accent) 8%, transparent) 55%,
      transparent
    );
    filter: blur(7px);
    opacity: 0;
    transition: opacity 220ms ease;
    pointer-events: none;
  }

  .aura.on::after {
    opacity: 0.55;
  }

  /* Idle can flash past faster than the eye; nothing to show for it. */
  .aura:not(.on) .fill,
  .aura:not(.on) .sweep {
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .sweep {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }

    .fill {
      transition: none;
    }
  }
</style>
