<script lang="ts">
  import type { PaneMode } from "../lib/panes";
  import { layout } from "../state/layout.svelte";

  const modes: { mode: PaneMode; label: string; hint: string }[] = [
    { mode: 1, label: "1", hint: "One column: feeds, then posts, then the article" },
    { mode: 2, label: "2", hint: "Two columns: feeds, and posts that open into the article" },
    { mode: 3, label: "3", hint: "Three columns: feeds, posts and the article side by side" },
  ];
</script>

<div class="switch" role="group" aria-label="Layout">
  {#each modes as item (item.mode)}
    <button
      class="mode"
      class:on={layout.desired === item.mode}
      aria-pressed={layout.desired === item.mode}
      title={layout.squeezed && layout.desired === item.mode
        ? `${item.hint} — this window is too narrow, showing ${layout.mode}`
        : item.hint}
      onclick={() => layout.setMode(item.mode)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .switch {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: var(--sunken, #171717);
  }

  .mode {
    min-width: 26px;
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted, #999999);
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
  }

  .mode:hover {
    color: var(--text, #e6e6e6);
  }

  .mode.on {
    background: var(--raised, #333333);
    color: var(--text, #e6e6e6);
  }
</style>
