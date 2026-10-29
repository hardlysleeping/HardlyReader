<script lang="ts">
  import type { PaneMode } from "../lib/panes";
  import { layout } from "../state/layout.svelte";
  import { split } from "../state/split.svelte";

  /**
   * A mode button records the choice, then asks the window to fit it.
   *
   * The record is unconditional, so the press always does something. The ask is
   * what makes the button mean what it says: pressing 3 in a 900px window grows
   * it to the three-pane width instead of drawing two panes and a complaint.
   * Growing only, for 2 and 3 — a window already wider than the mode needs keeps
   * its room and the panes share it. Pressing 1 goes to the one-pane width,
   * because collapsing is the one press that means "take less space".
   *
   * Where the window cannot be resized (a browser tab, a phone) the ask fails
   * quietly and the tooltip below keeps saying the window is too narrow: the
   * mode still changed, so nothing is lost but the resize.
   */
  async function choose(mode: PaneMode) {
    // A split is a layout of its own: choosing a column layout leaves it on the
    // pane that was being read, which is what `leave` hands back to the account's
    // reader. The press is answered either way.
    if (split.active) await split.leave();
    await layout.chooseMode(mode);
  }

  /** The split family: on, and off again to the columns it was entered from. */
  async function chooseSplit() {
    if (split.active) await split.leave();
    else split.enter();
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
      class:on={!split.active && layout.mode === item.mode}
      aria-pressed={!split.active && layout.mode === item.mode}
      title={layout.squeezed && layout.desired === item.mode
        ? `${item.hint} — this window cannot get wide enough, showing ${layout.mode}`
        : item.hint}
      onclick={() => choose(item.mode)}
    >
      {item.label}
    </button>
  {/each}
  <!-- The split family beside the column layouts. A pane there is a whole reader
       with a stream of its own, so it is a different way to run the app rather
       than a fourth column — which is why its button says so with a picture
       instead of a number. Not offered where the frame cannot hold two panes: a
       phone draws one column and its stack is the answer there. -->
  {#if layout.caps.paneCount}
    <span class="viewsplit" aria-hidden="true"></span>
    <button
      class="mode split"
      class:on={split.active}
      aria-pressed={split.active}
      aria-label="Split view"
      title={split.active
        ? "Split view: up to four panes, each on its own stream — press to go back to the columns"
        : "Split view: up to four panes, each on its own stream; the sidebar opens feeds in the pane you last pressed"}
      onclick={() => void chooseSplit()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
        <path d="M8 3v10" />
      </svg>
    </button>
  {/if}
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

  /* The hairline the pane switch already draws between groups of buttons. */
  .viewsplit {
    width: 1px;
    align-self: stretch;
    margin: 2px 1px;
    background: var(--edge-soft);
  }

  .mode.split {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
  }

  .mode.split svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
</style>
