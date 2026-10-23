<script lang="ts">
  import { onMount } from "svelte";

  import type { Session, UserInfo } from "../api/freshrss";
  import ArticleList from "../components/ArticleList.svelte";
  import CategoryMenu from "../components/CategoryMenu.svelte";
  import Header from "../components/Header.svelte";
  import LayoutSwitch from "../components/LayoutSwitch.svelte";
  import PaneGutter from "../components/PaneGutter.svelte";
  import ReaderPane from "../components/ReaderPane.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { isTypingTarget, resolveKey, resolveShiftKey } from "../lib/keys";
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
   * Back to the feed before this one.
   *
   * In one column the sidebar is off screen, so the feed you came from is not
   * visible to tap. This closes any article and steps back through the stream
   * history; with no history it is disabled rather than pretending.
   */
  async function backToFeed(): Promise<void> {
    if (!reader.canGoBackToStream) return;
    reader.closeReader();
    await reader.previousStream();
  }

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

  /** Right-swipe: article → posts → previous feed → feeds. */
  function gestureBack(): void {
    if (reader.selectedId !== null) {
      reader.back();
      return;
    }
    if (reader.canGoBackToStream) {
      void reader.previousStream();
      return;
    }
    if (onePosts) onePosts = false;
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

<div class="main">
  <Header
    subtitle={account?.userName ?? session.email}
    controls={layoutSwitch}
    {onsignout}
    ontogglesidebar={showFeeds}
  />

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
      <nav class="crumbs" aria-label="Location">
        <button
          class="crumb back"
          onclick={() => void backToFeed()}
          disabled={!reader.canGoBackToStream}
          aria-label={reader.canGoBackToStream
            ? `Back to ${reader.previousStreamTitle ?? "the previous feed"}`
            : "No previous feed"}
          title={reader.canGoBackToStream
            ? `Back to ${reader.previousStreamTitle ?? "the previous feed"}`
            : "No previous feed"}
        >←</button>
        <span class="sep" aria-hidden="true"></span>
        <button class="crumb" onclick={() => (onePosts = false)} disabled={!onePosts && reader.selectedId === null}>
          Feeds
        </button>
        {#if onePosts || reader.selectedId !== null}
          <span aria-hidden="true">›</span>
          <button class="crumb" onclick={() => reader.closeReader()} disabled={reader.selectedId === null}>
            {reader.activeTitle}
          </button>
        {/if}
        {#if reader.selectedId !== null}
          <span aria-hidden="true">›</span>
          <span class="here">{reader.selected?.title ?? "Article"}</span>
        {/if}
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
      onindent={(px) => reader.setSidebarIndentPx(px)}
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
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
  }

  .crumb {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .crumb:hover:not(:disabled) {
    color: var(--text);
  }

  .crumb:disabled {
    color: var(--muted);
    cursor: default;
  }

  .here {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
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
