<script lang="ts">
  import SidebarBand from "./SidebarBand.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { READING_LIST, STATE_STARRED, isRead, type StreamItem, type Subscription } from "../api/freshrss";
  import {
    LongPressTracker,
    anchorForRect,
    armsLongPress,
    isMenuKey,
  } from "../lib/contextmenu";
  import { parseFeedUrls } from "../lib/add-feeds";
  import { buildOpml, opmlFileName, parseOpml } from "../lib/opml";
  import { feedHue, feedIconSrc, feedInitial } from "../lib/feedicon";
  import { relativeTime } from "../lib/format";
  import { pullDown } from "../lib/pull";
  import { thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { reading } from "../state/reading.svelte";
  import { reader, type CategoryGroup } from "../state/reader.svelte";
  import { MARKER_PATH, pinWords } from "../lib/theme";
  import { groupHits, searchFeeds } from "../lib/search";
  import { search } from "../state/search.svelte";
  import { theme } from "../state/theme.svelte";
  import { chrome } from "../state/chrome.svelte";

  let wasLocked = false;

  /**
   * A lock folds the band.
   *
   * Folding when the curtain goes down is the private choice: a locked band that
   * is still open is a row of controls about hidden things, even if the controls
   * are only "Unlock". Only the transition does this, so opening the band while
   * locked is allowed to stay open — a later refresh that still reports "locked"
   * must not slam it shut again. The stored preference is untouched: unlocking
   * returns to the fold state the user actually chose.
   */
  $effect(() => {
    const locked = reader.hiddenLocked;
    if (locked === wasLocked) return;
    wasLocked = locked;
    if (locked) chrome.collapseBandForLock();
    else chrome.restoreBand();
  });

  const words = pinWords();

  /** Something typed: the sidebar shows results instead of the tree. */
  const searching = $derived(search.query.trim() !== "");

  /**
   * Matches, best first. Names always; post text only when the toggle is on and
   * the text has been extracted, which is why the index is passed as null
   * otherwise rather than being searched and found empty.
   */
  const groups = $derived(
    reader.categories.map((category) => ({
      id: category.id,
      label: category.label,
      feeds: category.feeds,
    })),
  );

  const hits = $derived(
    searchFeeds(search.query, groups, search.deep ? search.index : null),
  );

  /** The same hits under the categories they live in. */
  const hitGroups = $derived(groupHits(search.query, hits, groups));

  function submitSearch(event: KeyboardEvent) {
    if (event.key === "Escape") search.clear();
  }

  function toggleDeep() {
    void search.setDeep(!search.deep, reader.subscriptions, reader.session);
  }

  /**
   * `inlinePosts` is the one-panel layout: there is no posts column to step
   * into, so a feed opens under itself and the reader is the only thing that
   * replaces the sidebar.
   */
  let { inlinePosts = false }: { inlinePosts?: boolean } = $props();

  /**
   * The feed whose posts are showing underneath it. One at a time, and kept in
   * the store: the sidebar is a list where you look at one feed's posts, not a
   * tree of every post you have ever had open, and the reader takes this panel
   * away entirely while an article is open.
   */
  const expandedFeed = $derived(reader.expandedFeedId);


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
   * One panel: the feed unfolds where it sits. Opening its stream is what
   * fetches the posts — the same request the posts column would have made — but
   * the sidebar stays put, so nothing slides out from under the finger.
   */
  async function toggleFeed(feed: Subscription) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (expandedFeed === feed.id) {
      reader.setExpandedFeed(null);
      return;
    }
    reader.setExpandedFeed(feed.id);
    await reader.openStream(feed.id, feed.title);
  }

  /**
   * From a search hit, in one panel: the results are the list, so choosing one
   * has to leave the search and put the feed in front of you, unfolded — the
   * post-inside-a-post case (text matches) lands on the feed that holds it.
   */
  function jumpTo(feed: Subscription) {
    search.clear();
    const category = reader.categories.find((group) =>
      group.feeds.some((child) => child.id === feed.id),
    );
    if (category !== undefined && reader.isCategoryCollapsed(category.id)) {
      reader.toggleCategory(category.id);
    }
    void toggleFeed(feed);
  }

  /**
   * The same picture the posts column would have shown, worked out once per
   * post. Nothing is fetched here — `thumbnailOf` only decides a URL from what
   * the feed already sent — so an unfolded feed costs no extra requests.
   */
  const thumbnails = new WeakMap<StreamItem, string | null>();

  function thumbnail(item: StreamItem): string | null {
    const known = thumbnails.get(item);
    if (known !== undefined) return known;
    const found = thumbnailOf(item as ThumbSource).url;
    thumbnails.set(item, found);
    return found;
  }

  /** A hotlinked picture that fails is dropped, not left as a broken box. */
  let brokenThumbs = $state<string[]>([]);

  function thumbFailed(id: string) {
    brokenThumbs = [...brokenThumbs, id];
  }

  /**
   * Pulling the list down asks for news.
   *
   * With a feed open that means that feed; with nothing open there is no "that
   * feed", so it is the whole account — the same thing the sync button does.
   */
  function pullRefresh(): void {
    if (reader.activeStream !== "") void reader.reloadStream({ force: true });
    else void reader.refresh();
  }

  /** A post under an open feed: the reader is the one thing that takes over. */
  function openPost(item: StreamItem) {
    reader.select(item);
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

  /**
   * The add field grows only when it has something to hold.
   *
   * A one-line field is what adding a feed usually is; a textarea that is always
   * four rows tall would turn the commonest case into a form. It becomes a box
   * when there is a second line in it, and stays one line otherwise.
   */
  let feedBox = $state<HTMLTextAreaElement | null>(null);
  const feedLines = $derived(parseFeedUrls(feedUrl).length);

  function fitFeedBox(): void {
    if (feedBox === null) return;
    feedBox.style.height = "auto";
    const needed = Math.min(feedBox.scrollHeight, 128);
    feedBox.style.height = `${needed}px`;
  }

  $effect(() => {
    feedUrl;
    fitFeedBox();
  });

  /**
   * Enter adds when there is one feed in the box, and starts a new line when
   * there are several — so a list can be typed as well as pasted. Shift+Enter
   * always opens a line, which is the way in for the first extra feed.
   */
  function onFeedKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey || feedUrl.includes("\n")) return;
    event.preventDefault();
    void submitFeed();
  }

  async function submitFeed(event?: SubmitEvent) {
    event?.preventDefault();
    const result = await reader.addFeeds(feedUrl);
    // Kept open when anything failed: the failures are in the message, and the
    // text is still there to correct rather than retype.
    if (result.added.length > 0 && result.failed.length === 0) cancelAdding();
  }

  /**
   * OPML, both ways, under the add field.
   *
   * Import reads the file in the browser and subscribes through the same queue
   * the pasted list uses, folder names included, so a move from another reader
   * does not arrive as one undifferentiated pile. Export writes what this
   * account actually has, folders and all, and says so on the same line — the
   * name of the file in play is always on screen, so it is clear whether the
   * last file came in or went out.
   */
  let opmlName = $state<string | null>(null);
  let opmlNote = $state<string | null>(null);

  async function pickOpml(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    opmlName = file.name;
    opmlNote = null;
    try {
      const feeds = parseOpml(await file.text());
      const result = await reader.importOpml(feeds);
      const folders = new Set(feeds.map((feed) => feed.category).filter((name) => name !== undefined));
      if (result.failed.length === 0) {
        opmlNote = `Imported ${result.added.length} feed${result.added.length === 1 ? "" : "s"}${
          folders.size > 0 ? ` into ${folders.size} folder${folders.size === 1 ? "" : "s"}` : ""
        }.`;
      } else {
        opmlNote = `Imported ${result.added.length}, ${result.failed.length} failed — ${result.failed[0]?.error ?? ""}`;
      }
    } catch (error) {
      opmlNote = error instanceof Error ? error.message : String(error);
    } finally {
      // So choosing the same file twice runs again instead of doing nothing.
      input.value = "";
    }
  }

  /**
   * Writes the feed list out as OPML.
   *
   * The download is the anchor-and-blob kind every browser understands. The
   * native Linux window is the exception: WebKitGTK only saves a download if
   * the shell handles it, and this shell does not, so there the file also goes
   * to the clipboard and the line underneath says so rather than claiming a
   * file that never appeared.
   */
  async function exportOpml(): Promise<void> {
    const folders = reader.categories.map((category) => ({
      label: category.label,
      feeds: category.feeds.map((feed) => ({ title: feed.title, url: feed.url })),
    }));
    const total = folders.reduce((count, folder) => count + folder.feeds.length, 0);
    if (total === 0) {
      opmlNote = "There are no feeds to export yet.";
      return;
    }
    const name = opmlFileName(new Date());
    const xml = buildOpml(folders);
    const blob = new Blob([xml], { type: "text/x-opml" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    opmlName = name;

    const feeds = `${total} feed${total === 1 ? "" : "s"}`;
    const native = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
    if (!native) {
      opmlNote = `Exported ${feeds} to ${name}.`;
      return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(xml);
      copied = true;
    } catch {
      copied = false;
    }
    opmlNote = copied
      ? `Exported ${feeds}. If no file appeared, the OPML is on your clipboard.`
      : `Exported ${feeds} to ${name} — if no file appeared, the window could not save it.`;
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

  <!-- Everything that can grow scrolls here and nowhere else: the search field,
       the band and the indent strip stay put above, the counts and the add/OPML
       block stay put below. The list is the only thing with a length. -->
  <div
    class="scroll"
    use:pullDown={{
      label: "Pull down to check for new posts",
      readyLabel: "Release to check for new posts",
      enabled: () => !reader.loadingList && !reader.sync.active,
      onPull: pullRefresh,
    }}
  >
  {#if searching}
    {#if hits.length === 0}
      <div class="section">
        <p class="empty">
          No feed or category matches “{search.query}”.{#if !search.deep} Names only — ¶ also searches inside posts.{/if}
        </p>
      </div>
    {:else}
        <!-- Results keep their category around them. A category is the frame a
             feed list is read in, so a feed found by name still sits under its
             heading holding only what matched — and a heading that matched by
             name brings all of its feeds with it. -->
        {#each hitGroups as group (group.id)}
          <div class="section">
            <div class="group">
              <div class="row group-title search-title" class:pinned={reader.isCategoryPinned(group.label)}>
                {#if reader.isCategoryPinned(group.label)}
                  <svg class="pin" viewBox="0 0 24 24" role="img" aria-label={words.count}>
                    <path d={MARKER_PATH} />
                  </svg>
                {/if}
                <span class="label">{group.label}</span>
                {#if group.hits.length < group.total}
                  <span class="why">{group.hits.length} of {group.total}</span>
                {/if}
                <span class="count">{reader.countFor(group.id)}</span>
              </div>
            </div>
            {#each group.hits as hit (hit.feed.id)}
              <button
                class="row feed hit"
                class:active={reader.activeStream === hit.feed.id}
                onclick={() => (inlinePosts ? jumpTo(hit.feed) : open(hit.feed.id, hit.feed.title))}
              >
                <span class="label">{hit.feed.title}</span>
                {#if hit.via === "text" && hit.postTitle}
                  <span class="why">“{hit.postTitle}”</span>
                {/if}
                <span class="count">{reader.countFor(hit.feed.id)}</span>
              </button>
            {/each}
        </div>
      {/each}
    {/if}

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
            <svg class="pin" viewBox="0 0 24 24" role="img" aria-label={words.count}>
              <path d={MARKER_PATH} />
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
            class:unfolded={inlinePosts && expandedFeed === feed.id}
            onclick={() => (inlinePosts ? void toggleFeed(feed) : openFeed(feed))}
            aria-expanded={inlinePosts ? expandedFeed === feed.id : undefined}
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
              <svg class="pin" viewBox="0 0 24 24" role="img" aria-label={words.count}>
                <path d={MARKER_PATH} />
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

          {#if inlinePosts && expandedFeed === feed.id}
            <div class="posts" aria-label={`Posts in ${feed.title}`}>
              {#if reader.loadingList && reader.items.length === 0}
                <p class="posts-note">Loading…</p>
              {:else if reader.listItems.length === 0}
                <p class="posts-note">No posts.</p>
              {:else}
                {#each reader.listItems as item (item.id)}
                  <button
                    class="post"
                    class:read={isRead(item)}
                    onclick={() => openPost(item)}
                    title={item.title}
                  >
                    <span class="post-title">{item.title || "(untitled)"}</span>
                    <span class="post-time">{relativeTime(item.timestampUsec, item.published)}</span>
                    {#if reading.thumbSide !== "off" && thumbnail(item) !== null && !brokenThumbs.includes(item.id)}
                      <span
                        class="post-thumb"
                        class:left={reading.thumbSide === "left"}
                        aria-hidden="true"
                      >
                        <img
                          src={thumbnail(item)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          referrerpolicy="no-referrer"
                          draggable="false"
                          onerror={() => thumbFailed(item.id)}
                        />
                      </span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  {/each}
  {/if}

  {#if reader.subscriptions.length === 0 && !reader.loadingList}
    <p class="empty">No feeds yet.</p>
  {/if}
  </div>

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
        <label class="visually-hidden" for="feed-url">Feed URL, one per line</label>
        <textarea
          id="feed-url"
          class="url"
          class:grow={feedLines > 1}
          rows="1"
          placeholder="https://example.com/feed.xml"
          bind:value={feedUrl}
          bind:this={feedBox}
          disabled={reader.feedBusy}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          inputmode="url"
          onkeydown={onFeedKey}
        ></textarea>
        <div class="add-actions">
          <button type="submit" class="submit" disabled={reader.feedBusy}>
            {#if reader.feedProgress}
              Adding {reader.feedProgress.done}/{reader.feedProgress.total}…
            {:else if reader.feedBusy}
              Adding…
            {:else if feedLines > 1}
              Add {feedLines}
            {:else}
              Add
            {/if}
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

    <!-- Below the add field, because both are ways in for a feed list. The
         file name keeps its own line so it has room to be read: a name squeezed
         between two buttons would only ever show its first few letters. -->
    <div class="opml">
      <div class="opml-row">
        <label
          class="opml-import"
          class:busy={reader.feedBusy}
          title="Import feeds from an OPML file — folders come too"
        >
          <input
            type="file"
            accept=".opml,.xml,text/xml,application/xml,application/octet-stream"
            disabled={reader.feedBusy}
            onchange={pickOpml}
          />
          <svg class="up" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 10.6V2.4" />
            <path d="M4.7 5.7 8 2.4l3.3 3.3" />
            <path d="M2.6 10.9v2.1c0 .4.3.7.7.7h9.4c.4 0 .7-.3.7-.7v-2.1" />
          </svg>
          <span>{reader.feedBusy ? "Importing…" : "Import"}</span>
        </label>
        <button
          class="opml-export"
          onclick={exportOpml}
          disabled={reader.feedBusy || reader.categories.length === 0}
          title="Save every feed and folder as an OPML file"
        >Export</button>
      </div>
      <p class="opml-file" class:none={opmlName === null} title={opmlName ?? "No file chosen"}>
        {opmlName ?? "No file chosen"}
      </p>
      {#if opmlNote}
        <p class="opml-note" role="status">{opmlNote}</p>
      {/if}
    </div>
  </div>
</nav>

<style>
  .pin {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    opacity: 0.9;
  }

  /* The pin is drawn as a stroke, so it takes the theme's colour without
     needing a fill of its own. */
  .pin path {
    fill: none;
    stroke: var(--tone-pinned);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* The counts sit on the line under the list and never scroll: it is the
     boundary, and it belongs to the panel rather than to the tree. */
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 10px;
    flex: none;
    margin: 0;
    padding: 5px 12px 4px;
    border-top: 1px solid var(--edge-soft);
    font-size: 11px;
    line-height: 1.35;
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

  /* A frame, not a page: the nav itself never scrolls, so nothing can carry the
     add field or the counts off the top of the panel. */
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    padding: 0;
    background: var(--surface);
    border-right: 1px solid var(--edge);
  }

  /* The one scrollable part: the tree. `min-height: 0` is what lets a flex child
     shrink below its content so this actually scrolls instead of pushing the
     footer out. */
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: 2px;
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
    transition: background-color 120ms ease, box-shadow 120ms ease;
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
    outline: 1px solid color-mix(in srgb, var(--tone-pinned) 45%, transparent);
    outline-offset: -1px;
    border-radius: 5px;
    box-shadow:
      inset 0 -2px 0 color-mix(in srgb, var(--tone-pinned) 60%, transparent),
      0 0 9px color-mix(in srgb, var(--tone-pinned) 18%, transparent);
  }

  .group-title.pinned .label,
  .feed.pinned .label {
    color: color-mix(in srgb, var(--tone-pinned) 70%, var(--text));
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
    transition: fill 160ms ease, stroke 160ms ease, opacity 160ms ease;
    stroke: var(--tone-pinned);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .feed.pinned .label {
    color: color-mix(in srgb, var(--tone-pinned) 65%, var(--text-dim));
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

  /* Feed rows take the server's indent on top of a small base inset. The base
     used to be 34px — a full caret column's width — which pushed the first
     child's icon 46px into a 250px sidebar and its name to ~70px, so the tree
     read as though it started in the middle of the panel. Children now begin
     near the edge (8px + the extension's indent) and are told apart from their
     category by size, weight and colour rather than by a deep column. Category
     rows still take no indent: that is the hierarchy the indent expresses. */
  .feed {
    padding-left: calc(8px + var(--feed-indent, 12px));
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .feed.active {
    color: var(--accent-text);
  }

  .feed.unfolded {
    color: var(--text);
    font-weight: 600;
  }

  /* Posts under an open feed, in the one-panel layout. Indented to the same
     column as the feed's name so the nesting is legible without the feed's icon
     column being repeated, and quiet enough that the feeds below still read as
     the list's spine. */
  .posts {
    display: flex;
    flex-direction: column;
    padding: 2px 6px 4px calc(30px + var(--feed-indent, 12px));
    gap: 1px;
  }

  .post {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .post:hover {
    background: var(--hover);
    color: var(--text);
  }

  .post.read {
    color: var(--muted);
  }

  .post-title {
    flex: 1;
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.35;
  }

  .post-time {
    flex: none;
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  /* The picture the feed chose, at the size the reader asked for in Aa — the
     same 48px × row × picture scales as the posts column, so the size setting
     means one thing everywhere. A row without a picture keeps its plain shape
     rather than reserving a box. */
  .post-thumb {
    display: block;
    flex: none;
    width: calc(48px * var(--row-scale, 1) * var(--thumb-scale, 1));
    height: calc(48px * var(--row-scale, 1) * var(--thumb-scale, 1));
    border-radius: 5px;
    overflow: hidden;
    background: var(--hover);
  }

  .post-thumb.left {
    order: -1;
  }

  .post-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    color: transparent;
  }

  .posts-note {
    margin: 0;
    padding: 3px 6px 5px;
    color: var(--muted);
    font-size: 11.5px;
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Search sits at the top of the sidebar, above the hidden/pinned band: it
     filters the whole tree below it, band included, so it belongs first. One quiet field — the magnifier and
     the mode mark live inside it, so there is no button beside the input. */
  .find {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    margin: 6px 12px 3px;
    padding: 0 6px 0 9px;
    height: 28px;
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

  /* The result heading is a label, not a control: it names the frame the rows
     under it are drawn in. The "2 of 7" says the category is only partly here. */
  .search-title {
    cursor: default;
    padding-right: 12px;
  }

  .search-title .why {
    flex: 0 0 auto;
    font-size: 10px;
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

  /* Compact, because it is furniture: two rows and a file name, no scroll, and
     every pixel it takes comes straight out of the tree. */
  .add {
    flex: none;
    padding: 5px 12px 8px;
  }

  .add-open {
    width: 100%;
    padding: 5px 8px;
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

  /* One line by default; the height is set from the content by `fitFeedBox`,
     so the box grows with a pasted list and never leaves a blank row behind. */
  .url {
    display: block;
    width: 100%;
    min-height: 28px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    line-height: 16px;
    resize: none;
    overflow-y: auto;
  }

  .url.grow {
    /* A list is being built: give the field a floor before it has scrolled. */
    min-height: 44px;
  }

  .url:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .url:disabled {
    opacity: 0.6;
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

  /* OPML sits under the add field as a second way in for a feed list. Both
     controls are the same quiet weight as "+ Add feed" above them. */
  .opml {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .opml-row {
    display: flex;
    gap: 6px;
  }

  .opml-import,
  .opml-export {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .opml-import {
    flex: 1;
  }

  .opml-import:hover,
  .opml-export:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border);
  }

  .opml-import.busy,
  .opml-export:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* The file input is the label's business, not the sidebar's: the visible
     control is the label, and the browser's own chrome would break the row. */
  .opml-import input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .opml-import .up {
    flex: none;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The name of the file in play, on a line of its own so it has room: clipped
     with an ellipsis rather than wrapped, and dimmed to a hint when empty. */
  .opml-file {
    margin: 0;
    padding: 0 2px;
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opml-file.none {
    color: var(--muted);
    opacity: 0.75;
  }

  .opml-note {
    margin: 0;
    padding: 0 2px;
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--text-dim);
  }
</style>
