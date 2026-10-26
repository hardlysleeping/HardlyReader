<script lang="ts">
  /**
   * The phone's sliding stack, as a container.
   *
   * Three panes, one screen wide each, laid side by side and moved with
   * `translateX` rather than by changing the grid's tracks. That is the whole
   * difference from the desktop layout: the panes do not resize, so a pane does
   * not relayout while it travels — the content is drawn at the width it will
   * end at and the transform only moves it, which is the cheap half of what a
   * track animation costs (see the note on `tracks()` in `Main.svelte`).
   *
   * It is the *same* components the columns are made of — `Sidebar`,
   * `ArticleList`, `ReaderPane` — so the list keeps its rows, its scroll and its
   * place, and a post is opened by the same code whether it is on a phone or in
   * the third column of a desktop window.
   *
   * This component is mounted only while the stack is being drawn (see
   * `slidesInPortrait`). Portrait with the `single` preference and every
   * landscape or desktop frame keep the grid in `Main.svelte` exactly as it
   * was, which is what lets the one-pane walk stay untouched.
   */
  import { onMount } from "svelte";

  import ArticleList from "./ArticleList.svelte";
  import ReaderPane from "./ReaderPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { motionEase, motionMs } from "../lib/panes";
  import { isTauri } from "../lib/platform";
  import { layout } from "../state/layout.svelte";
  import { reader } from "../state/reader.svelte";
  import { EDGE, offsetFor, type MobileNavState, type MobilePane } from "../state/mobile-nav.svelte";

  let {
    nav,
    /**
     * The frame itself, handed up as it mounts and taken back as it goes.
     *
     * The layout's ResizeObserver watches the pane container, and this is that
     * element while the stack is what is drawn: without it a phone in the stack
     * would stop reporting its width on the way into landscape, and the mode
     * would stay at one column — the desktop three-pane layout would never
     * arrive after a rotation. A callback rather than a bindable prop because
     * what the parent wants is a measurement of an element it does not own, and
     * a written-back prop is the kind of thing that fails silently.
     */
    onframe,
    onClose,
    onLock,
  }: {
    nav: MobileNavState;
    onframe?: (element: HTMLElement | null) => void;
    onClose?: () => void;
    onLock?: () => void;
  } = $props();

  let frameEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const element = frameEl;
    onframe?.(element);
    return () => {
      if (element !== null) onframe?.(null);
    };
  });

  /** The pane in front. Read through a getter so the effect below is plain. */
  const showing = $derived(nav.showing);

  /** Where the pane in front came from, for the way back to name it. */
  const backTo = $derived(nav.overlayPane === 1 ? "Feeds" : "Posts");

  /**
   * The reader's level, followed.
   *
   * Only a *change* of it is acted on, and that is deliberate: a feed being
   * picked changes the stream, not whether an article is open, so the feeds
   * overlay is left in front and another feed can be picked. Choosing a post is
   * a change, and the article that was chosen comes to the front — including
   * when the reader was already article-deep and the list was peeking over the
   * old one.
   */
  let wasReading = reader.selectedId !== null;

  $effect(() => {
    const reading = reader.selectedId !== null;
    if (reading === wasReading) return;
    wasReading = reading;
    if (reading) {
      nav.landOnArticle();
      return;
    }
    nav.syncReading(false);
  });

  onMount(() => {
    // A stack opened with a post already on screen starts on the article, not
    // on a list the reader is not looking at.
    nav.syncReading(reader.selectedId !== null);

    window.addEventListener("popstate", onPopState);
    const stopBack = watchAndroidBack();

    return () => {
      window.removeEventListener("popstate", onPopState);
      stopBack();
    };
  });

  /**
   * One layer outward, as every back gesture asks for it.
   *
   * The stack answers the layers it owns and says so; at the root it says
   * `app`, and whatever pressed back decides what that means. The article is
   * closed through the reader, because closing it is the reader's business and
   * the base follows on its own (`syncReading`).
   */
  function stepOut(): boolean {
    const step = nav.back();
    if (step === "article") {
      reader.closeReader();
      return true;
    }
    return step === "overlay";
  }

  /* ------------------------------------------------------------------ *
   * Android's back button
   *
   * Registering a handler takes the shell's default behaviour over, so the root
   * case has to be answered here too: the webview's own history if it has any,
   * and otherwise the app leaves, which is what the key does on Android when
   * there is nowhere left to go inside the app.
   * ------------------------------------------------------------------ */
  function watchAndroidBack(): () => void {
    if (!isTauri()) return () => {};
    let gone = false;
    let unregister: (() => void) | null = null;
    void (async () => {
      try {
        const { onBackButtonPress, exit } = await import("@tauri-apps/api/app");
        const listener = await onBackButtonPress(({ canGoBack }) => {
          if (stepOut()) return;
          if (canGoBack) {
            window.history.back();
            return;
          }
          void exit(0);
        });
        if (gone) {
          void listener.unregister();
          return;
        }
        unregister = () => void listener.unregister();
      } catch {
        // No shell to ask: the gesture and the bar are still there.
      }
    })();
    return () => {
      gone = true;
      unregister?.();
      unregister = null;
    };
  }

  /**
   * One history entry, armed while the stack has a layer to unwind.
   *
   * A browser — and the Android webview behind a shell that does not report its
   * back key — answers the system gesture with `history.back()`. The stack
   * spends that press on its own outermost layer and arms another while there
   * is one left, so back walks article → posts → app rather than leaving the
   * page from wherever you are. Exactly one entry is held: the press and the
   * re-arm are one each, and a stack with nothing left in front holds none, so
   * the next press is the app's.
   */
  let armed = false;

  $effect(() => {
    if (nav.depth === 0 || armed) return;
    armed = true;
    window.history.pushState({ hardlyreader: "stack" }, "");
  });

  function onPopState(): void {
    if (!armed) return;
    armed = false;
    stepOut();
  }

  /* ------------------------------------------------------------------ *
   * The edge swipe
   *
   * A gesture that starts against the left edge, travels mostly sideways, and
   * is deliberate. Everything else is not this component's: a vertical drag is
   * the reader's scroll, a pull down from the top is pull-to-refresh, and the
   * scroll-to-advance at the end of a post is the article's own. Nothing here
   * calls `preventDefault`, so a gesture this component does not claim keeps
   * doing exactly what it did before the stack existed — and the edge band is
   * narrow for the same reason: 28px is where the system's own back gesture
   * lives, and nowhere else.
   * ------------------------------------------------------------------ */
  let swipe: { x: number; y: number; at: number } | null = null;

  function ontouchstart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      swipe = null;
      return;
    }
    const touch = event.touches[0];
    // Not near the edge: not ours. Left `null` rather than recorded-and-ignored
    // so a gesture that starts mid-screen can never be claimed on its way out.
    if (touch.clientX > EDGE) {
      swipe = null;
      return;
    }
    swipe = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }

  function ontouchend(event: TouchEvent): void {
    const start = swipe;
    swipe = null;
    if (start === null || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // A thumb, not a twitch; sideways, not a diagonal scroll; and a gesture,
    // not a hold.
    if (Math.abs(dx) < 64) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (Date.now() - start.at > 800) return;
    if (dx > 0) nav.openPrevious();
    else nav.closeOverlay();
  }

  /** The panes, in the order the layout numbers them. */
  const panes: MobilePane[] = [1, 2, 3];
</script>

<div
  class="stack"
  style:--slide-ms={`${motionMs(layout.motion)}ms`}
  style:--slide-ease={motionEase(layout.motion)}
>
  <!-- The way out of an overlay without a gesture. It is a bar rather than a
       floating button because the pane underneath is the feed list, whose own
       top row is the search field: a button laid over that is a button in the
       way, and one that covers a list of posts is worse. It only exists while
       an overlay is open, so the base alone loses no height to it. -->
  {#if nav.overlayPane !== null}
    <nav class="bar" aria-label="Location">
      <button
        type="button"
        class="step"
        onclick={() => nav.closeOverlay()}
        aria-label={`Back to the ${backTo.toLowerCase()}`}
        title={`Back to the ${backTo.toLowerCase()}`}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <span class="where">{backTo}</span>
    </nav>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="frame" bind:this={frameEl} {ontouchstart} {ontouchend}>
    {#each panes as pane (pane)}
      <!-- Every layer is mounted, always: the pane behind the one in front is
           what the slide uncovers, and a layer built at the end of a gesture
           would arrive empty. Hidden ones are `inert`, so the tab order and the
           screen reader follow the pane that is actually in front. -->
      <section
        class="layer"
        class:front={showing === pane}
        class:behind={pane < showing}
        class:ahead={pane > showing}
        style:transform={`translateX(${offsetFor(showing, pane)}%)`}
        style:z-index={3 - Math.abs(pane - showing)}
        aria-hidden={showing !== pane}
        inert={showing !== pane}
      >
        {#if pane === 1}
          <!-- No inline posts here: the posts are pane two, and a feed tap opens
               them into their own layer rather than unfolding them under the
               row. -->
          <Sidebar inlinePosts={false} />
        {:else if pane === 2}
          <ArticleList />
        {:else}
          <ReaderPane {onClose} {onLock} />
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .stack {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* One pane wide each, and moved rather than resized: the layer occupies the
     frame and the transform is what puts it where it belongs. `translateX` is a
     percentage of the layer's own width, which is the frame's, so the same
     offsets hold on any phone. */
  .layer {
    position: absolute;
    inset: 0;
    display: flex;
    min-width: 0;
    overflow: hidden;
    background: var(--bg);
    transition: transform var(--slide-ms, 0ms) var(--slide-ease, ease);
  }

  .layer > :global(*) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  /* The pane behind the one in front is a sliver at the left edge: it is the
     affordance for the edge swipe, and dimmed so it reads as behind rather than
     as a second column. The pane ahead is off screen; dimming it as well costs
     nothing and keeps the shadow arithmetic in one place. */
  .layer.behind::after,
  .layer.ahead::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.24);
    pointer-events: none;
  }

  .layer.front::after {
    content: none;
  }

  /* A layer that is not in front is not a surface: it cannot be touched, it is
     not in the tab order, and `inert` says the same thing to assistive tech.
     This is what stops a tap aimed at the pane in front landing on the one
     behind it while the slide is still running. */
  .layer:not(.front) {
    pointer-events: none;
  }

  .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 34px;
    padding: 0 8px;
    border-bottom: 1px solid var(--edge);
    background: var(--surface);
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
  }

  .step {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .step svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .step:hover,
  .step:focus-visible {
    color: var(--text);
    background: var(--hover);
  }

  .where {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-dim);
  }

  /* Thumbs need bigger targets than pointers do. */
  @media (pointer: coarse) {
    .step {
      width: 34px;
      height: 34px;
    }

    .bar {
      height: 42px;
    }
  }

  /* Asked for no motion: the layer changes in one frame, which is a cut, not a
     broken slide. */
  @media (prefers-reduced-motion: reduce) {
    .layer {
      transition: none;
    }
  }
</style>
