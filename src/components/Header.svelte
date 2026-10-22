<script lang="ts">
  import { reader } from "../state/reader.svelte";

  let {
    title = "HardlyReader",
    subtitle = "",
    onsignout,
    ontogglesidebar,
  }: {
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

  <div class="spacer"></div>

  <button class="icon" onclick={refresh} disabled={refreshing} aria-label="Refresh" title="Refresh">
    {refreshing ? "…" : "⟳"}
  </button>
  <button class="signout" onclick={() => onsignout?.()}>Sign out</button>
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
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .signout:hover {
    color: var(--text);
    background: var(--hover);
  }

  /* The drawer toggle only exists where the sidebar is a drawer. */
  @media (min-width: 840px) {
    .menu {
      display: none;
    }
  }
</style>
