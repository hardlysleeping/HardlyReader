<script lang="ts">
  /**
   * The post list's own options, beside the four views that chose them.
   *
   * The view buttons say what you are looking at; these are the settings
   * underneath that choice — how a row ends, how far that end turns, whether a
   * picture fills it, how many tiles are across. On a window those knobs sit on
   * the bar themselves, next to the views they change.
   *
   * On a phone the bar is one column wide, so they were moved into
   * `Settings → Post list` — which is where a setting belongs and not where a
   * knob is turned: the list is a pane away there, so every change is made
   * blind and has to be walked back to if it was wrong. So on a phone they come
   * up from the bottom edge, over the list they change, and the list is visible
   * underneath the whole time. The rows are `PostListPanel.svelte`: the same
   * ones the settings section draws, writing the same `reading` stores.
   *
   * Drawn only where the rows have something to say. Rows has the ends, their
   * corner and the picture fill; Grid has the ruler for its tiles. Cards and
   * List gave the phone's bar nothing to move, so a control that would open an
   * empty sheet on them is not drawn at all.
   */
  import { layout } from "../state/layout.svelte";
  import PostListPanel from "./PostListPanel.svelte";
  import Sheet from "./Sheet.svelte";

  let { view }: { view: string } = $props();

  let open = $state(false);

  const offers = $derived(
    layout.device === "phone" && (view === "regular" || view === "grid"),
  );

  function close(): void {
    open = false;
  }

  /**
   * The sheet outlives the view it was opened for — the bar's four shapes are
   * still reachable behind it. Switching to a shape with no knobs dismisses it
   * rather than leaving rows floating over a list they no longer describe.
   */
  $effect(() => {
    if (!offers) open = false;
  });
</script>

<!-- The trigger is a plain element that hides itself, not a `{#if}`: a block
     would share an insertion anchor with the sheet's block, and the sheet's
     node is one Svelte does not own (it moves itself into `body`), so the
     block after it stopped being re-inserted — the button came back only
     after a reload. One conditional in this file, and it is the last thing. -->
<button
  class="options"
  hidden={!offers}
    class:on={open}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Post list options"
    title="Post list options: how the rows end, how far they turn, and whether a picture fills them"
    onclick={() => (open = !open)}
>
  <!-- Three tracks with a knob each: the shape of a setting you can move. -->
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    <circle cx="10.4" cy="4" r="1.5" />
    <circle cx="5.6" cy="8" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
  </svg>
</button>

{#if open}
  <Sheet label="Post list options" onclose={close}>
    <PostListPanel ondone={close} />
  </Sheet>
{/if}

<style>
  /* The bar's own button, drawn here because a component's styles do not reach
     into another file: same box, same weight, same pressed colour as the four
     shapes it sits beside, and the same thumb size on a coarse pointer. */
  .options {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 21px;
    height: 19px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .options svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A knob is a filled dot on a track, not a hole in it. */
  .options circle {
    fill: var(--surface);
  }

  .options:hover {
    color: var(--text);
    background: var(--hover);
  }

  .options.on {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  @media (pointer: coarse) {
    .options {
      width: 32px;
      height: 30px;
    }

    .options svg {
      width: 14px;
      height: 14px;
    }
  }
</style>
