<script lang="ts">
  import { onMount, untrack } from "svelte";

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
  import { startAutoSync } from "../lib/auto-sync";
  import { startChangeWatch } from "../lib/watch-changes";
  import { transport } from "../api/transport";
  import { getRevision } from "../api/hardlyread";
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

  /** A launch load newer than this counts as the launch sync. */
  const AUTO_SYNC_LAUNCH_GRACE_MS = 30_000;

  /**
   * Automatic sync: starts when the setting says so and stops when it stops.
   *
   * The effect re-runs on the toggle and on the interval, so turning it on takes
   * effect now and changing the period restarts the timer at the new period —
   * neither needs a relaunch. `launch` is false when the launch load already
   * fetched everything, so a start does not spend the same five requests twice
   * in one second; when that load failed there is nothing recent to trust and
   * the first automatic sync runs at once.
   */
  /**
   * The website writes the same state this app reads, and there is no channel
   * to be told about it, so it is asked: a token every few seconds, and the
   * state re-read only when the token moves. That is what makes clicking an eye
   * or a pin on the website show up here on its own.
   */
  $effect(() => {
    const watch = startChangeWatch({
      read: () => getRevision(transport, session),
      // Only the extension state: that is what the website's buttons write, and
      // every visible consequence of it (which categories are pinned, hidden,
      // locked, indented) is derived from it. The feed list and unread counts
      // come from FreshRSS's crawler and do not move when a view changes, so
      // re-reading them here would be three requests to learn nothing.
      onChange: () => {
        void reader.loadApiState();
      },
      busy: () => reader.sync.active,
      visible: () => document.visibilityState === "visible",
    });
    // Coming back to the window is the moment a stale view is most obvious, so
    // it checks at once instead of waiting out the interval.
    const wake = () => {
      if (document.visibilityState === "visible") watch.kick();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      watch.stop();
    };
  });

  $effect(() => {
    const enabled = chrome.autoSync;
    const hours = chrome.autoSyncHours;
    const started = launched;
    if (!enabled || !started) return;
    // Everything the timer touches is read outside the effect's tracking:
    // a sync updates `reader.sync` and `lastSyncAt`, and taking those as
    // dependencies would tear the timer down and rebuild it after every sync —
    // resetting the period each time the user pressed sync themselves.
    const run = untrack(() =>
      startAutoSync({
        enabled: () => chrome.autoSync,
        hours: () => hours,
        sync: () => reader.refresh(),
        busy: () => reader.sync.active,
        launch: Date.now() - reader.lastSyncAt > AUTO_SYNC_LAUNCH_GRACE_MS,
      }),
    );
    return () => run.stop();
  });

  /**
   * One column has two levels, not three: the feed list (where a feed opens its
   * posts in place) and the article. There is no posts screen to step into, so
   * nothing tracks it.
   */
  let panes = $state<HTMLElement | null>(null);

  const mode = $derived(layout.mode);

  /**
   * Landing on one pane lands on the feeds.
   *
   * One column is a walk — feeds, then posts, then the article — and collapsing
   * into it with an article open used to leave that article alone on screen:
   * the second pane's content, on a surface whose first pane is the feeds. The
   * walk always starts from the top, whether the collapse came from the window
   * or from the switch.
   */
  let drawn = layout.mode;
  $effect(() => {
    const now = layout.mode;
    if (now === drawn) return;
    drawn = now;
    if (now === 1) reader.closeReader();
  });
  const menu = $derived.by(() => {
    const point = reader.menu;
    const model = reader.menuModel;
    return point === null || model === null ? null : { x: point.x, y: point.y, model };
  });

  /**
   * True once the launch load has finished, so automatic sync starts after the
   * first paint rather than racing it.
   */
  let launched = $state(false);

  onMount(() => {
    chrome.load();
    reading.load();
    void reader.start(session).finally(() => (launched = true));

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
        // Up/Down belong to the pane you are in: with a post on screen they walk
        // the posts, and with the feed list in hand they walk the feeds, which is
        // what they have always done here. Same list, same order as the view on
        // screen, so the step lands on something you can see.
        if (reader.selectedId !== null) {
          void reader.stepItem(intent.delta);
          return;
        }
        void reader.stepStream(intent.delta);
        return;
      case "first":
        event.preventDefault();
        void reader.firstStream();
        return;
      case "last":
        event.preventDefault();
        void reader.lastStream();
        return;
      case "enter":
        event.preventDefault();
        void reader.enter();
        return;
      case "back":
        event.preventDefault();
        // Out of the article. In one column that is the feed list again, with
        // the feed you were reading still open where you left it.
        if (reader.back()) return;
        // Nothing open: Left still means "one column to the left", so the panes
        // give one up instead of the key doing nothing. The window is not asked
        // to shrink here — that belongs to the 1/2/3 buttons, and a key that
        // resizes the window would be a surprise you cannot undo with a key.
        layout.collapseOne();
        return;
      case "escape":
        if (reader.menu !== null) {
          event.preventDefault();
          reader.closeCategoryMenu();
          return;
        }
        if (reader.back()) event.preventDefault();
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
  const level = $derived(levelOf(reader.selectedId));

  function stepBack(): void {
    if (stepBackTarget(level) === "close-article") reader.closeReader();
  }

  /**
   * The article's own lock: home first, then the curtain.
   *
   * The jump is a local view change, so it happens immediately; the lock is a
   * write and catches up. Waiting for the server before moving would put the
   * network between the finger and the screen — the one thing the curtain is
   * for is getting away now.
   */
  function lockFromArticle(): void {
    goHome();
    void reader.lockHidden();
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

  /** Left-swipe: onward, into the first post of what is open. */
  function gestureForward(): void {
    if (reader.selectedId === null) void reader.enter();
  }

  /** The hamburger is the one-column way back to the feeds. */
  function showFeeds() {
    if (layout.mode === 1) reader.closeReader();
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
      align: reading.textAlign,
      thumbScale: reading.thumbScale,
    }),
  )
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}
>
  <Header
    subtitle={account?.userName ?? session.email}
    server={session.serverUrl}
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
          <ReaderPane onClose={closeReader} onLock={lockFromArticle} />
        {:else}
          <Sidebar inlinePosts />
        {/if}
      </div>
    {:else if mode === 2}
      {#if !layout.collapsed}
        <Sidebar />
        <PaneGutter which="sidebar" />
      {/if}
      <!-- The second column is the posts column and becomes the article: the
           two-column behaviour, now chosen rather than inferred from width. -->
      {#if reader.selectedId !== null}
        <ReaderPane onClose={closeReader} />
      {:else}
        <ArticleList />
      {/if}
    {:else}
      {#if !layout.collapsed}
        <Sidebar />
        <PaneGutter which="sidebar" />
      {/if}
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
  <!-- Fold the feeds pane away. It lives beside the pane switch because both
       answer "what do I want on screen", and it is drawn only where there is a
       sidebar to fold: one column has nothing to collapse. -->
  {#if mode === 3}
    <button
      class="fold"
      class:on={layout.collapsed}
      aria-pressed={layout.collapsed}
      aria-label={layout.collapsed ? "Show the feeds pane" : "Collapse the feeds pane"}
      title={layout.collapsed ? "Show the feeds pane" : "Collapse the feeds pane"}
      onclick={() => layout.toggleSidebar()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {#if layout.collapsed}
          <path d="M6 3.5 10.5 8 6 12.5" />
        {:else}
          <path d="M10 3.5 5.5 8 10 12.5" />
        {/if}
      </svg>
    </button>
  {/if}
  <!-- No pane-count switch where there is one column: the buttons could only
       report a choice the screen cannot honour. -->
  {#if layout.caps.paneCount}
    <LayoutSwitch />
  {/if}
{/snippet}

<style>
  /* The fold toggle: the same quiet weight as the pane switch beside it. */
  .fold {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--edge-soft);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    transition: color 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;
  }

  .fold svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .fold:hover {
    color: var(--text);
    background: var(--hover);
  }

  .fold.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 50%, var(--edge-soft));
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    /* clip, not hidden: hidden would make this a scroll container and take the
       scrolling away from the panes inside it. */
    overflow-x: clip;
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
    border-bottom: 1px solid var(--edge);
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
