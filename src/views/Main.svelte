<script lang="ts">
  import { onMount } from "svelte";

  import type { Session, UserInfo } from "../api/freshrss";
  import ArticleList from "../components/ArticleList.svelte";
  import FloodLayer from "../components/FloodLayer.svelte";
  import CategoryMenu from "../components/CategoryMenu.svelte";
  import Header from "../components/Header.svelte";
  import LayoutSwitch from "../components/LayoutSwitch.svelte";
  import LoadAura from "../components/LoadAura.svelte";
  import PaneGutter from "../components/PaneGutter.svelte";
  import ReaderPane from "../components/ReaderPane.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { isTypingTarget, resolveKey, resolveShiftKey } from "../lib/keys";
  import { backLabel, levelOf, stepBackTarget, whereLabel } from "../lib/one-pane";
  import { readingVars } from "../lib/reading-layout";
  import { chrome } from "../state/chrome.svelte";
  import { layout } from "../state/layout.svelte";
  import { reading } from "../state/reading.svelte";
  import { reader } from "../state/reader.svelte";

  let {
    session,
    account,
    onsignout,
  }: { session: Session; account: UserInfo | null; onsignout?: () => void } = $props();

  /** In one-column mode, whether the posts level is showing rather than the feeds. */
  let onePosts = $state(false);
  let panes = $state<HTMLElement | null>(null);

  const mode = $derived(layout.mode);
  const menu = $derived.by(() => {
    const point = reader.menu;
    const model = reader.menuModel;
    return point === null || model === null ? null : { x: point.x, y: point.y, model };
  });

  onMount(() => {
    chrome.load();
    layout.load();
    reading.load();
    void reader.start(session);

    // The mode is drawn from the real container width rather than from an
    // `innerWidth` guess, and the observer has one job: report that width.
    const observer =
      panes === null
        ? null
        : new ResizeObserver(([entry]) => layout.setAvailable(entry.contentRect.width));
    if (panes !== null && observer !== null) observer.observe(panes);

    window.addEventListener("keydown", onkeydown);
    return () => {
      window.removeEventListener("keydown", onkeydown);
      observer?.disconnect();
      reader.stop();
    };
  });

  function reduceMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function pageArticle(direction: -1 | 1): void {
    const el = document.querySelector<HTMLElement>('[data-scroll="article"]');
    if (el === null) return;
    el.scrollBy({
      top: direction * el.clientHeight * 0.85,
      behavior: reduceMotion() ? "auto" : "smooth",
    });
  }

  /**
   * The key map itself lives in `lib/keys.ts`; this carries the intents out.
   * Up/Down move between feeds in every mode, Right enters and Left backs out,
   * which is why article movement is Space, the toolbar buttons and scrolling.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const context = {
      typing: isTypingTarget(event.target),
      menuOpen: reader.menu !== null,
      hasArticle: reader.selectedId !== null,
      atArticleStart: reader.articleAtStart,
      atArticleEnd: reader.articleAtEnd,
    };
    const intent = event.shiftKey
      ? resolveShiftKey(event.key, context)
      : resolveKey(event.key, context);

    switch (intent.type) {
      case "none":
        return;
      case "stream":
        event.preventDefault();
        onePosts = true;
        void reader.stepStream(intent.delta);
        return;
      case "first":
        event.preventDefault();
        onePosts = true;
        void reader.firstStream();
        return;
      case "last":
        event.preventDefault();
        onePosts = true;
        void reader.lastStream();
        return;
      case "enter":
        event.preventDefault();
        if (mode === 1) onePosts = true;
        void reader.enter();
        return;
      case "back":
        event.preventDefault();
        // Out of the article first; with the feeds off screen, a second press
        // leaves the posts level too.
        if (!reader.back() && mode === 1) onePosts = false;
        return;
      case "escape":
        if (reader.menu !== null) {
          event.preventDefault();
          reader.closeCategoryMenu();
          return;
        }
        if (reader.back()) event.preventDefault();
        else if (mode === 1) onePosts = false;
        return;
      case "page":
        event.preventDefault();
        if (intent.advance) void reader.advanceArticle(intent.direction);
        else pageArticle(intent.direction);
        return;
    }
  }

  function closeReader() {
    reader.closeReader();
  }

  /**
   * One column is a walk through the same three things the panes show side by
   * side: the feeds, the posts of one feed, and the article. Back therefore
   * steps exactly one of those at a time — article, then posts, then feeds — so
   * what you see happening matches where you land. Jumping straight from an
   * article to the feed list skips a screen you were just looking at, which
   * reads as the app losing your place.
   */
  const level = $derived(levelOf(reader.selectedId, onePosts));

  function stepBack(): void {
    switch (stepBackTarget(level)) {
      case "close-article":
        reader.closeReader();
        return;
      case "show-feeds":
        onePosts = false;
        return;
      case null:
        return;
    }
  }

  /** Home is the escape hatch: the feed list, in one press, from any depth. */
  function goHome(): void {
    if (mode === 1) reader.closeReader();
    showFeeds();
  }

  /** What the bar says you are looking at — one line, never wrapping. */
  const where = $derived(whereLabel(level, reader.activeTitle, reader.selected?.title ?? null));
  const backTo = $derived(backLabel(level, reader.activeTitle));

  /**
   * Swipe, for the phone layout: right is "out of here", left is "onward".
   *
   * Only horizontal-dominant, deliberate gestures count — a vertical flick is
   * the reader's own scrolling, and a short horizontal twitch is a mis-tap.
   */
  let swipeStart: { x: number; y: number; at: number } | null = null;

  function ontouchstart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }

  function ontouchend(event: TouchEvent): void {
    const start = swipeStart;
    swipeStart = null;
    if (start === null || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 64) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (Date.now() - start.at > 800) return;
    if (dx > 0) gestureBack();
    else gestureForward();
  }

  /** Right-swipe: one level out, the same step the back button takes. */
  function gestureBack(): void {
    stepBack();
  }

  /** Left-swipe: feeds → posts → the first post. */
  function gestureForward(): void {
    if (!onePosts) {
      onePosts = true;
      return;
    }
    if (reader.selectedId === null) void reader.enter();
  }

  /** The hamburger is the one-column way back to the feeds. */
  function showFeeds() {
    if (layout.mode === 1) onePosts = false;
    else layout.setMode(1);
  }
</script>

<div
  class="main"
  style={Object.entries(
    readingVars({
      textScale: reading.textScale,
      rowScale: reading.rowScale,
      leading: reading.leading,
      indent: reading.indentParagraphs,
      align: reading.textAlign,
      thumbScale: reading.thumbScale,
    }),
  )
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}
>
  <Header
    subtitle={account?.userName ?? session.email}
    controls={layoutSwitch}
    {onsignout}
    ontogglesidebar={showFeeds}
  />

  <!-- The seam under the bar doubles as the activity light. -->
  <LoadAura />

  <!-- Feedback for actions that land: hide, pin, lock, a finished sync. -->
  <FloodLayer />

  {#if reader.error}
    <div class="error" role="alert">
      <span>{reader.error}</span>
      <button onclick={() => reader.dismissError()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <div
    class="panes"
    class:reading={reader.selectedId !== null}
    class:one={mode === 1}
    bind:this={panes}
    style:grid-template-columns={layout.template}
  >
    {#if mode === 1}
      <!-- One column, walked through: feeds, then the posts of one feed, then
           the article. Left and the crumb go back a level. -->
      <!-- Two controls, always in the same two places: back one level, then
           home to the feeds. They never swap sides or move between levels, so
           the muscle memory survives the walk. -->
      <nav class="crumbs" aria-label="Location">
        <button
          class="step"
          onclick={stepBack}
          disabled={level === "feeds"}
          aria-label={backTo}
          title={backTo}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
        </button>
        <button
          class="step"
          onclick={goHome}
          disabled={level === "feeds"}
          aria-label="Feeds"
          title="Feeds"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"
            ><path d="M2.5 7.2 8 2.5l5.5 4.7V13a.6.6 0 0 1-.6.6H3.1a.6.6 0 0 1-.6-.6Z" /></svg
          >
        </button>
        <span class="where" title={where}>{where}</span>
      </nav>

      <!-- The one-pane surface owns the swipe gesture; it is a container, not a
           control, so there is no widget role to give it. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="single" {ontouchstart} {ontouchend}>
        {#if reader.selectedId !== null}
          <ReaderPane onClose={closeReader} />
        {:else if onePosts}
          <ArticleList />
        {:else}
          <Sidebar onNavigate={() => (onePosts = true)} />
        {/if}
      </div>
    {:else if mode === 2}
      <Sidebar onNavigate={() => (onePosts = true)} />
      <PaneGutter which="sidebar" />
      <!-- The second column is the posts column and becomes the article: the
           two-column behaviour, now chosen rather than inferred from width. -->
      {#if reader.selectedId !== null}
        <ReaderPane onClose={closeReader} />
      {:else}
        <ArticleList />
      {/if}
    {:else}
      <Sidebar onNavigate={() => (onePosts = true)} />
      <PaneGutter which="sidebar" />
      <ArticleList />
      <PaneGutter which="list" />
      <ReaderPane onClose={closeReader} />
    {/if}
  </div>

  {#if menu}
    <CategoryMenu
      x={menu.x}
      y={menu.y}
      model={menu.model}
      busy={reader.hiddenBusy || reader.favoritesBusy || reader.feedBusy}
      onselect={(action) => void reader.applyMenuAction(action)}
      onclose={() => reader.closeCategoryMenu()}
    />
  {/if}
</div>

{#snippet layoutSwitch()}
  <LayoutSwitch />
{/snippet}

<style>
  .main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .panes {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    /* Without an explicit capped row, the single auto row grows to the tallest
       pane's content and every child overflows the viewport. */
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .panes.one {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .panes > :global(*) {
    min-height: 0;
  }

  .single {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .single > :global(*) {
    flex: 1;
    min-height: 0;
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 34px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    flex: none;
  }

  /* Fixed-size, fixed-order controls: the pair keeps its geometry at every
     level, so pressing back never moves the thing you press next. */
  .step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
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

  .step:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .step:disabled {
    opacity: 0.32;
    cursor: default;
  }

  .where {
    min-width: 0;
    margin-left: 4px;
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

    .crumbs {
      height: 42px;
    }
  }

  .error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    font-size: 12.5px;
    color: #ffd9d9;
    background: #6b1d1d;
  }

  .error span {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .error button {
    border: 0;
    background: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
  }
</style>
