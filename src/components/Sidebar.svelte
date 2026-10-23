<script lang="ts">
  import SidebarBand from "./SidebarBand.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { READING_LIST, STATE_STARRED, type Subscription } from "../api/freshrss";
  import {
    LongPressTracker,
    anchorForRect,
    armsLongPress,
    isMenuKey,
  } from "../lib/contextmenu";
  import { feedHue, feedIconSrc, feedInitial } from "../lib/feedicon";
  import { chrome } from "../state/chrome.svelte";
  import { reader, type CategoryGroup } from "../state/reader.svelte";
  import { MARKER_PATH, pinWords } from "../lib/theme";
  import { searchFeeds } from "../lib/search";
  import { search } from "../state/search.svelte";
  import { theme } from "../state/theme.svelte";

  const words = $derived(pinWords(theme.current.vocabulary));

  /** Something typed: the sidebar shows results instead of the tree. */
  const searching = $derived(search.query.trim() !== "");

  /**
   * Matches, best first. Names always; post text only when the toggle is on and
   * the text has been extracted, which is why the index is passed as null
   * otherwise rather than being searched and found empty.
   */
  const hits = $derived(
    searchFeeds(
      search.query,
      reader.categories.map((category) => ({ label: category.label, feeds: category.feeds })),
      search.deep ? search.index : null,
    ),
  );

  const categoryOf = $derived(
    new Map(
      reader.categories.flatMap((category) =>
        category.feeds.map((feed) => [feed.id, category.label] as const),
      ),
    ),
  );

  function submitSearch(event: KeyboardEvent) {
    if (event.key === "Escape") search.clear();
  }

  function toggleDeep() {
    void search.setDeep(!search.deep, reader.subscriptions, reader.session);
  }

  let { onNavigate }: { onNavigate?: () => void } = $props();


  /** The add-feed form: closed until asked for, so the sidebar stays a list. */
  let adding = $state(false);
  let feedUrl = $state("");

  /**
   * Feed ids whose icon failed to load. A dead icon falls back to the letter
   * tile instead of leaving a broken-image gap in the list.
   */
  let brokenIcons = $state<Record<string, boolean>>({});

  function iconFor(feed: Subscription): string | undefined {
    return feedIconSrc(feed.iconUrl, reader.session?.serverUrl ?? "");
  }

  /**
   * Set when a long press has opened the menu, so the click that the browser
   * still sends on lift does not also open the category stream.
   */
  let swallowClick = false;
  let press: LongPressTracker | null = null;

  function toggle(id: string) {
    reader.toggleCategory(id);
  }

  async function open(streamId: string, title: string) {
    await reader.openStream(streamId, title);
    onNavigate?.();
  }

  function openCategory(category: CategoryGroup) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    void open(category.id, category.label);
  }

  function openFeed(feed: Subscription) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    void open(feed.id, feed.title);
  }


  /**
   * Right-click. A category row needs the extension: without it there is
   * nothing to offer, so the native menu is left alone rather than replaced by
   * a dead one. A feed row always has removal to offer.
   */
  function onCategoryContextMenu(event: MouseEvent, category: CategoryGroup) {
    event.preventDefault();
    reader.openCategoryMenu(category.label, { x: event.clientX, y: event.clientY });
  }

  function onFeedContextMenu(event: MouseEvent, feed: Subscription) {
    event.preventDefault();
    reader.openFeedMenu({ id: feed.id, title: feed.title }, { x: event.clientX, y: event.clientY });
  }

  /** Shift+F10 and the context-menu key: same menu, anchored to the row. */
  function onCategoryKeydown(event: KeyboardEvent, category: CategoryGroup) {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    const anchor = anchorForRect((event.currentTarget as HTMLElement).getBoundingClientRect());
    reader.openCategoryMenu(category.label, anchor);
  }

  function onFeedKeydown(event: KeyboardEvent, feed: Subscription) {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    const anchor = anchorForRect((event.currentTarget as HTMLElement).getBoundingClientRect());
    reader.openFeedMenu({ id: feed.id, title: feed.title }, anchor);
  }

  /** Arms a long press for whichever row the pointer went down on. */
  function armPress(event: PointerEvent, openMenu: (point: { x: number; y: number }) => void) {
    if (!armsLongPress(event.pointerType)) return;
    swallowClick = false;
    press?.cancel();
    press = new LongPressTracker((point) => {
      swallowClick = true;
      openMenu(point);
    });
    press.start({
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function onCategoryPointerDown(event: PointerEvent, category: CategoryGroup) {
    armPress(event, (point) => reader.openCategoryMenu(category.label, point));
  }

  function onFeedPointerDown(event: PointerEvent, feed: Subscription) {
    armPress(event, (point) => reader.openFeedMenu({ id: feed.id, title: feed.title }, point));
  }

  function onPointerMove(event: PointerEvent) {
    press?.move({
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function cancelPress() {
    press?.cancel();
  }

  function startAdding() {
    adding = true;
    reader.clearAddFeedError();
  }

  function cancelAdding() {
    adding = false;
    feedUrl = "";
    reader.clearAddFeedError();
  }

  async function submitFeed(event: SubmitEvent) {
    event.preventDefault();
    const added = await reader.addFeed(feedUrl);
    if (added) cancelAdding();
  }
</script>

<nav class="sidebar" aria-label="Feeds" style="--feed-indent: {reader.sidebarIndent.px}px">
  <!-- One field, filtering as you type: no submit button, no separate mode
       button beside it. The paragraph mark inside the field is the "also search
       post text" switch, kept quiet until it is wanted. It sits above the band
       because it filters the whole tree below it. -->
  <div class="find">
    <svg class="glass" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4L14 14" />
    </svg>
    <input
      type="search"
      class="find-input"
      placeholder="Search feeds"
      aria-label="Search feeds"
      autocomplete="off"
      spellcheck="false"
      value={search.query}
      oninput={(event) => search.setQuery(event.currentTarget.value)}
      onkeydown={submitSearch}
    />
    {#if searching}
      <button class="find-clear" aria-label="Clear search" title="Clear search (Esc)" onclick={() => search.clear()}>×</button>
    {/if}
    <button
      class="find-deep"
      class:on={search.deep}
      aria-pressed={search.deep}
      aria-label="Also search text inside posts"
      title={search.deep
        ? "Matching names and post text — click for names only"
        : "Matching feed and category names — click to also search text inside posts"}
      onclick={toggleDeep}
    >¶</button>
  </div>

  <SidebarBand />

  {#if search.deep}
    <p class="find-note">
      {#if search.progress}
        Reading posts {search.progress.done}/{search.progress.total}…
      {:else}
        {search.indexedCount()} feeds searchable by text
      {/if}
    </p>
  {/if}

  <!-- Feed indent: the extension's own setting, not a lookalike. Disabled
       rather than hidden when the extension is absent, so the reason is
       visible instead of the control silently doing nothing. -->
  <div class="indent" class:open={chrome.indentOpen}>
    <button
      class="indent-label"
      aria-expanded={chrome.indentOpen}
      aria-controls="feed-indent-row"
      title={chrome.indentOpen ? "Hide the indent slider" : "Show the indent slider"}
      onclick={() => chrome.toggleIndentOpen()}
    >
      Indent
      <span class="px">{reader.sidebarIndent.px}</span>
      <svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10.5l4-4" /></svg>
    </button>
    {#if chrome.indentOpen}
      <input
        id="feed-indent-row"
        type="range"
        min="0"
        max={reader.sidebarIndent.max}
        step="1"
        value={reader.sidebarIndent.px}
        disabled={!reader.sidebarIndent.available}
        aria-label="Feed name indent"
        title={reader.indentError ??
          (reader.sidebarIndent.available
            ? "Feed name indent, shared with the Sidebar Feed Indent extension"
            : "Sidebar Feed Indent is not enabled on this server")}
        oninput={(event) => reader.setSidebarIndentPx(Number(event.currentTarget.value))}
      />
    {/if}
    <span class="right"><ThemeToggle /></span>
  </div>

  {#if searching}
    <div class="section">
      {#if hits.length === 0}
        <p class="empty">
          No feed matches “{search.query}”.{#if !search.deep} Names only — ¶ also searches inside posts.{/if}
        </p>
      {:else}
        {#each hits as hit (hit.feed.id)}
          <button
            class="row feed hit"
            class:active={reader.activeStream === hit.feed.id}
            onclick={() => open(hit.feed.id, hit.feed.title)}
          >
            <span class="label">{hit.feed.title}</span>
            {#if hit.via === "category"}
              <span class="why">in {categoryOf.get(hit.feed.id) ?? "category"}</span>
            {:else if hit.via === "text" && hit.postTitle}
              <span class="why">“{hit.postTitle}”</span>
            {/if}
            <span class="count">{reader.countFor(hit.feed.id)}</span>
          </button>
        {/each}
      {/if}
    </div>

    {#if search.deep && search.indexedCount() === 0 && hits.length > 0}
      <p class="find-note">No post text indexed yet — feed names still match.</p>
    {/if}
  {:else}
  <div class="section">
    <button
      class="row strong"
      class:active={reader.activeStream === READING_LIST}
      onclick={() => open(READING_LIST, "Reading list")}
    >
      <span class="label">Reading list</span>
      <span class="count">{reader.countFor(READING_LIST)}</span>
    </button>
    <button
      class="row strong"
      class:active={reader.activeStream === STATE_STARRED}
      onclick={() => open(STATE_STARRED, "Starred")}
    >
      <span class="label">Starred</span>
      <span class="count">{reader.countFor(STATE_STARRED)}</span>
    </button>
  </div>

  {#each reader.categories as category (category.id)}
    {@const pinned = reader.isCategoryPinned(category.label)}
    {@const hiddenCat = reader.isCategoryHidden(category.label)}
    {@const folded = reader.isCategoryCollapsed(category.id)}
    <div class="section">
      <div class="group">
        <button
          class="row group-title"
          class:active={reader.activeStream === category.id}
          class:pinned
          class:is-hidden={hiddenCat}
          onclick={() => toggle(category.id)}
          aria-expanded={!folded}
          aria-label={folded ? `Expand ${category.label}` : `Collapse ${category.label}`}
          onpointerenter={() => reader.prefetchStream(category.id)}
          onfocus={() => reader.prefetchStream(category.id)}
          oncontextmenu={(event) => onCategoryContextMenu(event, category)}
          onkeydown={(event) => onCategoryKeydown(event, category)}
          onpointerdown={(event) => onCategoryPointerDown(event, category)}
          onpointermove={onPointerMove}
          onpointerup={cancelPress}
          onpointercancel={cancelPress}
          onpointerleave={cancelPress}
          aria-haspopup="menu"
        >
          <!-- The same caret the sidebar's own control strip uses: one glyph,
               one meaning. Pointing down it will unfold, pointing up it will
               fold — the arrow always describes the click. -->
          <svg class="fold" class:up={!folded} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
          {#if pinned}
            <svg
              class="pin"
              class:star={theme.current.marker === "star"}
              viewBox="0 0 24 24"
              role="img"
              aria-label={words.count}
            >
              <path d={MARKER_PATH[theme.current.marker]} />
            </svg>
          {/if}
          <span class="label">{category.label}</span>
        </button>
        <button
          class="open"
          onclick={() => openCategory(category)}
          title={`Open posts in ${category.label}`}
          aria-label={`Open posts in ${category.label}`}
        >
          <span class="count">{reader.countFor(category.id)}</span>
        </button>
      </div>

      {#if !folded}
        {#each category.feeds as feed (feed.id)}
          <button
            class="row feed"
            class:active={reader.activeStream === feed.id}
            class:pinned={reader.isFeedPinned(feed.id)}
            onclick={() => openFeed(feed)}
            onpointerenter={() => reader.prefetchStream(feed.id)}
            onfocus={() => reader.prefetchStream(feed.id)}
            oncontextmenu={(event) => onFeedContextMenu(event, feed)}
            onkeydown={(event) => onFeedKeydown(event, feed)}
            onpointerdown={(event) => onFeedPointerDown(event, feed)}
            onpointermove={onPointerMove}
            onpointerup={cancelPress}
            onpointercancel={cancelPress}
            onpointerleave={cancelPress}
            aria-haspopup="menu"
            title={feed.title}
          >
            {#if reader.isFeedPinned(feed.id)}
              <svg
                class="pin"
                class:star={theme.current.marker === "star"}
                viewBox="0 0 24 24"
                role="img"
                aria-label={words.count}
              >
                <path d={MARKER_PATH[theme.current.marker]} />
              </svg>
            {/if}
            {#if iconFor(feed) !== undefined && !brokenIcons[feed.id]}
              <img
                class="icon"
                src={iconFor(feed)}
                alt=""
                loading="lazy"
                decoding="async"
                onerror={() => (brokenIcons = { ...brokenIcons, [feed.id]: true })}
              />
            {:else}
              <span class="icon letter" style="--hue: {feedHue(feed.title)}" aria-hidden="true"
                >{feedInitial(feed.title)}</span
              >
            {/if}
            <span class="label">{feed.title}</span>
            {#if reader.countFor(feed.id) > 0}
              <span class="count">{reader.countFor(feed.id)}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/each}
  {/if}

  {#if reader.subscriptions.length === 0 && !reader.loadingList}
    <p class="empty">No feeds yet.</p>
  {/if}

  <div class="status" aria-live="polite">
    {#if reader.hiddenAvailable && !reader.hiddenLocked && reader.hiddenCount > 0}
      <span class="stat">Hidden <b>{reader.hiddenCount}</b></span>
      {#if reader.hiddenCategories.mode === "strict"}<span class="badge">Enforced</span>{/if}
    {/if}
    {#if reader.pinnedCount > 0}
      <span class="stat">{words.count} <b>{reader.pinnedCount}</b></span>
    {/if}
  </div>

  <div class="add">
    {#if adding}
      <form onsubmit={submitFeed}>
        <label class="visually-hidden" for="feed-url">Feed URL</label>
        <input
          id="feed-url"
          type="url"
          class="url"
          placeholder="https://example.com/feed.xml"
          bind:value={feedUrl}
          disabled={reader.feedBusy}
          autocomplete="off"
        />
        <div class="add-actions">
          <button type="submit" class="submit" disabled={reader.feedBusy}>
            {reader.feedBusy ? "Adding…" : "Add"}
          </button>
          <button type="button" class="cancel" onclick={cancelAdding} disabled={reader.feedBusy}>
            Cancel
          </button>
        </div>
        {#if reader.addFeedError}
          <p class="add-error" role="alert">{reader.addFeedError}</p>
        {/if}
      </form>
    {:else}
      <button class="add-open" onclick={startAdding}>+ Add feed</button>
    {/if}
  </div>
</nav>

<style>
  .pin {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    opacity: 0.9;
  }

  /* The pin is an open stroke drawing, the star a closed shape: the same slot
     needs opposite fill/stroke so neither reads as the outline of the other. */
  .pin path {
    fill: none;
    stroke: var(--tone-favourite);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .pin.star path {
    fill: var(--tone-favourite);
    stroke: none;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin: 14px 16px 0;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-dim);
  }

  .status:empty {
    display: none;
  }

  .stat b {
    color: var(--text);
    font-weight: 600;
  }

  .badge {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--hover);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .sidebar {
    height: 100%;
    overflow-y: auto;
    padding: 8px 0 24px;
    background: var(--surface);
    border-right: 1px solid var(--border);
  }

  .section + .section {
    margin-top: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 12px 7px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--hover);
  }

  .row.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .row.strong .label {
    font-weight: 600;
  }

  /* The row and the count sit side by side: the row is the fold, the count
     opens the category's posts. Whole-row tap, nothing lost. */
  .group {
    position: relative;
    display: flex;
    align-items: stretch;
  }

  .group-title {
    flex: 1;
    min-width: 0;
    width: auto;
    padding-left: 8px;
    padding-right: 6px;
  }

  .group-title .label {
    font-weight: 600;
    text-transform: none;
  }

  /* Pinned: the title takes the logo's blue, the row keeps a blue outline, a
     soft outer glow and an underlight along the bottom edge. Three quiet cues
     rather than one loud one, so a pinned row is obvious without shouting. */
  .group-title.pinned,
  .feed.pinned {
    outline: 1px solid color-mix(in srgb, var(--tone-favourite) 45%, transparent);
    outline-offset: -1px;
    border-radius: 5px;
    box-shadow:
      inset 0 -2px 0 color-mix(in srgb, var(--tone-favourite) 60%, transparent),
      0 0 9px color-mix(in srgb, var(--tone-favourite) 18%, transparent);
  }

  .group-title.pinned .label,
  .feed.pinned .label {
    color: color-mix(in srgb, var(--tone-favourite) 70%, var(--text));
  }

  /* Hidden: red, the same red as the band's hidden control. Only ever visible
     in the revealed/only views, where the point is to show what is hidden. */
  .group-title.is-hidden .label {
    color: var(--tone-hidden);
  }

  .group-title.is-hidden .fold {
    color: var(--tone-hidden);
  }

  .pin {
    flex: 0 0 auto;
    width: 11px;
    height: 11px;
    fill: none;
    stroke: var(--tone-favourite);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .feed.pinned .label {
    color: color-mix(in srgb, var(--tone-favourite) 65%, var(--text-dim));
  }

  /* The control strip's caret, a size up so it reads at a glance in a dense
     tree, and drawn as a stroke rather than a font glyph so it looks the same
     everywhere. Down means a click unfolds, up means a click folds. */
  .fold {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--muted);
    transition: transform 0.15s ease;
  }

  .fold.up {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .fold {
      transition: none;
    }
  }

  /* The count is its own target: the row folds, the number opens the category's
     posts, so folding takes the whole row without losing the other action. */
  .open {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex: none;
    min-width: 34px;
    padding: 0 10px 0 4px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }

  .open:hover {
    color: var(--text);
    background: var(--hover);
  }

  .open .count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  /* Feed rows take the server's indent on top of the base inset; category rows
     do not, because that is the hierarchy the indent exists to express. */
  .feed {
    padding-left: calc(34px + var(--feed-indent, 12px));
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .feed.active {
    color: var(--accent-text);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Search sits at the top of the sidebar, above the hidden/favourites band: it
     filters the whole tree below it, band included, so it belongs first. One quiet field — the magnifier and
     the mode mark live inside it, so there is no button beside the input. */
  .find {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 12px 4px;
    padding: 0 6px 0 9px;
    height: 30px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--bg);
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .find:hover {
    border-color: var(--border);
  }

  .find:focus-within {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 13%, transparent);
  }

  .glass {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.6;
    stroke-linecap: round;
    transition: stroke 120ms ease;
  }

  .find:focus-within .glass {
    stroke: var(--accent);
  }

  .find-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
    appearance: none;
  }

  .find-input::placeholder {
    color: var(--muted);
  }

  /* The browser's own clear affordance is a grey blob at a different size in
     every engine; the field draws its own. */
  .find-input::-webkit-search-cancel-button,
  .find-input::-webkit-search-decoration {
    appearance: none;
    display: none;
  }

  .find-clear,
  .find-deep {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }

  .find-clear {
    font-size: 14px;
  }

  .find-clear:hover,
  .find-deep:hover {
    color: var(--text);
    background: var(--hover);
  }

  /* Quiet until wanted: the mode mark is dim in an idle field and states itself
     only when it is on. */
  .find-deep {
    font-size: 11.5px;
    opacity: 0.5;
  }

  .find:hover .find-deep,
  .find:focus-within .find-deep {
    opacity: 0.8;
  }

  .find-deep.on {
    opacity: 1;
    color: var(--accent-text);
    background: var(--accent-soft);
  }

  .find-note {
    margin: 0;
    padding: 0 16px 6px;
    font-size: 10.5px;
    color: var(--muted);
  }

  .hit .why {
    flex: 0 1 auto;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--muted);
  }

  .empty {
    margin: 0;
    padding: 8px 16px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--muted);
  }

  .indent {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 1px 12px 6px 16px;
    font-size: 11px;
    color: var(--muted);
  }

  /* The label is the control: one click shows or hides the slider, and the
     number is always readable while it is hidden. */
  .indent-label {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 5px;
    padding: 1px 3px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: 0.02em;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .indent-label:hover {
    background: var(--hover);
    color: var(--text);
  }

  .indent-label:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .indent .px {
    min-width: 1.2rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }

  .caret {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 120ms ease;
  }

  .indent.open .caret {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      transition: none;
    }
  }

  .right {
    margin-left: auto;
    display: inline-flex;
  }

  /* A 2px track and a 9px thumb: the native 14px trough was the loudest thing
     in the sidebar for a setting that is set once. */
  .indent input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    height: 12px;
    margin: 0;
    padding: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .indent input[type="range"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .indent input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 1px;
    background: var(--border);
  }

  .indent input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 9px;
    height: 9px;
    margin-top: -3.5px;
    border: 0;
    border-radius: 50%;
    background: var(--muted);
  }

  .indent input[type="range"]:hover::-webkit-slider-thumb,
  .indent input[type="range"]:focus-visible::-webkit-slider-thumb {
    background: var(--accent);
  }

  .indent input[type="range"]::-moz-range-track {
    height: 2px;
    border-radius: 1px;
    background: var(--border);
  }

  .indent input[type="range"]::-moz-range-thumb {
    width: 9px;
    height: 9px;
    border: 0;
    border-radius: 50%;
    background: var(--muted);
  }

  .indent input[type="range"]:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .empty {
    padding: 12px 16px;
    font-size: 12px;
    color: var(--muted);
  }

  .add {
    padding: 14px 12px 0;
  }

  .add-open {
    width: 100%;
    padding: 6px 8px;
    border: 1px dashed var(--border);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .add-open:hover {
    background: var(--hover);
    color: var(--text);
  }

  .url {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .add-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .submit,
  .cancel {
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .submit:hover:not(:disabled),
  .cancel:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .submit:disabled,
  .cancel:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .add-error {
    margin: 6px 0 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: #d9534f;
    overflow-wrap: anywhere;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Feed icons: cached image when FreshRSS has one, deterministic letter tile
     otherwise, so no row is ever a broken image. */
  .icon {
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    object-fit: contain;
  }

  .icon.letter {
    display: grid;
    place-items: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    background: hsl(var(--hue) 32% 26%);
    color: hsl(var(--hue) 45% 82%);
  }
</style>
