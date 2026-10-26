<script lang="ts">
  /**
   * The phone's title bar: where you are, one step out, and Sync.
   *
   * The desktop bar is a toolbar — it holds a drawer toggle, the account, the
   * layout switch, two panels and Sync, because a window has the width for all
   * of them. A phone does not, and a bar that answers a narrow screen by hiding
   * half of itself behind a hamburger is a toolbar pretending to be a title bar.
   * So this one is hierarchical, which is what a phone's chrome has always been:
   *
   * - **Feeds** — the wordmark, and nothing to the left of it, because there is
   *   nothing behind the feeds.
   * - **Posts** — `‹ Feeds` and the stream's own name (the category, the filter).
   * - **Article** — `‹ Posts` and the post's title.
   *
   * The left control is one step outward, and it is the *same* step every other
   * way out takes: the stack's `mobileNav.back()`, which is what the edge swipe
   * and Android's back key call. No local navigation state, no second copy of
   * the decision — if this button and the gesture could ever disagree, one of
   * them would be wrong.
   *
   * Everything that is not navigation is behind one `•••`: the consolidated
   * settings sheet, which already holds Reading, Layout, Accounts, Sync and
   * About. No new menu and no new panel. Sync stays out in the open at the
   * trailing edge, because it is the one control here that means "ask the
   * server", and it keeps its two arrows and its progress readout.
   *
   * Presentation only: the reader, the layout and the nav store, and the same
   * `refresh()`, the same settings sheet, the same `back()`. It draws 42px of
   * visible height plus whatever the status bar needs, which `app.css` pays for
   * with `--safe-top` — see the phone block there.
   *
   * It is also the phone's *only* bar. The sliding stack used to draw a second,
   * 42px strip of its own while a pane was slid over another; that state is a
   * depth this bar can already name (`atRoot`), so the strip is gone and the
   * one step out lives here — one strip, one step, one place to look.
   */
  import { syncDescription, syncReadout } from "../lib/sync-progress";
  import { layout } from "../state/layout.svelte";
  import { mobileNav, slidesInPortrait } from "../state/mobile-nav.svelte";
  import { reader } from "../state/reader.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";

  let {
    subtitle = "",
    server = "",
    onsignout,
    onaddaccount,
  }: {
    /** The account's display name, for the settings sheet's Accounts section. */
    subtitle?: string;
    /** The server this window is signed in to, exactly as it was entered. */
    server?: string;
    /** Sign out of every account on this device. */
    onsignout?: () => void;
    /** Sign a second account in without touching the one in use. */
    onaddaccount?: () => void;
  } = $props();

  /**
   * Whether the sliding stack is what is on screen.
   *
   * Asked the same way the view asks it, so the header cannot describe a pane
   * that is not drawn. A phone in portrait with the walk instead of the stack
   * still gets this header — there is one bar either way — but its levels are
   * the walk's two, not the stack's three.
   */
  const slideStack = $derived(
    slidesInPortrait({
      device: layout.device,
      portrait: layout.upright,
      mode: layout.mobilePortraitMode,
    }),
  );

  /**
   * Which pane is in front, in the stack's own numbers.
   *
   * The stack answers for itself. The walk has two levels, and they are the
   * stack's first and third — the feeds, and an article open over them — because
   * in one column a feed opens its posts underneath itself instead of into a
   * pane of their own. A landscape phone draws the three columns, where nothing
   * is "in front"; the bar there is a title bar, and the wordmark is the honest
   * answer.
   */
  const depth = $derived.by((): 1 | 2 | 3 => {
    if (slideStack) return mobileNav.showing;
    if (layout.mode === 1 && reader.selectedId !== null) return 3;
    return 1;
  });

  /**
   * Whether there is anything behind the pane in front.
   *
   * The stack's own `depth` counts the layers it has an answer for, so a stack
   * resting on the posts with the feeds slid over them is depth 1 — there is
   * somewhere to go back to, even though the feeds are the shallower pane. This
   * is the question the *bar* asks: draw the wordmark only when there is nothing
   * behind, draw the step out when there is. Asking `depth === 1` instead made
   * the feeds-over-posts state draw the wordmark and no way out, which is why
   * the stack used to carry a second, 42px strip of its own for exactly that
   * state; folding that strip into this bar is what this derived is for.
   *
   * The walk has two levels and no stack, so its root is unchanged: no article
   * open is the feeds.
   */
  const atRoot = $derived(slideStack ? mobileNav.depth === 0 : depth === 1);

  /**
   * What the left control goes back to, named as the destination.
   *
   * Read from the nav rather than assumed from the depth number: a shallower
   * pane can be slid *over* a deeper one — the feeds over the posts, the posts
   * over an article — and there `back` lands on the pane underneath rather than
   * one step further out. A control that says "Feeds" and goes to the article
   * is worse than no control at all.
   */
  const backTo = $derived.by((): "Feeds" | "Posts" | "Article" => {
    // The walk's one step out of an article is the feeds it came from.
    if (!slideStack) return "Feeds";
    // An overlay dismisses to the pane it was slid over, which is the base.
    if (mobileNav.overlayPane !== null) return mobileNav.basePane === 3 ? "Article" : "Posts";
    // Nothing over the base: the article's step out is the posts.
    return "Posts";
  });

  /**
   * The pane you are in, named — not the one you came from.
   *
   * The feeds slid over the posts are the feeds, whatever stream the list
   * underneath is showing; an article is its own title; the posts are the
   * stream's name (the category, the filter).
   */
  const title = $derived.by(() => {
    if (slideStack && mobileNav.overlayPane === 1) return "Feeds";
    return depth === 3 ? (reader.selected?.title ?? reader.activeTitle) : reader.activeTitle;
  });

  /**
   * One step outward.
   *
   * `back()` is the whole operation: it closes an overlay, reports the article
   * for the reader to close, and says `app` when the stack has nothing left.
   * That last answer is not a reason to do nothing — at the root the step
   * outward is opening the pane behind, which is exactly what the right-swipe
   * does — so it becomes `openPrevious()`. In the walk there is one level, and
   * leaving it is the reader's own `closeReader()`.
   */
  function back(): void {
    if (!slideStack) {
      reader.closeReader();
      return;
    }
    const step = mobileNav.back();
    if (step === "article") {
      reader.closeReader();
      return;
    }
    if (step === "app") mobileNav.openPrevious();
  }

  /** The settings sheet, which is the same one the desktop bar opens. */
  let settingsOpen = $state(false);

  const refreshing = $derived(reader.sync.active);
  const readout = $derived(syncReadout(reader.sync));
  const description = $derived(syncDescription(reader.sync));

  /** The reader owns the sync; this button only asks for it. */
  async function refresh() {
    await reader.refresh();
  }
</script>

<header class="phone-header">
  {#if atRoot}
    <!-- The root: the app's own name, and no control to the left of it. -->
    <span class="wordmark">HardlyReader</span>
  {:else}
    <button
      type="button"
      class="step"
      onclick={back}
      aria-label={`Back to the ${backTo.toLowerCase()}`}
      title={`Back to the ${backTo.toLowerCase()}`}
    >
      <span class="chev" aria-hidden="true">‹</span>
      <span class="back-to">{backTo}</span>
    </button>
    <span class="where" title={title}>{title}</span>
  {/if}

  <span class="spacer"></span>

  <!-- One door to everything that is not navigation. It opens the sheet the
       desktop bar opens from its menu row, so Reading, Layout, Accounts, Sync
       and About are the same controls with the same state. -->
  <button
    type="button"
    class="more"
    onclick={() => (settingsOpen = true)}
    aria-label="Settings and accounts"
    aria-haspopup="dialog"
    aria-expanded={settingsOpen}
    title="Settings and accounts"
  >•••</button>

  {#if refreshing}
    <!-- The count and the percentage, for as long as the sync lasts, in the same
         words the desktop bar uses. It sits beside the button rather than over
         the title: the number is read while the list is read. -->
    <span
      class="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={reader.sync.total}
      aria-valuenow={reader.sync.done}
      aria-valuetext={description}
      title={description}
    >
      <span class="readout">{readout}</span>
    </span>
  {/if}

  <!-- Trailing edge, as it is on the desktop bar: the one control that asks the
       server, in the sync colour, with the two arrows that turn while it works. -->
  <button
    type="button"
    class="sync"
    class:busy={refreshing}
    onclick={refresh}
    disabled={refreshing}
    aria-label={description}
    title={description}
  >
    <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 12a8.5 8.5 0 0 1-14.8 5.7" />
      <path d="M3.5 12a8.5 8.5 0 0 1 14.8-5.7" />
      <path d="M18.3 2.9v3.8h-3.8" />
      <path d="M5.7 21.1v-3.8h3.8" />
    </svg>
  </button>
</header>

<!-- Outside the bar, like the desktop header's: the sheet is a fixed overlay
     over the whole app, and the bar's own box is not where a dialog belongs. -->
<SettingsPanel
  bind:open={settingsOpen}
  name={subtitle}
  {server}
  {onaddaccount}
  {onsignout}
/>

<style>
  /* 42px of visible bar. The status bar's own height is padding, paid by
     `app.css` from `--safe-top`, so the bar keeps the height it has on the
     desktop and the surface behind the clock is still the header's.

     The fill and the hairline are not set here. On a phone this bar is a piece
     of the navigation material — translucent, blurred, one hairline — and that
     material, with both of its fallbacks, is declared once under the root phone
     switch in `app.css` (see "The material: navigation only"). What is left in
     this rule is a solid paint for the one frame before `data-device` is
     published; the phone rule overrides it at a higher specificity. */
  .phone-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    height: calc(var(--safe-top) + 42px);
    background: var(--surface);
    overflow: hidden;
  }

  /* The root's title: the app's name, at the weight the desktop brand has. */
  .wordmark {
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  /* One step out. The glyph and the word are one control, so the thing that
     says "back" and the thing that names where back goes cannot be aimed at
     separately. */
  .step {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 30px;
    margin-left: -4px;
    padding: 0 6px 0 2px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .step:hover,
  .step:focus-visible {
    color: var(--text);
    background: var(--hover);
  }

  .chev {
    font-size: 17px;
    line-height: 1;
  }

  .back-to {
    white-space: nowrap;
  }

  /* The pane you are in. It gives up characters before anything else moves, so
     a long post title cannot push Sync off the bar. */
  .where {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  /* The quiet door: the same size as Sync, so a thumb finds it, and none of its
     colour — it changes nothing about what is on screen. */
  .more {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 10px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 14px;
    letter-spacing: 1px;
    line-height: 1;
    cursor: pointer;
  }

  .more:hover,
  .more:focus-visible,
  .more[aria-expanded="true"] {
    color: var(--text);
    background: var(--hover);
  }

  .sync {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    margin-left: 2px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--tone-sync) 28%, var(--border));
    border-radius: 10px;
    background: none;
    color: var(--tone-sync);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .sync:hover:not(:disabled) {
    background: color-mix(in srgb, var(--tone-sync) 12%, transparent);
    border-color: color-mix(in srgb, var(--tone-sync) 60%, transparent);
  }

  .sync:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .glyph {
    display: block;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    overflow: visible;
  }

  /* While syncing the mark turns, and only the mark: the same signal the
     desktop bar gives. */
  .sync.busy .glyph {
    animation: turn 820ms linear infinite;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  .progress {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    min-width: 0;
    margin-left: 2px;
  }

  .readout {
    flex: 0 0 auto;
    color: color-mix(in srgb, var(--tone-sync) 55%, var(--muted));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .sync.busy .glyph {
      animation: none;
    }
  }
</style>
