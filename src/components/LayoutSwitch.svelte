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
    border: 1px solid var(--edge-soft);
    border-radius: 6px;
    /* The theme's own surface, not a dark fallback: the old `--sunken` /
       `--raised` names exist in neither palette, so the switch stayed charcoal
       in the light theme and its numbers sank into it. */
    background: var(--surface);
  }

  .mode {
    min-width: 26px;
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
  }

  .mode:hover {
    color: var(--text);
  }

  .mode.on {
    background: var(--bg);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--edge);
  }
</style>
