<script lang="ts">
  /**
   * The split family on screen: up to four readers in the frame's width.
   *
   * Each pane is a whole reader — its own list, its own post, its own scroll —
   * and the one holding the focus is where the sidebar's next press goes. The
   * panes are equal shares with the app's 6px seam between them; the narrowest
   * pane is `SPLIT_MIN_PANE`, and a frame that cannot hold them all draws fewer
   * and says so rather than scrolling sideways.
   *
   * Focus is a hairline, not a fill: a pane is still the page it is showing, and
   * an accent wash behind someone's reading would be decoration arguing with the
   * article.
   */
  import { canClose, canSplit, splitTracks, squeezed, visibleCount } from "../lib/split";
  import { split } from "../state/split.svelte";
  import ArticleList from "./ArticleList.svelte";
  import ReaderPane from "./ReaderPane.svelte";

  /** The frame's width, measured rather than assumed: the window can be dragged. */
  let frame = $state<HTMLElement | null>(null);
  let width = $state(0);

  $effect(() => {
    const element = frame;
    if (element === null) return;
    width = element.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  /** How many panes are drawn: all of them until the frame is too narrow. */
  const drawn = $derived(Math.max(1, Math.min(split.count, visibleCount(split.count, width))));
  const shortened = $derived(squeezed(split.count, width));

  /**
   * A pane coming back into the frame is put back where it was.
   *
   * A hidden pane keeps its reader — its stream, its post, its place — but a box
   * that is not drawn loses its scroll offset, so the offset the reader is
   * holding is handed back to the list as it reappears. That is the same
   * hand-back a launch does, through `listScrollRestore`.
   */
  let wasDrawn = 0;
  $effect(() => {
    const now = drawn;
    if (now > wasDrawn) {
      for (const view of split.views.slice(wasDrawn, now)) {
        if (view.reader.liveScroll.list > 0) view.reader.listScrollRestore = view.reader.liveScroll.list;
      }
    }
    wasDrawn = now;
  });

  /**
   * The arrangement is written down whenever what it holds changes.
   *
   * Reading the streams, the posts and the focus is what makes this re-run; the
   * scroll is written by the pane's own reader on its own quiet timer, so a
   * scroll does not put this effect through a write per frame.
   */
  $effect(() => {
    for (const view of split.views) {
      void view.reader.activeStream;
      void view.reader.selectedId;
    }
    void split.focusedId;
    if (split.active) split.save();
  });

  function splitHere(event: MouseEvent): void {
    event.stopPropagation();
    split.addPane();
  }

  function closeHere(event: MouseEvent, id: string): void {
    event.stopPropagation();
    split.closePane(id);
  }
</script>

<div class="split" bind:this={frame}>
  <!-- Every pane is mounted, and one the frame cannot hold is not drawn rather
       than thrown away: its stream, its post and its place are still there when
       the window is wide enough again. -->
  <div
    class="panes"
    class:shortened
    style:grid-template-columns={splitTracks(drawn)}
  >
    {#each split.views as view, index (view.id)}
      <div
        class="pane"
        class:focused={view.id === split.focusedId}
        class:away={index >= drawn}
        data-pane={view.id}
        data-pane-focused={view.id === split.focusedId ? "" : undefined}
        style:grid-column={`${index * 2 + 1}`}
        role="group"
        aria-label={`Pane ${index + 1}: ${view.reader.activeTitle}`}
        onpointerdown={() => split.focus(view.id)}
      >
        <div class="bar">
          <span class="where" title={view.reader.activeTitle}>{view.reader.activeTitle}</span>
          <div class="acts">
            {#if canSplit(split.count)}
              <button
                type="button"
                class="act"
                aria-label="Split this pane"
                title="Split this pane — a new pane opens to the right, on its own stream"
                onclick={(event) => splitHere(event)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
                  <path d="M8 3v10" />
                </svg>
              </button>
            {/if}
            {#if canClose(split.count)}
              <button
                type="button"
                class="act"
                aria-label="Close this pane"
                title="Close this pane — the panes beside it keep their streams"
                onclick={(event) => closeHere(event, view.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
                </svg>
              </button>
            {/if}
          </div>
        </div>

        <div class="body">
          {#if view.reader.selectedId !== null}
            <!-- A post opens inside its own pane: with four of them there is no
                 fourth column to borrow, and the pane is a whole reader. -->
            <ReaderPane store={view.reader} onClose={() => split.closePost(view.id)} />
          {:else}
            <ArticleList store={view.reader} />
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if shortened}
    <p class="squeeze" role="status">
      {split.count - drawn} of {split.count} panes hidden — this window fits {drawn}.
    </p>
  {/if}
</div>

<style>
  .split {
    position: relative;
    display: flex;
    flex: 1 1 0px;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .panes {
    display: grid;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* A pane is a column of its own: a bar, and the reader under it. The hairline
     is drawn inside the box so it cannot take a pixel off the list. */
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
    box-shadow: inset 1px 0 0 var(--edge-soft);
  }

  .pane:first-child {
    box-shadow: none;
  }

  .pane.focused {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .pane.away {
    display: none;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 4px 0 8px;
    border-bottom: 1px solid var(--edge-soft);
    background: var(--surface);
    flex: 0 0 auto;
  }

  .where {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  .focused .where {
    color: var(--text-dim);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 2px;
    /* Quiet until the pane is in hand: two buttons per pane times four is a lot
       of furniture for a reading surface. */
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .pane:hover .acts,
  .pane:focus-within .acts,
  .pane.focused .acts {
    opacity: 1;
  }

  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .act:hover {
    color: var(--text);
    background: var(--hover);
  }

  .act svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Said once, over the frame's foot, because a pane that is not drawn is a
     promise the window has not kept — and silence would read as a lost stream. */
  .squeeze {
    position: absolute;
    right: 10px;
    bottom: 10px;
    margin: 0;
    padding: 4px 9px;
    border: 1px solid var(--edge-soft);
    border-radius: 999px;
    background: var(--surface-solid);
    color: var(--muted);
    font-size: 11px;
    pointer-events: none;
  }
</style>
