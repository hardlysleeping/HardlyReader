<script lang="ts">
  import type { StreamItem } from "../api/freshrss";
  import { isRead, isStarred } from "../api/freshrss";
  import { plainPreview, relativeTime } from "../lib/format";
  import { thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { ARTICLE_FILTERS, ARTICLE_FILTER_LABELS, type ArticleFilter } from "../lib/article-filter";
  import {
    CARD_LEAD,
    CARD_SIZE_LABELS,
    CARD_SIZE_TITLES,
    CARD_SIZES,
    GRID_COLUMN_CHOICES,
    GRID_COLUMNS_DEFAULT,
    LIST_VIEWS,
    LIST_VIEW_LABELS,
    LIST_VIEW_TITLES,
    gridIsSquare,
    gridTemplate,
    isListView,
    picturePlacement,
    showsPreview,
    type ListView,
  } from "../lib/list-view";
  import { near } from "../lib/near-view";
  import { pullDown } from "../lib/pull";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";
  import { MARKER_PATH, pinWords } from "../lib/theme";

  /**
   * `nested` renders this list as a block under its feed row instead of as a
   * column of its own — the one-pane feed list, and the phone.
   *
   * Same component, same rows, same star and read toggles, same four views and
   * the same header: the one-pane posts used to be a second, smaller
   * implementation with a title, a time and a picture, which is why a phone had
   * no way to star a post and no way to change how the posts were drawn.
   */
  let { onOpen, nested = false }: { onOpen?: () => void; nested?: boolean } = $props();

  function summary(item: StreamItem): string {
    return plainPreview(item.summary?.content ?? item.content?.content, 160);
  }

  /*
   * The picture a row shows, worked out once per post. Regexes over the body
   * HTML are cheap but not free, and a list re-renders on every scroll tick
   * and read mark, so the answer is remembered against the item object itself.
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
  let broken = $state<string[]>([]);

  function fail(id: string): void {
    broken = [...broken, id];
  }

  /**
   * The filter is global on purpose: it is how you are reading, so it follows
   * you into every feed rather than being re-set on each one.
   */
  function setFilter(filter: ArticleFilter) {
    reading.setArticleFilter(filter);
  }

  /** The shape of this column, global for the same reason as the filter. */
  const view = $derived(reading.listView);

  /**
   * Which rows are close to the viewport. Only those draw a picture.
   *
   * The list has to stay instant when its view changes, and the one thing a view
   * change does that costs real time is hand the engine a screenful of photos it
   * has never decoded: the cards markup holds an `<img>`, so choosing Cards
   * created every picture in the list at once. In the native window that was
   * enough to stop it answering at all.
   */
  let nearIds = $state<Record<string, boolean>>({});
  const markNear = (id: string, isNear: boolean): void => {
    if ((nearIds[id] === true) === isNear) return;
    if (isNear) nearIds[id] = true;
    else delete nearIds[id];
  };

  /** The scroll port the rows are measured against. */
  let itemsEl = $state<HTMLElement | null>(null);

  /**
   * The feed whose posts these are, when the list is one feed.
   *
   * A category, a smart stream or the reading list is not a feed and has nothing
   * to mark; this is null for those, and the header stays as it was.
   */
  const feed = $derived(
    reader.subscriptions.find((candidate) => candidate.id === reader.activeStream) ?? null,
  );

  /** "Pin" / "Unpin" / "Pinned", the same three words the sidebar uses. */
  const words = pinWords();

  function setView(next: ListView) {
    reading.setListView(next);
  }

  /** The picture for a post, or null when this shape shows none. */
  function image(item: StreamItem): string | null {
    if (reading.thumbSide === "off" || picturePlacement(view) === "none") return null;
    if (broken.includes(item.id)) return null;
    return thumbnail(item);
  }

  function open(item: StreamItem) {
    reader.select(item);
    onOpen?.();
  }

  /**
   * Star and read are buttons of their own, never a click on the row: the row
   * opens the post, and a mis-tap into the reader is not how anyone wants to
   * star something. Both are optimistic in `reader`, so the mark moves now.
   */
  function toggleStar(item: StreamItem, event: MouseEvent): void {
    event.stopPropagation();
    void reader.toggleStar(item);
  }

  function toggleRead(item: StreamItem, event: MouseEvent): void {
    event.stopPropagation();
    void reader.setRead(item, !isRead(item));
  }
</script>

<section class="list" data-pane="posts" class:nested aria-label={reader.activeTitle}>
  <header class="list-header">
    <div class="headline">
      {#if !nested}
        <h1>{reader.activeTitle}</h1>
      {/if}
      {#if feed}
        <!-- The feed you are reading, marked from where you are reading it: the
             same local pin the sidebar row shows, so a feed can be pinned while
             you are in its posts instead of going back to pane one. Categories
             and smart streams are not feeds, so they get no mark. -->
        <button
          class="mark"
          class:on={reader.isFeedPinned(feed.id)}
          aria-pressed={reader.isFeedPinned(feed.id)}
          aria-label={`${reader.isFeedPinned(feed.id) ? words.remove : words.add} ${feed.title}`}
          title={reader.isFeedPinned(feed.id) ? `${words.remove} this feed` : `${words.add} this feed`}
          onclick={() => reader.setFeedPinned(feed.id, !reader.isFeedPinned(feed.id))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
        </button>
      {/if}
      <span class="meta">
        {#if reader.loadingList}
          Loading…
        {:else if reading.articleFilter === "all"}
          {reader.listItems.length} item{reader.listItems.length === 1 ? "" : "s"}
        {:else}
          {reader.listItems.length} of {reader.items.length}
        {/if}
      </span>
    </div>

    <div class="bar" role="group" aria-label="How posts are shown">
      <!-- Four shapes, one at a time. Icons rather than words because this bar
           shares a 240px column with the filter pills and the feed title. -->
      <div class="views" role="group" aria-label="Post view">
        {#each LIST_VIEWS as option (option)}
          <button
            class="viewicon"
            class:on={view === option}
            aria-pressed={view === option}
            aria-label={LIST_VIEW_LABELS[option]}
            title={LIST_VIEW_TITLES[option]}
            onclick={() => setView(option)}
          >
            {#if option === "regular"}
              <svg viewBox="0 0 16 16" aria-hidden="true"
                ><path d="M2 3.5h12M2 8h7M2 12.5h9" /><circle cx="13" cy="8" r="1.4" /></svg
              >
            {:else if option === "list"}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
            {:else if option === "cards"}
              <svg viewBox="0 0 16 16" aria-hidden="true"
                ><rect x="2.5" y="2.5" width="11" height="7" rx="1.4" /><path d="M2.5 12h9" /></svg
              >
            {:else}
              <svg viewBox="0 0 16 16" aria-hidden="true"
                ><rect x="2.2" y="2.2" width="5" height="5" rx="1" /><rect x="8.8" y="2.2" width="5" height="5" rx="1" /><rect
                  x="2.2"
                  y="8.8"
                  width="5"
                  height="5"
                  rx="1"
                /><rect x="8.8" y="8.8" width="5" height="5" rx="1" /></svg
              >
            {/if}
          </button>
        {/each}
      </div>

      <!-- Sizing lives where the view is chosen, and only the view that has
           something to size shows it: the grid's tiles per row, the cards'
           picture height. `auto` is always the way it looked before, so the
           default is the previous behaviour, not a new look. -->
      {#if view === "grid"}
        <div class="sizer" role="group" aria-label="Tiles per row">
          {#each GRID_COLUMN_CHOICES as count (count)}
            <button
              class="sizebtn"
              class:on={reading.gridColumns === count}
              aria-pressed={reading.gridColumns === count}
              title={count === "auto"
                ? "As many tiles as fit, the size they have always been"
                : `${count} tiles across: fewer, larger squares`}
              onclick={() => reading.setGridColumns(count)}
            >{count === "auto" ? "auto" : count}</button
            >
          {/each}
        </div>
      {:else if view === "cards"}
        <div class="sizer" role="group" aria-label="Card picture size">
          {#each CARD_SIZES as size (size)}
            <button
              class="sizebtn"
              class:on={reading.cardSize === size}
              aria-pressed={reading.cardSize === size}
              title={CARD_SIZE_TITLES[size]}
              onclick={() => reading.setCardSize(size)}
            >{CARD_SIZE_LABELS[size]}</button
            >
          {/each}
        </div>
      {/if}
      <div class="filters" role="group" aria-label="Show posts">
        {#each ARTICLE_FILTERS as filter (filter)}
          <button
            class="filter"
            class:on={reading.articleFilter === filter}
            aria-pressed={reading.articleFilter === filter}
            title={`Show ${ARTICLE_FILTER_LABELS[filter].toLowerCase()} posts in every feed`}
            onclick={() => setFilter(filter)}
          >
            {ARTICLE_FILTER_LABELS[filter]}
          </button>
        {/each}
      </div>
    </div>
  </header>

  <!-- Pull down at the top asks this feed for anything newer without losing the
     list underneath: the same request the sync button makes, scoped to what is
     on screen. -->
  <div
    class="items"
    bind:this={itemsEl}
    class:compact={view === "list"}
    class:cards={view === "cards"}
    class:grid={view === "grid"}
    class:square={view === "grid" && gridIsSquare(reading.gridColumns)}
    style:--grid-template={gridTemplate(reading.gridColumns)}
    style:--card-lead={`${CARD_LEAD[reading.cardSize]}px`}
    use:pullDown={{
      label: "Pull down to check for new posts",
      readyLabel: "Release to check for new posts",
      enabled: () => !reader.loadingList,
      onPull: () => void reader.reloadStream({ force: true }),
    }}
  >
    {#if reader.loadingList && reader.items.length === 0}
      <div class="skeleton" aria-hidden="true">
        {#each Array(6) as _, index (index)}
          <div class="skeleton-row">
            <span class="bone w-80"></span>
            <span class="bone w-60"></span>
            <span class="bone w-30"></span>
          </div>
        {/each}
      </div>
    {/if}
    {#each reader.listItems as item (item.id)}
      {@const picture = image(item)}
      {@const placement = picture === null ? "none" : picturePlacement(view)}
      <div
        class="row"
        class:selected={reader.selectedId === item.id}
        class:read={isRead(item)}
        class:stacked={placement === "top"}
        use:near={{ root: itemsEl, near: (isNear: boolean) => markNear(item.id, isNear) }}
      >
        <button class="item" onclick={() => open(item)}>
          {#if placement === "top"}
            <span class="lead" aria-hidden="true">
              {#if nearIds[item.id]}
                <img
                  src={picture}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  draggable="false"
                  onerror={() => fail(item.id)}
                />
              {/if}
            </span>
          {/if}
          <span class="body">
            <span class="line">
              <span class="dot" class:hidden={isRead(item)} aria-hidden="true"></span>
              <span class="title">{item.title || "(untitled)"}</span>
            </span>
            {#if showsPreview(view)}
              <span class="preview">{summary(item)}</span>
            {/if}
            <span class="byline">
              <span class="feed-name">{item.origin?.title ?? ""}</span>
              <span class="time">{relativeTime(item.timestampUsec, item.published)}</span>
            </span>
          </span>
          {#if placement === "side"}
            <span class="thumb" class:left={reading.thumbSide === "left"} aria-hidden="true">
              {#if nearIds[item.id]}
                <img
                  src={picture}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  draggable="false"
                  onerror={() => fail(item.id)}
                />
              {/if}
            </span>
          {/if}
        </button>

        <!-- Star and read, in every shape: a view you cannot act in is a view
             you have to leave to use the list. -->
        <div class="acts">
          <button
            class="act"
            class:on={isStarred(item)}
            aria-pressed={isStarred(item)}
            aria-label={isStarred(item) ? "Remove star" : "Star this post"}
            title={isStarred(item) ? "Remove star" : "Star this post"}
            onclick={(event) => toggleStar(item, event)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"
              ><path
                d="M8 1.9l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.7 4.2 13.7l.7-4.3-3.1-3 4.3-.6z"
              /></svg
            >
          </button>
          <button
            class="act mark"
            class:on={isRead(item)}
            aria-pressed={isRead(item)}
            aria-label={isRead(item) ? "Mark unread" : "Mark read"}
            title={isRead(item) ? "Mark unread" : "Mark read"}
            onclick={(event) => toggleRead(item, event)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"
              ><circle cx="8" cy="8" r="5.4" /><path d="M5.2 8.2l2 2 3.6-3.9" /></svg
            >
          </button>
        </div>
      </div>
    {/each}

    {#if !reader.loadingList && reader.listItems.length === 0}
      <p class="empty">
        {#if reader.items.length > 0}
          Nothing matches “{ARTICLE_FILTER_LABELS[reading.articleFilter]}”.
        {:else}
          Nothing here.
        {/if}
      </p>
    {/if}

    {#if reader.continuation}
      <button class="more" onclick={() => reader.loadMore()} disabled={reader.loadingMore}>
        {reader.loadingMore ? "Loading…" : "Load more"}
      </button>
    {/if}
  </div>
</section>

<style>
  .headline {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  /* The sizing pills sit next to the view pills and read as a second group: a
     hairline between them, and the same press-and-hold-the-meaning behaviour. */
  .sizer {
    display: flex;
    gap: 1px;
    padding: 2px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
  }

  .sizebtn {
    min-width: 20px;
    padding: 1px 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 10.5px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
  }

  .sizebtn:hover {
    color: var(--text);
  }

  .sizebtn.on {
    background: var(--bg);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--edge);
  }

  .views {
    display: flex;
    gap: 1px;
    padding: 1px;
    border-radius: 7px;
    background: color-mix(in srgb, var(--edge-soft) 70%, transparent);
  }

  .viewicon {
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
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .viewicon svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .viewicon:hover {
    color: var(--text);
    background: var(--hover);
  }

  .viewicon.on {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .filters {
    display: flex;
    gap: 4px;
    flex: 0 0 auto;
  }

  /* Cut-out pills, matching the band: outline until chosen, filled when on. */
  .filter {
    padding: 3px 8px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease, transform 0.08s ease;
  }

  .filter:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .filter:active {
    transform: scale(0.95);
  }

  .filter.on {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 26%, transparent);
    border-color: var(--accent);
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 12px;
  }

  .skeleton-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Skeleton bones, not `.bar`: that name is the header's control group. */
  .bone {
    height: 9px;
    border-radius: 5px;
    background: var(--hover, #2f2f2f);
    animation: pulse 1.1s ease-in-out infinite;
  }

  .bone.w-80 { width: 80%; }
  .w-60 { width: 60%; }
  .w-30 { width: 30%; height: 7px; }

  @keyframes pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 0.85; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bone { animation: none; opacity: 0.55; }
  }

  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--bg);
    border-right: 1px solid var(--edge);
  }

  /* Nesting under a feed row: no height to fill, no edge to draw, no second
     scrollbar. The bar keeps the views and the feed's mark and drops the title,
     because the row above is the title. */
  .list.nested {
    height: auto;
    background: none;
    border-right: 0;
  }

  .list.nested .list-header {
    align-items: center;
    gap: 4px 8px;
    padding: 0 0 3px;
  }

  .list.nested .items {
    flex: 0 0 auto;
    overflow: visible;
    padding-bottom: 2px;
  }

  .list-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--edge-soft);
  }

  h1 {
    margin: 0;
    /* The mark sits beside the title, so the title has to be allowed to give up
       width before the count does. */
    min-width: 0;
    flex: 0 1 auto;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Sits with the title it belongs to, not in the toolbar: it marks a feed, and
     the toolbar is about how the posts are drawn. Quiet until it is on. */
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.12s ease;
  }

  .mark svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mark:hover {
    color: var(--text-dim);
  }

  .mark.on {
    color: var(--accent);
  }

  .mark.on svg {
    fill: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .mark:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  .meta {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  .items {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 32px;
  }

  /* The bar the list is made of. One row per post, whichever shape it takes. */
  .row {
    position: relative;
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border-soft);
  }

  .row:hover {
    background: var(--hover);
  }

  .row.selected {
    background: var(--accent-soft);
  }

  .item {
    display: flex;
    flex: 1;
    gap: 10px;
    min-width: 0;
    /* Row height, type and thumbnail are one scale: growing the picture without
       the type (or the other way round) makes the row look broken, not larger. */
    padding: calc(12px * var(--row-scale, 1)) 16px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .dot.hidden {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .line {
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .title {
    font-size: calc(13.5px * var(--row-scale, 1));
    font-weight: 550;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .read .title {
    font-weight: 450;
    color: var(--text-dim);
  }

  .preview {
    font-size: calc(12px * var(--row-scale, 1));
    line-height: 1.4;
    color: var(--muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .byline {
    display: flex;
    gap: 8px;
    font-size: calc(11px * var(--row-scale, 1));
    color: var(--muted);
    min-width: 0;
  }

  .feed-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }

  .time {
    flex: none;
  }

  /* The picture the feed itself chose. Rendered only when a feed offered one,
     so text-only feeds keep the plain row instead of a row of empty boxes. */
  .thumb {
    display: block;
    flex: none;
    align-self: center;
    width: calc(48px * var(--row-scale, 1) * var(--thumb-scale, 1));
    height: calc(48px * var(--row-scale, 1) * var(--thumb-scale, 1));
    margin-left: 10px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--hover);
  }

  /* Left is a real move, not a mirror: the picture takes the row's leading
     edge and the read dot steps in after it, so the dot stays adjacent to the
     title it qualifies. */
  .thumb.left {
    order: -1;
    margin-left: 0;
    margin-right: 10px;
  }

  .thumb img,
  .lead img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    color: transparent;
  }

  /* Star and read: quiet until wanted, always present, and out of the way of
     the row's own click. */
  .acts {
    display: flex;
    flex: none;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 2px 8px 2px 0;
  }

  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.12s ease, color 0.12s ease, background-color 0.12s ease;
  }

  .act svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }

  .row:hover .act,
  .act.on,
  .act:focus-visible {
    opacity: 1;
  }

  .act:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .act.on {
    color: var(--star);
  }

  .act.on svg {
    fill: currentColor;
  }

  .act.mark.on {
    color: var(--accent);
  }

  /* Thumbs need bigger targets than pointers do. */
  /* A finger is not a cursor with a 1px hotspot. 20px is right for a mouse and
     too small for a thumb, and these two toggles are the ones a phone needs to
     reach without missing. */
  @media (pointer: coarse) {
    .act {
      width: 34px;
      height: 34px;
      opacity: 1;
    }

    .act svg {
      width: 15px;
      height: 15px;
    }

    /* The views and the filter pills are the way into the list at all on a
       phone, where there is no other column to change. 21x19 is a mouse size. */
    .viewicon {
      width: 32px;
      height: 30px;
    }

    .viewicon svg {
      width: 14px;
      height: 14px;
    }

    .filter {
      padding: 6px 10px;
      font-size: 10.5px;
    }
  }

  /* ---------------------------------------------------------------- list --
     One line per post: the headline, the feed and the time. No preview, no
     picture — that is the trade for fitting twice as many on a screen. */
  .compact .item {
    padding: calc(6px * var(--row-scale, 1)) 14px;
  }

  .compact .body {
    flex-direction: row;
    align-items: baseline;
    gap: 10px;
  }

  .compact .line {
    flex: 1;
    align-items: baseline;
  }

  .compact .dot {
    margin-top: 0;
    align-self: center;
  }

  .compact .title {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: calc(12.5px * var(--row-scale, 1));
  }

  .compact .byline {
    flex: none;
    font-size: calc(10.5px * var(--row-scale, 1));
  }

  .compact .acts {
    flex-direction: row;
    align-items: center;
    gap: 2px;
  }

  .compact .act {
    width: 18px;
    height: 18px;
  }

  /* --------------------------------------------------------------- cards --
     The picture gets the width and the headline sits under it. */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 10px 32px;
  }

  .cards .row {
    /* The cards column is a flex container inside a scroll port with a definite
       height, so without this every row shrinks to nothing as if it were meant
       to fit: 40 posts became 40 slivers, and `loading="lazy"` had no reason to
       hold anything back because everything was "in view". */
    flex: none;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    overflow: hidden;
    background: var(--surface);
    transition: border-color 0.12s ease;
  }

  .cards .row:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft));
  }

  .cards .row.selected {
    border-color: var(--accent);
  }

  .cards .item {
    flex-direction: column;
    gap: 0;
    padding: 0;
  }

  .cards .lead {
    /* A flex child of the column, like the row was: without `flex: none` the
       picture is what gets shrunk to make the card fit, so every card lost its
       image and the row was text-only. */
    flex: none;
    display: block;
    width: 100%;
    /* 150px is the height cards have always had; the S/M/L control sets the
       variable, and `auto` writes the same number back. */
    aspect-ratio: 16 / 9;
    /* The bar's S/M/L picks the height; the reading scale still multiplies it,
       so a user who set pictures larger in the Aa panel keeps that. */
    max-height: calc(var(--card-lead, 150px) * var(--thumb-scale, 1));
    overflow: hidden;
    background: var(--hover);
  }

  .cards .body {
    padding: calc(9px * var(--row-scale, 1)) calc(11px * var(--row-scale, 1))
      calc(10px * var(--row-scale, 1));
  }

  .cards .acts,
  .grid .acts {
    position: absolute;
    top: 6px;
    right: 6px;
    flex-direction: row;
    gap: 3px;
    padding: 2px;
    border-radius: 7px;
    /* Flat, not blurred: a backdrop filter is a layer per card, and this app
       draws its cards by the dozen in a webview that renders in software. */
    background: color-mix(in srgb, var(--bg) 88%, transparent);
  }

  /* ---------------------------------------------------------------- grid --
     Tiles, side by side: as many as the column's width allows. */
  .grid {
    display: grid;
    /* `auto` is the grid's own judgement — as many 132px tiles as fit — and it is
       what the container falls back to when no count is set. A fixed count comes
       in as `--grid-template` from the bar. */
    grid-template-columns: var(--grid-template, repeat(auto-fill, minmax(132px, 1fr)));
    /* Tracks take the tile's real height. Without this the track was sized while
       the picture was still a shrinkable flex child, so it settled on the height
       of the text alone — a 200px picture inside a 47px tile, clipped by the
       row's `overflow: hidden`. The pictures looked like slivers and the tiles
       like strips, which is what "the grid is broken" meant. */
    grid-auto-rows: max-content;
    gap: 8px;
    align-content: start;
    padding: 8px 8px 32px;
  }

  /* A fixed count means the tile is a square: "four per row" should read as four
     big squares, not four tall cards with a strip of headline. */
  .grid.square .lead {
    aspect-ratio: 1;
    max-height: none;
  }

  .grid .row {
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
    transition: border-color 0.12s ease;
  }

  .grid .row:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft));
  }

  .grid .row.selected {
    border-color: var(--accent);
  }

  .grid .item {
    flex-direction: column;
    gap: 0;
    padding: 0;
  }

  .grid .lead {
    /* Same shrink as the cards: the tile's picture is the part that gets
       squeezed to make the tile fit, so it was a 36px sliver. */
    flex: none;
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    max-height: calc(120px * var(--thumb-scale, 1));
    overflow: hidden;
    background: var(--hover);
  }

  .grid .body {
    padding: 7px 8px 9px;
  }

  .grid .title {
    font-size: calc(11.5px * var(--row-scale, 1));
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .grid .byline {
    font-size: calc(10px * var(--row-scale, 1));
  }

  .grid .feed-name {
    max-width: 100%;
  }

  /* A tile with no picture would be half empty: it says what it is instead. */
  .grid .row:not(.stacked) .body {
    padding-top: 12px;
  }

  .grid .more {
    grid-column: 1 / -1;
  }

  .empty {
    padding: 24px 16px;
    font-size: 13px;
    color: var(--muted);
  }

  .more {
    display: block;
    margin: 16px auto;
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .more:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
