<script lang="ts">
  import type { StreamItem } from "../api/freshrss";
  import { isRead, isStarred } from "../api/freshrss";
  import { plainPreview, relativeTime } from "../lib/format";
  import { ARTICLE_FILTERS, ARTICLE_FILTER_LABELS, type ArticleFilter } from "../lib/article-filter";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";

  let { onOpen }: { onOpen?: () => void } = $props();

  function summary(item: StreamItem): string {
    return plainPreview(item.summary?.content ?? item.content?.content, 160);
  }

  /**
   * The filter is global on purpose: it is how you are reading, so it follows
   * you into every feed rather than being re-set on each one.
   */
  function setFilter(filter: ArticleFilter) {
    reading.setArticleFilter(filter);
  }

  function open(item: StreamItem) {
    reader.select(item);
    onOpen?.();
  }
</script>

<section class="list" aria-label={reader.activeTitle}>
  <header class="list-header">
    <div class="headline">
      <h1>{reader.activeTitle}</h1>
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
  </header>

  <div class="items">
    {#if reader.loadingList && reader.items.length === 0}
      <div class="skeleton" aria-hidden="true">
        {#each Array(6) as _, index (index)}
          <div class="skeleton-row">
            <span class="bar w-80"></span>
            <span class="bar w-60"></span>
            <span class="bar w-30"></span>
          </div>
        {/each}
      </div>
    {/if}
    {#each reader.listItems as item (item.id)}
      <button
        class="item"
        class:selected={reader.selectedId === item.id}
        class:read={isRead(item)}
        onclick={() => open(item)}
      >
        <span class="dot" class:hidden={isRead(item)} aria-hidden="true"></span>
        <span class="body">
          <span class="title">{item.title || "(untitled)"}</span>
          <span class="preview">{summary(item)}</span>
          <span class="byline">
            <span class="feed-name">{item.origin?.title ?? ""}</span>
            <span class="time">{relativeTime(item.timestampUsec, item.published)}</span>
            {#if isStarred(item)}<span class="star" aria-label="Starred">★</span>{/if}
          </span>
        </span>
      </button>
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

  .bar {
    height: 9px;
    border-radius: 5px;
    background: var(--hover, #2f2f2f);
    animation: pulse 1.1s ease-in-out infinite;
  }

  .w-80 { width: 80%; }
  .w-60 { width: 60%; }
  .w-30 { width: 30%; height: 7px; }

  @keyframes pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 0.85; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar { animation: none; opacity: 0.55; }
  }

  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--bg);
    border-right: 1px solid var(--border);
  }

  .list-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }

  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .item {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 12px 16px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--hover);
  }

  .item.selected {
    background: var(--accent-soft);
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
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .title {
    font-size: 13.5px;
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
    font-size: 12px;
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
    font-size: 11px;
    color: var(--muted);
  }

  .feed-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }

  .star {
    color: var(--star);
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
