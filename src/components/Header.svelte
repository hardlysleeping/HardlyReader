<script lang="ts">
  import type { Snippet } from "svelte";

  import { reader } from "../state/reader.svelte";
  import ThemePanel from "./ThemePanel.svelte";

  let {
    title = "HardlyReader",
    subtitle = "",
    controls,
    onsignout,
    ontogglesidebar,
  }: {
    /** Layout controls, owned by the view rather than by the header. */
    controls?: Snippet;
    title?: string;
    subtitle?: string;
    onsignout?: () => void;
    ontogglesidebar?: () => void;
  } = $props();

  let refreshing = $state(false);

  async function refresh() {
    refreshing = true;
    try {
      await reader.refresh();
    } finally {
      refreshing = false;
    }
  }
</script>

<header class="bar">
  <button class="icon menu" onclick={() => ontogglesidebar?.()} aria-label="Show feeds">☰</button>
  <span class="brand">{title}</span>
  {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
  <!-- Signing out belongs with the account it signs out of, not at the far end
       of the bar beside the refresh control. -->
  <button class="signout" onclick={() => onsignout?.()}>Sign out</button>

  <div class="spacer"></div>

  {@render controls?.()}
  <ThemePanel />

  <button
    class="sync"
    class:busy={refreshing}
    onclick={refresh}
    disabled={refreshing}
    aria-label={refreshing ? "Syncing" : "Sync now"}
    title={refreshing ? "Syncing…" : "Sync now"}
  >
    <span class="glyph" aria-hidden="true">⟳</span>
  </button>
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    flex: 0 0 48px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .brand {
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .subtitle {
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }

  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }







  .signout {
    flex: 0 0 auto;
    margin-left: 8px;
    padding: 3px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .signout:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border);
  }

  /* Sync is the one control in this bar that changes what you are looking at,
     so it gets room to be aimed at rather than being a 28px glyph wedged
     between two others. */
  .sync {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    margin-left: 10px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .sync:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--accent);
  }

  .sync:disabled {
    cursor: default;
    opacity: 0.8;
  }

  .sync.busy .glyph {
    animation: turn 900ms linear infinite;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sync.busy .glyph {
      animation: none;
    }
  }

  /* The drawer toggle only exists where the sidebar is a drawer. */
  @media (min-width: 840px) {
    .menu {
      display: none;
    }
  }
</style>
