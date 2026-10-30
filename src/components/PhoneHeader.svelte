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
   * Everything that is not navigation is behind one gear: the consolidated
   * settings sheet, which already holds Reading, Layout, Accounts, Sync and
   * About. No new menu and no new panel — and a gear, because `•••` is what a
   * phone uses for "more of this row", which is not what this opens.
   *
   * Day and night sits beside it, on the same side of the bar and one press
   * away. It used to live in the sidebar's strip under the search field, where
   * a whole-screen change was one thumb-width from the search field and two
   * from the lock; the bar is where a phone keeps the things that change the
   * whole screen.
   *
   * Sync stays out in the open at the trailing edge, because it is the one
   * control here that means "ask the server". It answers a finished sync the
   * way the desktop bar does: a tick for a moment, then the arrows again — see
   * the effect below.
   *
   * Presentation only: the reader, the layout and the nav store, and the same
   * `refresh()`, the same settings sheet, the same `back()`. It draws 36px of
   * visible height plus whatever the status bar needs, which `app.css` pays for
   * with `--safe-top` — see the phone block there. 36 rather than 42: a title
   * bar on a phone holds one line of text and three glyphs, and the 42 it used
   * to hold was a desktop toolbar's height, which on a phone reads as a gap
   * between the clock and the app rather than as a bar.
   *
   * It is also the phone's *only* bar. The sliding stack used to draw a second,
   * 42px strip of its own while a pane was slid over another; that state is a
   * depth this bar can already name (`atRoot`), so the strip is gone and the
   * one step out lives here — one strip, one step, one place to look.
   */
  import type { Snippet } from "svelte";
  import { syncDescription, syncReadout } from "../lib/sync-progress";
  import { layout } from "../state/layout.svelte";
  import { chrome } from "../state/chrome.svelte";
  import { mobileNav, slidesInPortrait } from "../state/mobile-nav.svelte";
  import { reader } from "../state/reader.svelte";
  import ReadingControls from "./ReadingControls.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  
  let {
    subtitle = "",
    server = "",
    onsignout,
    onaddaccount,
    controls,
  }: {
    /** The account's display name, for the settings sheet's Accounts section. */
    subtitle?: string;
    /** The server this window is signed in to, exactly as it was entered. */
    server?: string;
    /** Sign out of every account on this device. */
    onsignout?: () => void;
    /** Sign a second account in without touching the one in use. */
    onaddaccount?: () => void;
    /**
     * The arrangement controls the desktop bar draws — the pane switch, and the
     * fold beside it.
     *
     * The same snippet, so the phone cannot offer a different set of shapes from
     * the window. It is passed in rather than imported because the switch is the
     * view's: it knows which modes this screen can honour, and the bar does not.
     */
    controls?: Snippet;
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

  /** The Aa panel, so its trigger and its rows are the desktop bar's own. */
  let readingControls = $state<{ openPanel: () => void; closePanel: () => void } | undefined>();

  const refreshing = $derived(reader.sync.active);
  const readout = $derived(syncReadout(reader.sync));
  const description = $derived(syncDescription(reader.sync));

  /**
   * The bar answers a finished sync the way the desktop bar answers one: one
   * thin ring on its own edge, in the sync colour, gone in a third of a second,
   * and a tick in place of the arrows for a moment after.
   *
   * The turning arrows this bar used to draw were the desktop bar's older
   * answer, and on a phone they read as a control that had stopped rather than
   * one that had finished: the same mark, in the same place, only now still.
   * A tick cannot be mistaken for either.
   */
  let pulse = $state(false);
  let justFinished = $state(false);
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  let wasActive = reader.sync.active;
  $effect(() => {
    const activeNow = reader.sync.active;
    if (wasActive && !activeNow) {
      wasActive = false;
      pulse = true;
      justFinished = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      tickTimer = setTimeout(() => {
        tickTimer = null;
        justFinished = false;
      }, 1200);
    } else if (!wasActive && activeNow) {
      wasActive = true;
      justFinished = false;
      if (tickTimer !== null) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    }
  });

  $effect(() => () => {
    if (tickTimer !== null) clearTimeout(tickTimer);
  });

  /** What the control says it is, which is also what it just did. */
  const syncLabel = $derived(justFinished ? "Synced" : description);

  /** The reader owns the sync; this button only asks for it. */
  async function refresh() {
    await reader.refresh();
  }
</script>

<header class="phone-header">
  {#if pulse}
    <span class="pulse" aria-hidden="true" onanimationend={() => (pulse = false)}></span>
  {/if}
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
    <!-- The pane you are in, named — except for an article, which names itself.
         A post's own headline is the first thing under this bar and the biggest
         thing on the page; repeating it here cost a second full line of the
         title for nothing, and left the words to fight the progress readout for
         the width. The step out still says where back goes, so the bar still
         answers "where am I" in the one word that is not already on screen.

         A list has no headline of its own, so the stream's name stays here — and
         the pane stops drawing it on a phone for the same reason, one line
         down. -->
    {#if depth !== 3}
      <span class="where" title={title}>{title}</span>
    {/if}
  {/if}

  <span class="spacer"></span>

  <!-- The arrangement, then the text: the two settings a reader reaches for
       while reading, out of the sheet and in the bar. The pane switch is the
       view's own snippet — the same one the desktop bar draws — so a phone
       offers exactly the shapes its screen can honour. -->
  {#if controls}
    {@render controls()}
  {/if}

  <!-- The Aa panel: text size, leading, alignment and the thumbnails, the same
       rows the desktop bar opens. Opening it puts the sheet away, because two
       panels on one screen is one too many. -->
  <ReadingControls bind:this={readingControls} onopen={() => (settingsOpen = false)} />

  <!-- A feed, added from the bar. The form is the sidebar's — one form, one
       place it lives — so this asks for it rather than drawing a second one. -->
  <button
    type="button"
    class="more add"
    onclick={() => chrome.askAddFeed()}
    aria-label="Add a feed"
    title="Add a feed"
  >
    <svg class="plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  </button>

  <!-- Day and night, one press from the gear it changes the look of. -->
  <!-- The day / night switch lives beside the search field now (see
       `Sidebar`): a bar of three controls that move you between panes, and the
       switch where the list it changes begins. -->

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
  >
    <svg class="gear" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.1 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z"
      />
    </svg>
  </button>

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
    class:done={justFinished}
    onclick={refresh}
    disabled={refreshing}
    aria-label={syncLabel}
    title={syncLabel}
  >
    {#if justFinished}
      <svg class="glyph tick" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5 10.2 17.7 19 7.5" />
      </svg>
    {:else}
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 0 1-14.8 5.7" />
        <path d="M3.5 12a8.5 8.5 0 0 1 14.8-5.7" />
        <path d="M18.3 2.9v3.8h-3.8" />
        <path d="M5.7 21.1v-3.8h3.8" />
      </svg>
    {/if}
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
  /* 36px of visible bar. The status bar's own height is padding, paid by
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
    /* The same 36px of content, measured from where the padding puts it: the
       bar sits 24px higher than the raw inset (see `app.css`), and its height
       has to agree or `overflow: hidden` clips the controls. */
    height: calc(max(0px, calc(var(--safe-top) - 24px)) + 36px);
    background: var(--surface);
    overflow: hidden;
  }

  /* On its side the bar is the top of the screen: no status-bar strip above it,
     36px of controls, and the rest of the height is the panes. */
  @media (orientation: landscape) {
    .phone-header {
      height: 36px;
    }
  }

  /* The root's title: the app's name, at the weight the desktop brand has. */
  .wordmark {
    /* A bar is a row of controls first and a title second: a long name shortens,
       and no control is ever the thing that leaves the bar. */
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  /* One step out. The glyph and the word are one control, so the thing that
     says "back" and the thing that names where back goes cannot be aimed at
     separately. */
  .step {
    display: inline-flex;
    flex: 0 1 auto;
    min-width: 0;
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
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
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
    flex: 1 1 0;
    min-width: 0;
  }

  /* The quiet door: the same size as Sync, so a thumb finds it, and none of its
     colour — it changes nothing about what is on screen. */
  .plus {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
  }

  .more {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
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

  .gear {
    display: block;
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .more:hover,
  .more:focus-visible,
  .more[aria-expanded="true"] {
    color: var(--text);
    background: var(--hover);
  }

  /* The passed-in arrangement switch is a desktop control: 26px buttons in a
      bordered group. On a 36px bar it keeps its size and loses the border, so the
     bar reads as one row of glyphs rather than a row with a widget in it. */
  .phone-header :global(.switch) {
    height: 26px;
    border-color: transparent;
    background: none;
  }

  .sync {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
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

  .glyph.tick {
    stroke-width: 2.3;
  }

  /* A finished sync: the same ring the band draws on a lock or an unlock, in
     the sync colour, on the bar's own edge. */
  .pulse {
    position: absolute;
    inset: 0;
    pointer-events: none;
    --pulse-tone: var(--tone-sync);
    animation: hrs-bar-pulse 360ms ease-out both;
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
    .pulse {
      animation: none;
      box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--tone-sync) 45%, transparent);
    }
  }
</style>
