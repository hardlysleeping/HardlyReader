<script lang="ts">
  /**
   * The gestures this device answers to, and the one honest promise of a
   * settings section like this: **Off means the handler is not installed.**
   *
   * Four rows, and each one names a gesture that already worked. Nothing new is
   * invented here — the pane swipe, the pull, drag-to-scroll and the long press
   * were all hardcoded, and a phone is the place where an accidental gesture is
   * something the app does anyway. The panel writes `chrome.gestures`; the
   * components read it at the moment the gesture begins.
   *
   * Rows are drawn where the platform can honour them. A desktop has no pane to
   * swipe between and a phone has no mouse to drag with, so each row is present
   * only where the gesture exists — a switch for something that cannot happen is
   * worse than no switch at all.
   *
   * Two rows from the plan are deliberately absent, and absence is the honest
   * answer for both: "back to the feeds" would be a fourth opinion about where
   * back goes (the bar, the edge swipe and the hardware key already decide), and
   * a double tap on a post cannot coexist with a single tap that opens it
   * without making every tap wait 300ms.
   */
  import { layout } from "../state/layout.svelte";
  import { chrome } from "../state/chrome.svelte";
  import {
    LONG_PRESS_CHOICES,
    PULL_ACTIONS,
    PULL_LABELS,
    type LongPressMs,
    type PullAction,
  } from "../lib/gestures";

  const phone = $derived(layout.device === "phone");
</script>

<div class="row">
  <span class="key">Drag to scroll</span>
  <button
    class="switch"
    aria-pressed={chrome.gestures.dragScroll}
    onclick={() => chrome.setGesture("dragScroll", !chrome.gestures.dragScroll)}
    title="Pull a list or an article with the pointer, the way a finger would"
  >
    {chrome.gestures.dragScroll ? "On" : "Off"}
  </button>
</div>
<p class="hint">
  {chrome.gestures.dragScroll
    ? "A press and a pull moves the list under the pointer."
    : "The pointer selects text instead. The wheel and the keyboard still scroll."}
</p>

{#if phone}
  <div class="row">
    <span class="key">Swipe between panes</span>
    <button
      class="switch"
      aria-pressed={chrome.gestures.paneSwipe}
      onclick={() => chrome.setGesture("paneSwipe", !chrome.gestures.paneSwipe)}
      title="Swipe from the left edge to step out of a pane"
    >
      {chrome.gestures.paneSwipe ? "On" : "Off"}
    </button>
  </div>
  <p class="hint">
    {chrome.gestures.paneSwipe
      ? "A sideways swipe from the left edge steps one pane out, like the ‹ in the bar."
      : "Only the bar's ‹ steps out. Nothing at the edge is listening."}
  </p>

  <div class="row">
    <span class="key">Pull down</span>
    <div class="seg" role="group" aria-label="Pull down">
      {#each PULL_ACTIONS as action (action)}
        <button
          aria-pressed={chrome.gestures.pull === action}
          onclick={() => chrome.setGesture("pull", action as PullAction)}
        >
          {PULL_LABELS[action]}
        </button>
      {/each}
    </div>
  </div>
  <p class="hint">
    {chrome.gestures.pull === "off"
      ? "The list does not answer a pull at its top at all — nothing is listening."
      : "At the top of a list, pull down and let go to fetch the newest posts."}
  </p>
{/if}

<div class="row">
  <span class="key">Long press</span>
  <div class="seg" role="group" aria-label="Long press">
    {#each LONG_PRESS_CHOICES as ms (ms)}
      <button
        aria-pressed={chrome.gestures.longPressMs === ms}
        onclick={() => chrome.setGesture("longPressMs", ms as LongPressMs)}
      >
        {ms} ms
      </button>
    {/each}
  </div>
</div>
<p class="hint">
  How long a finger rests on a row before its menu opens. A shorter press answers
  faster and mistakes a pause for a hold more often.
</p>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 0;
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    text-align: left;
  }

  .switch {
    flex: none;
    padding: 4px 10px;
    border: 1px solid var(--edge-soft);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .switch[aria-pressed="true"] {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .seg {
    display: flex;
    flex: none;
    border: 1px solid var(--edge-soft);
    border-radius: 6px;
    overflow: hidden;
  }

  .seg button {
    padding: 5px 9px;
    border: 0;
    border-left: 1px solid var(--edge-soft);
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .seg button:first-child {
    border-left: 0;
  }

  .seg button[aria-pressed="true"] {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  }

  .hint {
    margin: 0 0 8px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--muted);
  }
</style>
