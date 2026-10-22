<script lang="ts">
  import { READING_LIST, STATE_STARRED } from "../api/freshrss";
  import {
    LongPressTracker,
    anchorForRect,
    armsLongPress,
    isMenuKey,
  } from "../lib/contextmenu";
  import { reader, type CategoryGroup } from "../state/reader.svelte";

  let { onNavigate }: { onNavigate?: () => void } = $props();

  let collapsed = $state<Record<string, boolean>>({});

  /**
   * Set when a long press has opened the menu, so the click that the browser
   * still sends on lift does not also open the category stream.
   */
  let swallowClick = false;
  let press: LongPressTracker | null = null;

  function toggle(id: string) {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
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

  /**
   * Right-click. Without the extension there is nothing to offer, so the native
   * menu is left alone rather than replaced by a dead one.
   */
  function onContextMenu(event: MouseEvent, category: CategoryGroup) {
    if (!reader.hiddenAvailable) return;
    event.preventDefault();
    reader.openCategoryMenu(category.label, { x: event.clientX, y: event.clientY });
  }

  /** Shift+F10 and the context-menu key: same menu, anchored to the row. */
  function onKeydown(event: KeyboardEvent, category: CategoryGroup) {
    if (!reader.hiddenAvailable || !isMenuKey(event)) return;
    event.preventDefault();
    const anchor = anchorForRect((event.currentTarget as HTMLElement).getBoundingClientRect());
    reader.openCategoryMenu(category.label, anchor);
  }

  function onPointerDown(event: PointerEvent, category: CategoryGroup) {
    if (!reader.hiddenAvailable || !armsLongPress(event.pointerType)) return;
    swallowClick = false;
    press?.cancel();
    press = new LongPressTracker((point) => {
      swallowClick = true;
      reader.openCategoryMenu(category.label, point);
    });
    press.start({
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });
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
</script>

<nav class="sidebar" aria-label="Feeds">
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
    <div class="section">
      <div class="group">
        <button
          class="row group-title"
          class:active={reader.activeStream === category.id}
          onclick={() => openCategory(category)}
          oncontextmenu={(event) => onContextMenu(event, category)}
          onkeydown={(event) => onKeydown(event, category)}
          onpointerdown={(event) => onPointerDown(event, category)}
          onpointermove={onPointerMove}
          onpointerup={cancelPress}
          onpointercancel={cancelPress}
          onpointerleave={cancelPress}
          aria-haspopup={reader.hiddenAvailable ? "menu" : undefined}
        >
          <span class="chevron" class:closed={collapsed[category.id]} aria-hidden="true">▾</span>
          <span class="label">{category.label}</span>
          <span class="count">{reader.countFor(category.id)}</span>
        </button>
        <button
          class="toggle"
          aria-label={collapsed[category.id] ? "Expand" : "Collapse"}
          onclick={() => toggle(category.id)}
        ></button>
      </div>

      {#if !collapsed[category.id]}
        {#each category.feeds as feed (feed.id)}
          <button
            class="row feed"
            class:active={reader.activeStream === feed.id}
            onclick={() => open(feed.id, feed.title)}
            title={feed.title}
          >
            <span class="label">{feed.title}</span>
            {#if reader.countFor(feed.id) > 0}
              <span class="count">{reader.countFor(feed.id)}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/each}

  {#if reader.subscriptions.length === 0 && !reader.loadingList}
    <p class="empty">No feeds yet.</p>
  {/if}
</nav>

<style>
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
  }

  .row.strong .label {
    font-weight: 600;
  }

  .group {
    position: relative;
  }

  .group-title {
    padding-left: 8px;
  }

  .group-title .label {
    font-weight: 600;
    text-transform: none;
  }

  .chevron {
    width: 12px;
    font-size: 10px;
    color: var(--muted);
    transition: transform 0.12s ease;
  }

  .chevron.closed {
    transform: rotate(-90deg);
  }

  /* A full-size sibling catches clicks on the chevron only, so the row itself
     stays a single click target for opening the category stream. */
  .toggle {
    position: absolute;
    top: 0;
    left: 0;
    width: 24px;
    height: 100%;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .feed {
    padding-left: 34px;
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
</style>
