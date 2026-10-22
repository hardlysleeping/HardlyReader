<script lang="ts">
  import type { StreamItem } from "../api/freshrss";
  import { isRead, isStarred } from "../api/freshrss";
  import { plainPreview, relativeTime } from "../lib/format";
  import { reader } from "../state/reader.svelte";

  let { onOpen }: { onOpen?: () => void } = $props();

  function summary(item: StreamItem): string {
    return plainPreview(item.summary?.content ?? item.content?.content, 160);
  }

  function open(item: StreamItem) {
    reader.select(item);
    onOpen?.();
  }
</script>

<section class="list" aria-label={reader.activeTitle}>
  <header class="list-header">
    <h1>{reader.activeTitle}</h1>
    <span class="meta">
      {#if reader.loadingList}
        Loading…
      {:else}
        {reader.items.length} item{reader.items.length === 1 ? "" : "s"}
      {/if}
    </span>
  </header>

  <div class="items">
    {#each reader.items as item (item.id)}
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

    {#if !reader.loadingList && reader.items.length === 0}
      <p class="empty">Nothing here.</p>
    {/if}

    {#if reader.continuation}
      <button class="more" onclick={() => reader.loadMore()} disabled={reader.loadingMore}>
        {reader.loadingMore ? "Loading…" : "Load more"}
      </button>
    {/if}
  </div>
</section>

<style>
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
    gap: 12px;
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
