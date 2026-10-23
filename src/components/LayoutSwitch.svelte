<script lang="ts">
  import type { PaneMode } from "../lib/panes";
  import { fitWindowTo } from "../lib/window-fit";
  import { layout } from "../state/layout.svelte";

  /**
   * A mode button does two things: it records the choice, then it makes the
   * window match it where that is possible. Recorded first so a window that
   * cannot be resized (a browser tab) still switches — it just stays squeezed.
   *
   * Two pixels of slack: the pane container is measured a hair narrower than
   * the window, and landing exactly on the threshold would flip back to the
   * smaller mode.
   */
  async function choose(mode: PaneMode) {
    layout.setMode(mode);
    await fitWindowTo(layout.widthFor(mode) + 2);
  }

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
      class:on={layout.mode === item.mode}
      aria-pressed={layout.mode === item.mode}
      title={layout.squeezed && layout.desired === item.mode
        ? `${item.hint} — this window is too narrow, showing ${layout.mode}`
        : item.hint}
      onclick={() => void choose(item.mode)}
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
