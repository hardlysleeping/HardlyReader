<script lang="ts">
  import type { HiddenView } from "../api/hardlyread";
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

  /**
   * The hidden-categories view needs a home that is always reachable.
   *
   * Hiding the last category that has feeds empties the sidebar, and the row
   * menu was the only way to change the view: the user would be stuck with no
   * way back except the FreshRSS web UI. This cycles from anywhere.
   */
  const VIEW_CYCLE: HiddenView[] = ["hidden", "revealed", "only"];
  const VIEW_LABELS: Record<HiddenView, string> = {
    hidden: "Hidden",
    revealed: "Revealed",
    only: "Only",
  };

  const hiddenView = $derived<HiddenView>(reader.hiddenCategories.effectiveView);
  const nextView = $derived<HiddenView>(
    VIEW_CYCLE[(VIEW_CYCLE.indexOf(hiddenView) + 1) % VIEW_CYCLE.length],
  );

  async function cycleView() {
    await reader.setHiddenView(nextView);
  }

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

  {#if reader.hiddenAvailable}
    <button
      class="view"
      class:filtered={hiddenView !== "hidden"}
      onclick={cycleView}
      disabled={reader.hiddenBusy}
      aria-label={`Categories: ${VIEW_LABELS[hiddenView]}. Switch to ${VIEW_LABELS[nextView]}.`}
      title={`Categories: ${VIEW_LABELS[hiddenView]} — click for ${VIEW_LABELS[nextView]}`}
    >
      <span class="eye" aria-hidden="true">{hiddenView === "hidden" ? "●" : "○"}</span>
      <span class="view-label">{VIEW_LABELS[hiddenView]}</span>
    </button>
  {/if}

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

  .view {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .view:hover {
    color: var(--text);
    background: var(--hover);
  }

  .view:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Off "Hidden" means the sidebar is being filtered, so say so visually. */
  .view.filtered {
    color: var(--text);
    border-color: var(--accent, var(--text-dim));
  }

  .eye {
    font-size: 10px;
    line-height: 1;
  }

  @media (max-width: 520px) {
    .view-label {
      display: none;
    }
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
