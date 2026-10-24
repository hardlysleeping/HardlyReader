<script lang="ts">
  import type { StreamItem } from "../api/freshrss";
  import { isRead, isStarred } from "../api/freshrss";
  import { authorOf, bylineOf, bylineTitle, feedNameOf } from "../lib/byline";
import { plainPreview, relativeTime } from "../lib/format";
  import { cropVariant, imagesOf, panelsOf, thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { ARTICLE_FILTERS, ARTICLE_FILTER_LABELS, type ArticleFilter } from "../lib/article-filter";
  import {
    CARD_LAYOUT_TITLES,
    CARD_WINDOW,
    CARD_SIZE_LABELS,
    CARD_SIZE_TITLES,
    CARD_SIZES,
    GRID_COLUMN_MAX,
    GRID_COLUMN_MIN,
    gridColumnValue,
    GRID_COLUMNS_DEFAULT,
    LIST_VIEWS,
    LIST_VIEW_LABELS,
    LIST_VIEW_TITLES,
    MASONRY_COLUMN_CHOICES,
    gridIsSquare,
    gridTemplate,
    isListView,
  masonryTrack,
    picturePlacement,
    showsPreview,
    type ListView,
  } from "../lib/list-view";
  import { cardLayout } from "../lib/card-layout.svelte";
  import { near } from "../lib/near-view";
  import { pullDown } from "../lib/pull";
  import { SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor } from "../lib/scroll-advance";
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

  /**
   * The post's opening words. A row shows a line or two under the headline; a
   * card has a whole picture's worth of width and three or four lines of room
   * under it, so the same stub of text there was a card that looked like a row
   * with a picture stuck on top. The card takes a longer cut of the same text.
   */
  function summary(item: StreamItem, limit = 160): string {
    return plainPreview(item.summary?.content ?? item.content?.content, limit);
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

  /**
   * A post's pictures, when it has more than one.
   *
   * Comics Kingdom publishes a strip as separate "Panel 1", "Panel 2" images
   * and a webcomic can be a page of several; either way the card used to show
   * the first and hide the rest. Cards now flip through them instead of opening
   * the post. A single-picture post is not in this map at all.
   */
  const pictureLists = new WeakMap<StreamItem, string[]>();

  function pictures(item: StreamItem): string[] {
    if (view !== "cards") return [];
    const known = pictureLists.get(item);
    if (known !== undefined) return known;
    const panels = panelsOf(item as ThumbSource);
    const found = panels.length > 1 ? panels : imagesOf(item as ThumbSource);
    const list = found.length > 1 ? found : [];
    pictureLists.set(item, list);
    return list;
  }

  /**
   * How wide each of a card's pictures is, against the widest one in the post.
   *
   * Comics Kingdom draws the panels of one strip at different pixel widths —
   * Hagar's are 997 and 933 — so fitting each to the card's width drew the
   * narrower panel at a slightly larger scale and the comic jumped in size when
   * flipped. Scaling every picture by the same factor keeps one zoom for the
   * whole strip; the narrower panel is simply narrower on the card.
   */
  let stripScales = $state<Record<string, { widest: number; widths: number[] }>>({});
  const measuredStrips = new Set<string>();

  function measureStrip(item: StreamItem, list: string[]): void {
    if (measuredStrips.has(item.id)) return;
    measuredStrips.add(item.id);
    void Promise.all(
      list.map(
        (src) =>
          new Promise<number | null>((resolve) => {
            const probe = new Image();
            probe.referrerPolicy = "no-referrer";
            probe.onload = () => resolve(probe.naturalWidth || null);
            probe.onerror = () => resolve(null);
            probe.src = src;
          }),
      ),
    ).then((widths) => {
      const known = widths.filter((width): width is number => width !== null);
      if (known.length === 0) return;
      const widest = Math.max(...known);
      stripScales = {
        ...stripScales,
        [item.id]: { widest, widths: widths.map((width) => width ?? widest) },
      };
    });
  }

  /** Which picture of the post is showing; a post is at its first until flipped. */
  let pages = $state<Record<string, number>>({});

  function pageOf(item: StreamItem, count: number): number {
    return Math.min(Math.max(pages[item.id] ?? 0, 0), count - 1);
  }

  /**
   * Dragging a card sideways turns its pictures.
   *
   * The pointer has to travel horizontally further than it travels vertically
   * before this counts as a swipe, or scrolling the list would turn pages. A
   * swipe also has to swallow the click that follows it: the card is one big
   * button, and finishing a drag over the picture must not open the post.
   */
  const SWIPE_START = 12;
  const SWIPE_TURN = 36;
  let dragging: { x: number; y: number; sideways: boolean } | null = null;
  let swipeAt = 0;

  function dragStart(event: PointerEvent, count: number): void {
    if (count < 2 || (event.pointerType === "mouse" && event.button !== 0)) return;
    dragging = { x: event.clientX, y: event.clientY, sideways: false };
  }

  function dragMove(event: PointerEvent): void {
    if (dragging === null) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (!dragging.sideways) {
      if (Math.abs(dx) < SWIPE_START && Math.abs(dy) < SWIPE_START) return;
      // Mostly vertical: this is the list scrolling, not a page turn.
      if (Math.abs(dx) <= Math.abs(dy)) {
        dragging = null;
        return;
      }
      dragging.sideways = true;
    }
    event.preventDefault();
  }

  function dragEnd(event: PointerEvent, item: StreamItem, count: number): void {
    const moved = dragging;
    dragging = null;
    if (moved === null || !moved.sideways) return;
    const dx = event.clientX - moved.x;
    if (Math.abs(dx) < SWIPE_TURN) return;
    flip(event, item, count, dx < 0 ? 1 : -1);
    swipeAt = Date.now();
  }

  /**
   * The swipe, as an action rather than handler attributes: the row is a plain
   * element holding the card's button, and listeners say what they are without
   * asking the row to claim a role it does not have.
   */
  function swipePages(node: HTMLElement, initial: { item: StreamItem; count: number }) {
    let params = initial;
    const down = (event: PointerEvent) => dragStart(event, params.count);
    const move = (event: PointerEvent) => dragMove(event);
    const up = (event: PointerEvent) => dragEnd(event, params.item, params.count);
    const cancel = () => {
      dragging = null;
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
    return {
      update(next: { item: StreamItem; count: number }) {
        params = next;
      },
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
      },
    };
  }

  /** A click within a moment of a swipe is the end of that swipe, not a tap. */
  function openedByTap(item: StreamItem): void {
    if (Date.now() - swipeAt < 400) return;
    open(item);
  }

  /**
   * Step the card's pictures without opening the post.
   *
   * The card is one big button, so a click on a clicker has to stop there or
   * flipping a strip would open the article instead.
   */
  function keyFlip(event: KeyboardEvent, item: StreamItem, count: number, step: number): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    flip(event, item, count, step);
  }

  function flip(event: Event, item: StreamItem, count: number, step: number): void {
    event.preventDefault();
    event.stopPropagation();
    pages = { ...pages, [item.id]: (pageOf(item, count) + step + count) % count };
  }

  function fail(id: string): void {
    broken = [...broken, id];
  }

  /**
   * A picture sharpened to full size that the publisher then refuses falls back
   * to the crop the feed named: a small comic beats no comic.
   */
  let downgraded = $state<Record<string, string>>({});

  function shown(url: string): string {
    return downgraded[url] ?? url;
  }

  function refuse(item: StreamItem, event: Event, url: string): void {
    const crop = cropVariant(url);
    if (crop !== null && downgraded[url] === undefined) {
      downgraded = { ...downgraded, [url]: crop };
      return;
    }
    if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.src = "";
    fail(item.id);
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

  /*
   * Cards that have been asked to load ahead of being scrolled to.
   *
   * The observer only calls a row near when it comes within 400px of the port,
   * which a card taller than the pane never is: step onto one of those and you
   * landed on a blank card that then filled in. Stepping knows exactly which
   * card is next, so it can say so first — and only the next one or two are
   * ever held, so a long feed does not load forty full-size pictures.
   */
  let aheadIds = $state<Record<string, true>>({});

  /** Load the pictures of the posts that come after this one. */
  function prefetchFrom(id: string | undefined): void {
    const items = reader.listItems;
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      aheadIds = {};
      return;
    }
    const next: Record<string, true> = {};
    for (const step of [1, 2]) {
      const item = items[index + step];
      if (!item) continue;
      next[item.id] = true;
      warm(item);
    }
    aheadIds = next;
  }

  const loadNow = (id: string): boolean => nearIds[id] === true || aheadIds[id] === true;

  /*
   * Files being fetched for a card that has not been scrolled to yet. The
   * references are held because an `Image` with no other handle can be
   * collected, and a collected prefetch takes its request with it.
   */
  const warming: HTMLImageElement[] = [];

  /** Start the fetch the card will want, so arriving there is not a blank. */
  function warm(item: StreamItem): void {
    const first = pictures(item)[0] ?? thumbnail(item);
    if (first === null || first === undefined || first === "") return;
    const img = new Image();
    img.decoding = "async";
    img.src = shown(first);
    warming.push(img);
    if (warming.length > 4) warming.shift();
  }
  const markNear = (id: string, isNear: boolean): void => {
    if ((nearIds[id] === true) === isNear) return;
    if (isNear) nearIds[id] = true;
    else delete nearIds[id];
  };

  /** The scroll port the rows are measured against. */
  let itemsEl = $state<HTMLElement | null>(null);

  /*
   * Cards are pages, and scrolling one should hand you the next whole card, not
   * half of two. The card list therefore reads its wheel the way the article
   * pane does — the same pull, the same curve, the same effort setting and the
   * same settle delay — but its "end" is the bottom of the card you are looking
   * at rather than the bottom of a document. Travel past that end fills a pull;
   * filling it steps one card and puts it at the top of the list.
   */
  let listPull = $state(0);
  let listPullTimer: ReturnType<typeof setTimeout> | null = null;
  let listSettleUntil = 0;
  const listThreshold = $derived(thresholdFor(reading.scrollEffort));

  function resetListPull(): void {
    listPull = 0;
    if (listPullTimer !== null) {
      clearTimeout(listPullTimer);
      listPullTimer = null;
    }
  }

  /** The rows, in order, as elements carrying their post's id. */
  function cardRows(): HTMLElement[] {
    const el = itemsEl;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(".row[data-id]"));
  }

  /**
   * The card in the middle of the pane: the one being read.
   *
   * Cards sit centred with their neighbours peeking, so "the first row whose
   * bottom is below the top edge" would name the card peeking above instead of
   * the one you are looking at. What is in the middle is the answer.
   */
  function currentCard(): HTMLElement | null {
    const el = itemsEl;
    if (!el) return null;
    const middle = el.getBoundingClientRect().top + el.clientHeight / 2;
    const rows = cardRows();
    return rows.find((row) => row.getBoundingClientRect().bottom > middle) ?? rows.at(-1) ?? null;
  }

  /** A card that fits the pane, so the whole of it is on screen at once. */
  function cardFits(row: HTMLElement): boolean {
    const el = itemsEl;
    if (!el) return false;
    return row.getBoundingClientRect().height <= el.clientHeight + 1;
  }

  /**
   * Whether the card in the middle is too tall for the pane.
   *
   * Snapping is a promise that letting go finishes the gesture: the card you
   * were halfway through becomes the card you are on. That promise is wrong for
   * a strip taller than the pane, where letting go mid-comic must stay
   * mid-comic. So the column drops scroll snapping while one of those is in the
   * middle and takes it back when the next card fits. The CSS reads this off a
   * data attribute; the value only changes when it has to.
   */
  let tallCard = $state(false);
  let snapFrame = 0;

  function syncSnap(): void {
    const card = view === "cards" ? currentCard() : null;
    tallCard = !!card && !cardFits(card);
  }

  function onCardsScroll(): void {
    if (view !== "cards" || snapFrame) return;
    snapFrame = requestAnimationFrame(() => {
      snapFrame = 0;
      syncSnap();
    });
  }

  // A view switch, a new stream or a resize puts different cards under the same
  // scroll port, and none of them fire a scroll event of their own.
  $effect(() => {
    void view;
    void reader.items.length;
    if (view !== "cards") {
      tallCard = false;
      return;
    }
    const frame = requestAnimationFrame(syncSnap);
    return () => cancelAnimationFrame(frame);
  });

  /**
   * Step one card and bring it to the middle of the pane.
   *
   * Scrolling the list moves the list. It does not open anything: a post opens
   * when it is clicked, so stepping through cards never drags you into the
   * article, and on a phone — where there is one pane and opening a post leaves
   * the list — it does not take you off the list at all.
   */
  function stepCard(direction: 1 | -1): void {
    const rows = cardRows();
    if (rows.length === 0) return;
    const current = currentCard() ?? rows[0];
    const index = Math.max(rows.indexOf(current), 0);
    const target = rows[Math.min(Math.max(index + direction, 0), rows.length - 1)];
    if (!target || target === current) return;
    // Its picture starts loading before the scroll moves, not after it lands.
    prefetchFrom(target.dataset.id ?? undefined);
    centreCard(target);
    syncSnap();
  }

  /**
   * Put a card in the middle of the pane, so the ones either side of it stay
   * half in view and the column reads as a strip you are moving along rather
   * than a page you are jumping to.
   *
   * A card taller than the pane cannot be centred without cutting its top,
   * which for a comic is the end you have to start from, so that one is aligned
   * to the top instead and read by scrolling it.
   */
  function centreCard(card: HTMLElement): void {
    const el = itemsEl;
    if (!el) return;
    const port = el.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const offset = box.top - port.top;
    if (box.height > el.clientHeight) {
      el.scrollTop += offset;
      return;
    }
    el.scrollTop += offset - (el.clientHeight - box.height) / 2;
  }

  /**
   * The wheel is listened to explicitly, not through the `onwheel` attribute: a
   * delta that becomes a pull must not also scroll the list underneath it, and
   * that needs a non-passive listener.
   */
  function cardWheel(el: HTMLElement) {
    el.addEventListener("wheel", onListWheel, { passive: false });
    return {
      destroy() {
        el.removeEventListener("wheel", onListWheel);
        resetListPull();
      },
    };
  }

  function onListWheel(event: WheelEvent): void {
    const el = itemsEl;
    if (view !== "cards" || !reading.advanceOnScroll || !el || event.deltaY === 0) {
      resetListPull();
      return;
    }
    const row = currentCard();
    // A card that fits the pane is one you look at whole, so a wheel past it
    // steps. A card taller than the pane is read by scrolling it, and there the
    // wheel belongs to the scroll.
    if (!row || !cardFits(row)) {
      resetListPull();
      return;
    }
    // From here every delta belongs to the step, so the list must not also move.
    // This includes the deltas during the settle window: those used to fall
    // through without being stopped, so the list scrolled natively underneath
    // the step the handler had just made — one flick crossed five cards and
    // then snapped back onto whichever one it happened to land near.
    event.preventDefault();
    if (performance.now() < listSettleUntil) {
      // Same gesture still arriving. Hold the step until the wheel is quiet,
      // rather than counting the rest of the gesture as a second one.
      listSettleUntil = performance.now() + SETTLE_MS;
      resetListPull();
      return;
    }
    listPull = accumulate(listPull, event.deltaY, listThreshold);
    if (listPullTimer !== null) clearTimeout(listPullTimer);
    listPullTimer = setTimeout(() => {
      listPull = 0;
      listPullTimer = null;
    }, 700);
    if (!shouldAdvance(listPull, listThreshold)) return;
    const direction = listPull > 0 ? 1 : -1;
    resetListPull();
    listSettleUntil = performance.now() + SETTLE_MS;
    stepCard(direction);
  }

  /**
   * The card's picture window is a comic page's shape and the picture is fitted
   * inside it, so no post loses its edges — see `CARD_WINDOW`. That makes the
   * picture the same shape for every post, which is why nothing here measures an
   * image at load any more: a page, a photograph and a poster all get the whole
   * window, letterboxed, at the size the S/M/L control asked for.
   */

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
        {:else if reading.articleFilter === "all" && reader.authorFilter === null}
          {reader.listItems.length} item{reader.listItems.length === 1 ? "" : "s"}
        {:else}
          {reader.listItems.length} of {reader.items.length}
        {/if}
      </span>
    </div>

    <!-- A narrowed list says what narrowed it, in the column it narrowed: the
         field that set this can be a pane away, and a short list with no reason
         on it reads as posts that have gone missing. The button is the way back
         from here, as the sidebar's own row is from there. -->
    {#if reader.authorFilter !== null}
      <div class="byline-filter">
        <span class="byline-name">Only posts by <b>{reader.authorFilter}</b></span>
        <button
          class="byline-clear"
          title="Show every post in this stream again"
          onclick={() => reader.setAuthorFilter(null)}
        >Show all</button>
      </div>
    {/if}

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
        <!-- Four buttons became a ruler: two to eight is nine answers, and nine
             buttons do not fit in a 240px column beside the view icons and the
             filter pills. `auto` stays a button of its own, because it is not a
             number of tiles — it is "as many as fit" and must not be reachable
             by dragging past the end of a range. -->
        <div class="sizer" role="group" aria-label="Tiles per row">
          <button
            class="sizebtn"
            class:on={reading.gridColumns === "auto"}
            aria-pressed={reading.gridColumns === "auto"}
            title="As many tiles as fit, the size they have always been"
            onclick={() => reading.setGridColumns("auto")}
          >auto</button
          >
          <label
            class="ruler"
            title={`${gridColumnValue(reading.gridColumns)} tiles across: fewer, larger squares`}
          >
            <input
              type="range"
              min={GRID_COLUMN_MIN}
              max={GRID_COLUMN_MAX}
              step="1"
              value={gridColumnValue(reading.gridColumns)}
              aria-label="Tiles across"
              oninput={(event) => reading.setGridColumns(Number(event.currentTarget.value))}
            />
            <span class="count" class:auto={reading.gridColumns === "auto"}
              >{gridColumnValue(reading.gridColumns)}</span
            >
          </label>
        </div>
      {:else if view === "cards"}
        <!-- Cards have one pick, and only in the view it applies to: the
             masonry button, and the column count once it is on. There is no
             picture-size setting: every card is drawn at the one window (a page
             and a half of its own width). A height setting can only shorten a
             picture that is taller than it — it cannot give a wide strip more
             room — so the three shapes did nothing for the case they were
             named after. -->
        <div
          class="sizer"
          role="group"
          aria-label="Masonry columns"
        >
          <button
            class="sizebtn masonry"
            class:on={cardLayout.masonry}
            aria-pressed={cardLayout.masonry}
            aria-label="Masonry"
            title={CARD_LAYOUT_TITLES[cardLayout.mode]}
            onclick={() => cardLayout.toggleMasonry()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"
              ><rect x="2.4" y="2.4" width="3.1" height="7" rx="1" /><rect
                x="6.45"
                y="2.4"
                width="3.1"
                height="11.2"
                rx="1"
              /><rect x="10.5" y="2.4" width="3.1" height="5" rx="1" /></svg
            >
          </button>
          {#if cardLayout.masonry}
            {#each MASONRY_COLUMN_CHOICES as count (count)}
              <button
                class="sizebtn"
                class:on={cardLayout.columns === count}
                aria-pressed={cardLayout.columns === count}
                aria-label={`${count} columns`}
                title={`${count} columns: pictures at their own height`}
                onclick={() => cardLayout.setColumns(count)}
              >{count}</button
              >
            {/each}
          {/if}
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
    class:masonry={view === "cards" && cardLayout.masonry}
    data-tallcard={tallCard ? "true" : undefined}
    onscroll={onCardsScroll}
    class:grid={view === "grid"}
    class:square={view === "grid" && gridIsSquare(reading.gridColumns)}
    style:--grid-template={gridTemplate(reading.gridColumns)}
    style:--card-window={`${(CARD_WINDOW.auto * reading.thumbScale).toFixed(3)}`}
    style:--masonry-columns={masonryTrack(cardLayout.columns)}
    use:cardWheel
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
      {@const strip = picture === null ? [] : pictures(item)}
      {@const page = strip.length > 1 ? pageOf(item, strip.length) : 0}
      {@const scale = strip.length > 1 ? (measureStrip(item, strip), stripScales[item.id]) : undefined}
      {@const placement = picture === null ? "none" : picturePlacement(view)}
      <!-- A feed whose posts are pictures has no text to preview; the row keeps
           its shape rather than reserving a blank line under the headline. -->
      {@const blurb = summary(item, view === "cards" ? 320 : 160)}
      <div
        class="row"
        class:selected={reader.selectedId === item.id}
        class:read={isRead(item)}
        class:stacked={placement === "top"}
        data-id={item.id}
        use:near={{ root: itemsEl, near: (isNear: boolean) => markNear(item.id, isNear) }}
        use:swipePages={{ item, count: strip.length }}
        style:--flip-edge={reading.flipEdge}
      >
        <button class="item" onclick={() => openedByTap(item)}>
          {#if placement === "top"}
            <span class="lead" aria-hidden="true">
              {#if loadNow(item.id)}
                {#if strip.length > 1}
                  <img
                    class="panel"
                    style:width={scale === undefined ? null : `${(scale.widths[page] / scale.widest) * 100}%`}
                    src={shown(strip[page])}
                    alt=""
                    loading={aheadIds[item.id] ? "eager" : "lazy"}
                    decoding="async"
                    referrerpolicy="no-referrer"
                    draggable="false"
                    onerror={(event) => refuse(item, event, strip[page])}
                  />
                {:else}
                  <img
                    src={shown(picture ?? "")}
                    alt=""
                    loading={aheadIds[item.id] ? "eager" : "lazy"}
                    decoding="async"
                    referrerpolicy="no-referrer"
                    draggable="false"
                    onerror={(event) => refuse(item, event, picture ?? "")}
                  />
                {/if}
              {/if}
            </span>
          {/if}
          <span class="body">
            <span class="line">
              <!-- Only the one-line view carries the marker: in Regular rows and
                   on a card it took a dot's width off the headline's left edge,
                   which is the edge of the pane. Those say whether a post is
                   read with the row itself. -->
              {#if view === "list"}
                <span class="dot" class:hidden={isRead(item)} aria-hidden="true"></span>
              {/if}
              <span class="title">{item.title || "(untitled)"}</span>
            </span>
            {#if showsPreview(view) && blurb !== ""}
              <span class="preview">{blurb}</span>
            {/if}
            <span class="byline">
              {#if view === "cards"}
                <!-- The row has one line and must choose between the author and
                     the feed; the card has room for both, and where a post came
                     from is part of what a card is for. -->
                <span class="feed-name" title={bylineTitle(item)}>{feedNameOf(item) || bylineOf(item)}</span>
                {#if authorOf(item) !== "" && authorOf(item) !== feedNameOf(item)}
                  <span class="author-name" title={`By ${authorOf(item)}`}>{authorOf(item)}</span>
                {/if}
              {:else}
                <span class="feed-name" title={bylineTitle(item)}>{bylineOf(item)}</span>
              {/if}
              <span class="time">{relativeTime(item.timestampUsec, item.published)}</span>
            </span>
          </span>
          {#if placement === "side"}
            <span class="thumb" class:left={reading.thumbSide === "left"} aria-hidden="true">
              {#if loadNow(item.id)}
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
        {#if strip.length > 1}
          <!-- The page count sits with the words, not on the comic: one pip per
               picture, the current one filled. -->
          <div class="pips" aria-hidden="true">
            {#each strip as _, index (index)}
              <span class="pip" class:on={index === page}></span>
            {/each}
          </div>
          <!-- Invisible edges: the outer fifth of the card flips, the middle
               still opens the post. -->
          <span class="edge back" role="button" tabindex="-1" aria-label="Previous picture"
            onclick={(event) => flip(event, item, strip.length, -1)}
            onkeydown={(event) => keyFlip(event, item, strip.length, -1)}></span>
          <span class="edge on" role="button" tabindex="-1" aria-label="Next picture"
            onclick={(event) => flip(event, item, strip.length, 1)}
            onkeydown={(event) => keyFlip(event, item, strip.length, 1)}></span>
        {/if}
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
        {#if reader.authorFilter !== null && reader.items.length > 0}
          Nothing in this stream by {reader.authorFilter}.
        {:else if reader.items.length > 0}
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
  <div
    class="list-pull"
    class:visible={listPull !== 0}
    class:up={listPull < 0}
    style:--p={progressOf(listPull, listThreshold)}
    aria-hidden="true"
  ></div>
</section>

<style>
  .headline {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  /* One quiet line under the title: what narrowed the list, and the way back.
     A row rather than a badge, because the button has to be pressable with the
     same thumb that picked the author. Full-width and last, so it sits on its
     own line beneath the title and the view bar instead of being squeezed
     between them. */
  .headline {
    order: 1;
  }

  .bar {
    order: 2;
  }

  .byline-filter {
    order: 3;
    flex: 1 0 100%;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    margin-top: -2px;
    font-size: 11px;
    color: var(--muted);
  }

  .byline-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .byline-name b {
    color: var(--text-dim);
    font-weight: 600;
  }

  .byline-clear {
    flex: none;
    padding: 0 4px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .byline-clear:hover {
    background: var(--hover);
    text-decoration: underline;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  /* The card list's pull, drawn exactly where the article's is: a line filling
     along the pane's edge, from the bottom for the next card and the top for the
     previous one. Same colour, same thickness, so the gesture reads as one. */
  .list-pull {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 4;
    height: 3px;
    transform: scaleX(var(--p, 0));
    transform-origin: left center;
    background: var(--accent);
    opacity: 0;
    pointer-events: none;
    transition: transform 80ms linear, opacity 120ms ease;
  }

  .list-pull.visible {
    opacity: 0.9;
  }

  .list-pull.up {
    top: 0;
    bottom: auto;
    transform-origin: right center;
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

  /* The grid's count: a ruler 2..8, with the number it is on beside it. 66px of
     track is enough for seven stops to be distinguishable by dragging, and the
     readout means the exact value is never a guess. */
  .ruler {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 3px 0 2px;
    cursor: pointer;
  }

  .ruler input[type="range"] {
    width: 66px;
    height: 14px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .ruler .count {
    min-width: 9px;
    color: var(--text);
    font-size: 10.5px;
    line-height: 16px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  /* While the grid is `auto` the number is a preview of where the ruler sits,
     not a count in force, so it reads as a hint rather than a setting. */
  .ruler .count.auto {
    color: var(--muted);
  }

  /* The masonry pick, at the left of the same group: three staggered bars, the
     shape of the thing it switches to. It carries no text, so it is the one
     control in the sizer that has to be reachable by its aria-label. */
  .sizebtn.masonry {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 3px;
  }

  .sizebtn.masonry svg {
    width: 11px;
    height: 11px;
    fill: currentColor;
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
    position: relative;
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
    /* A nested list is sized by its posts, not by a pane, so it must not be a
       size container: containment would size it as if it were empty and the
       posts would draw over whatever is beneath them. */
    container-type: normal;
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
    padding-bottom: 12px;
    /* The scroll port is the measure of "how much you can see", so a picture
       can be capped against it rather than against the window: in a three-pane
       desktop window the list is most of the height, on a phone it is all of
       it, and 50cqh means the same thing in both. */
    container-type: size;
  }

  /* The bar the list is made of. One row per post, whichever shape it takes. */
  .row {
    position: relative;
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border-soft);
  }

  /* Unread is said by the row, not beside the headline: an accent hairline on
     the bottom rim, with the faintest glow above it so it reads at a glance
     without becoming a bar. Read rows have no rim and step back as a whole —
     the title alone dimming was not enough to pick a row out at speed. The same
     two marks carry over to Cards, so a post looks read in every view of it. */
  .row:not(.read) {
    box-shadow:
      inset 0 -1px 0 color-mix(in srgb, var(--accent) 62%, transparent),
      inset 0 -7px 12px -9px color-mix(in srgb, var(--accent) 45%, transparent);
  }

  /* The trim: in a row the accent does not stop at the bottom hairline, it
     turns. One hairline along the bottom, an edge up the right, and at both ends
     of that edge the turn is filled out to the row's own corner, so the accent
     finishes in two lit corners instead of two drawn ends.

     Weight is the whole trick here. The edge is 2px against the 1px hairline,
     the turn is 13px rather than a quarter of the row, and the stretch between
     the corners is barely there — so a column of unread rows reads as a bright
     foot and a faint thread up the side, not as a fence. Everything is
     background layers on one element: a border cannot paint past its own radius,
     and a mask cannot be solid at each end and whisper in the middle. */
  .items:not(.compact):not(.cards):not(.grid) .row:not(.read) {
    --trim-r: 13px;
  }

  .items:not(.compact):not(.cards):not(.grid) .row:not(.read)::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      /* the bottom turn, filled out to the corner point */
      radial-gradient(
          circle at 0 0,
          transparent 0 calc(var(--trim-r) - 0.5px),
          color-mix(in srgb, var(--accent) 80%, transparent) calc(var(--trim-r) - 0.5px)
        )
        bottom right / var(--trim-r) var(--trim-r) no-repeat,
      /* the top turn, the same shape upside down and quieter */
      radial-gradient(
          circle at 0 100%,
          transparent 0 calc(var(--trim-r) - 0.5px),
          color-mix(in srgb, var(--accent) 42%, transparent) calc(var(--trim-r) - 0.5px)
        )
        top right / var(--trim-r) var(--trim-r) no-repeat,
      /* the edge between them: bright where it leaves the foot, a thread halfway
         up, a quiet cap at the top */
      linear-gradient(
          to top,
          color-mix(in srgb, var(--accent) 88%, transparent) 0,
          color-mix(in srgb, var(--accent) 88%, transparent) var(--trim-r),
          color-mix(in srgb, var(--accent) 14%, transparent) 46%,
          color-mix(in srgb, var(--accent) 34%, transparent) calc(100% - var(--trim-r)),
          color-mix(in srgb, var(--accent) 42%, transparent) 100%
        )
        right / 2px 100% no-repeat,
      /* the top turn gets a return, or it reads as the start of a frame that was
         never finished: a short stub running left and dissolving, which is what
         makes the upper corner look deliberate rather than clipped */
      linear-gradient(
          to left,
          color-mix(in srgb, var(--accent) 40%, transparent),
          color-mix(in srgb, var(--accent) 40%, transparent) 6px,
          transparent 92px
        )
        top right / 92px 1px no-repeat,
      /* the hairline along the bottom: full strength where it meets the foot,
         easing off towards the thumbnail so the row is marked, not boxed */
      linear-gradient(
          to left,
          color-mix(in srgb, var(--accent) 58%, transparent) 0%,
          color-mix(in srgb, var(--accent) 50%, transparent) 26%,
          color-mix(in srgb, var(--accent) 30%, transparent) 100%
        )
        bottom left / 100% 1px no-repeat;
  }

  .row.read {
    opacity: 0.48;
  }

  .row.read:hover,
  .row.read.selected {
    opacity: 0.85;
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
    padding: calc(6px * var(--row-scale, 1)) 6px;
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
    /* Star and read are two targets on one line, not a column: a stacked pair
       costs a row its height and puts one of them where the thumb is not. */
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 8px;
    /* Away from the pane's edge, which a target should not hug. */
    padding: 2px 28px 2px 0;
  }

  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
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
    width: 16px;
    height: 16px;
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

    /* The list's toggles are thumb targets on a phone, not pointer targets. */
    .compact .act {
      width: 30px;
      height: 30px;
    }

    .compact .act svg {
      width: 18px;
      height: 18px;
    }
  }

  /* ---------------------------------------------------------------- list --
     One line per post: the headline, the feed and the time. No preview, no
     picture — that is the trade for fitting twice as many on a screen. */
  .compact .item {
    /* The row's own gutter is small on purpose: a list row is a line of text and
       every pixel of side padding is a pixel of headline lost. The toggles'
       clearance is made on the other side of the row, not here. */
    padding: calc(6px * var(--row-scale, 1)) 8px;
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
    gap: 4px;
    /* Away from the pane's edge: a target that hugs the margin is both easy to
       miss and easy to hit by accident while scrolling. */
    padding: 2px 16px 2px 0;
  }

  .compact .act {
    width: 24px;
    height: 24px;
    border-radius: 6px;
  }

  .compact .act svg {
    width: 16px;
    height: 16px;
  }

  /* --------------------------------------------------------------- cards --
     The picture gets the width and the headline sits under it. */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* No scrollbar gutter: a comic card is the widest thing in the app and the
       classic bar costs it 15px of picture on every desktop. Scrolling is
       unchanged — the wheel, the pull and the keys all still work — only the
       drawn bar goes. */
    scrollbar-width: none;
    /* A finger has no wheel. The wheel steps one card and centres it, so the
       column lands with the next card's top edge just in view; a flick has no
       such thing and stopped wherever momentum died, usually with two cards
       half-shown. Proximity rather than mandatory: a comic taller than the pane
       still has to be scrolled through by hand, and a mandatory snap would keep
       dragging it back to its own middle. */
    scroll-snap-type: y proximity;
    /* A card is the pane: no gutter down the sides, and none above the first or
       below the last, so its four edges sit on the same margin. The gap between
       cards is the only space in the column, which is why stepping one card puts
       it exactly on the top edge instead of ten pixels below it. */
    padding: 0;
  }

  .cards::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  /* A card taller than the pane is read by scrolling it, so it is exempt: the
     list drops snapping while one is the card in the middle, and takes it back
     when the next one fits. */
  .cards[data-tallcard="true"] {
    scroll-snap-type: none;
  }

  /* A finger has no pull to measure, so the sleight of hand the wheel gets from
     the settle window does not exist: one flick used to carry three or four
     cards and the snap then picked whichever it happened to stop near. Stopping
     the fling at every snap point gives the thumb the same promise the wheel
     makes — one push, one card — without touching a slow deliberate drag, which
     still scrolls the column. Measured on the Archie panels in a 390×740 phone
     viewport: a 300px flick went from three cards to one, and a 140px push no
     longer left the card at all. */
  @media (pointer: coarse) {
    .cards .row {
      scroll-snap-stop: always;
    }
  }

  .cards .row {
    /* The cards column is a flex container inside a scroll port with a definite
       height, so without this every row shrinks to nothing as if it were meant
       to fit: 40 posts became 40 slivers, and `loading="lazy"` had no reason to
       hold anything back because everything was "in view". */
    flex: none;
    /* The same place the wheel steps to, so a thumb and a mouse land alike. */
    scroll-snap-align: center;
    border-block: 1px solid var(--border-soft);
    border-inline: 0;
    border-radius: 0;
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

  /**
   * The card's picture window is one shape for every post — a comic page's 5:7.5
   * — and the picture is fitted inside it rather than cropped into it.
   *
   * Cards used to crop each lead to a 16:9 band, which is right for a photograph
   * beside a headline and destroys a page of comics: the top and bottom were
   * simply gone until the article was opened. `contain` shows the whole file,
   * whatever its shape, as large as the window allows; the S/M/L control sizes
   * the window's width and the aspect gives the height, so a card is a page.
   */
  .cards .lead {
    /* A flex child of the column, like the row was: without `flex: none` the
       picture is what gets shrunk to make the card fit, so every card lost its
       image and the row was text-only. */
    flex: none;
    display: block;
    /* The column's whole width: a page is read at the width it has. `inline-size`
       containment gives the picture a way to cap itself against this width, so a
       page taller than a page-and-a-half shrinks to fit instead of running on. */
    width: 100%;
    container-type: inline-size;
    overflow: hidden;
    background: var(--bg);
  }

  .cards .lead img {
    /* A picture fills the card's width and keeps its own height, whatever its
       shape. Capping the height is what put the blank bars down the sides of a
       tall strip: the box stayed as wide as the card, the picture inside it was
       narrower than that, and `contain` centred it with air either side. A
       vertical strip is meant to be read tall, so nothing here shortens it. */
    display: block;
    width: 100%;
    height: auto;
    object-fit: contain;
    margin-inline: auto;
  }

  /* A post with several pictures shows one at a time with clickers and pips over
     it — the same picture area a single-picture card has, so the list keeps its
     rhythm instead of one comic becoming a tower. */
  .cards .lead .panel {
    display: block;
    /* The width is written per page so every picture in one card shares a zoom;
       the height follows the picture, so a tall page is not squeezed into a
       window and left with air either side. */
    width: 100%;
    height: auto;
    object-fit: contain;
    margin-inline: auto;
  }

  /* The pager is over the card's words, not over its picture: the comic is the
     thing being read, so nothing is drawn on top of it. */
  .cards .pips {
    position: absolute;
    bottom: calc(11px * var(--row-scale, 1));
    left: 0;
    right: 0;
    z-index: 2;
    display: flex;
    justify-content: center;
    gap: 5px;
    pointer-events: none;
  }

  .cards .pip {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--edge);
  }

  .cards .pip.on {
    background: var(--accent);
  }

  /* The clickers are invisible: the outer fifth of the card flips, and a click
     in the middle is the card's own click, which opens the post. */
  .cards .row {
    touch-action: pan-y;
  }

  .cards .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 3;
    /* How much of the card turns the page; the middle opens the post. */
    width: calc(var(--flip-edge, 10) * 1%);
    cursor: pointer;
  }

  .cards .edge.back {
    left: 0;
  }

  .cards .edge.on {
    right: 0;
  }

  /* The star and read toggles sit in the right fifth, so they stay clickable
     above the flip zone. */
  .cards .acts {
    z-index: 4;
  }

  @media (pointer: coarse) {
    .cards .pip {
      width: 7px;
      height: 7px;
    }
  }


  .cards .body {
    /* Compact: the picture is the reason to look at a card, so the words under
       it take as little of the card as they can and still be read. */
    gap: calc(4px * var(--row-scale, 1));
    /* The right padding is the toggles' corner: they sit in the body's last
       line, and a byline that ran under them would be text behind a button. */
    padding: calc(8px * var(--row-scale, 1)) calc(84px * var(--row-scale, 1))
      calc(8px * var(--row-scale, 1)) calc(10px * var(--row-scale, 1));
  }

  /* The card's headline is the reason to stop scrolling, so it is bigger than a
     row's and allowed a third line; the row's two-line clamp at 13.5px was sized
     for a 48px picture beside it, not for a comic page above it. */
  .cards .title {
    font-size: calc(15px * var(--row-scale, 1));
    line-height: 1.24;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  /* Four lines of the post under the headline: the part of the article a card is
     for. The row's two-line clamp stays as it is — that shape has one line of
     room and a picture eating a third of the width. */
  .cards .preview {
    font-size: calc(12.5px * var(--row-scale, 1));
    line-height: 1.38;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .cards .byline {
    margin-top: calc(2px * var(--row-scale, 1));
    font-size: calc(11.5px * var(--row-scale, 1));
  }

  /* The author, beside the feed rather than instead of it. The feed keeps a cap
     and the author takes what is left and shrinks, so the time cannot be pushed
     out of a narrow card by two long names. */
  .cards .feed-name {
    max-width: 45%;
  }

  .cards .author-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }

  /* Grid keeps its toggles on the picture: a grid tile is one square of picture
     with a line of text under it, and there is nowhere else to put them. */
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

  /* A card's picture is the post — a page of comics, a photograph — and the
     two toggles sat on top of it, covering the corner of exactly the thing the
     card exists to show. They belong in the card's own text: bottom right of
     the body, where the byline is, at a size that is a target rather than a
     hairline. The body reserves the room so no line of text runs under them. */
  .cards .acts {
    position: absolute;
    top: auto;
    bottom: calc(8px * var(--row-scale, 1));
    right: calc(12px * var(--row-scale, 1));
    flex-direction: row;
    align-items: center;
    gap: calc(8px * var(--row-scale, 1));
    padding: 0;
    background: none;
  }

  .cards .act {
    width: calc(30px * var(--row-scale, 1));
    height: calc(30px * var(--row-scale, 1));
    border-radius: 6px;
    opacity: 0.7;
  }

  .cards .act svg {
    width: calc(18px * var(--row-scale, 1));
    height: calc(18px * var(--row-scale, 1));
  }

  .cards .row:hover .act,
  .cards .act.on,
  .cards .act:focus-visible {
    opacity: 1;
  }

  /* The rule above is more specific than the coarse-pointer block further up,
     so cards would otherwise shrink a thumb target back to 26px. */
  @media (pointer: coarse) {
    .cards .act {
      width: 38px;
      height: 38px;
    }

    .cards .act svg {
      width: 20px;
      height: 20px;
    }

    .cards .body {
      padding-right: calc(108px * var(--row-scale, 1));
    }
  }

  /*
   * The list row's two toggles, side by side rather than stacked, with air
   * between them and a margin of their own from the pane's edge.
   *
   * Declared with the extra `.items` class so it outranks every column rule
   * above it, whatever order the rest of the sheet ends up in: star and read
   * are two targets on one line, and a stacked pair is one thumb-width of dead
   * space in a view whose whole point is fitting lines.
   */
  .items.compact .acts {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 2px 28px 2px 0;
  }

  /* A masonry column is a wall of cards, not a strip of them: each one is a
     snap point a few tens of pixels from the next, and snapping would stop the
     scroll every inch. It sits with the masonry rules, after the card rules it
     overrides. */
  .cards.masonry {
    scroll-snap-type: none;
  }

  /* ------------------------------------------------------------- masonry --
     Pinterest columns inside Cards: the same card — picture, headline,
     byline, star and read — arranged so each picture keeps its own height,
     which is what makes the columns interlock instead of ending level.

     This is a pick inside Cards, not a fifth view. Rows mode is untouched
     above: the one comic-page window, at the size the S/M/L control sets.

     CSS multi-column flows *column-major*: post 2 sits under post 1 rather than
     beside it. That is how Pinterest reads, and keyboard stepping is unaffected
     because it walks `reader.items` order — but "next post" can land at the top
     of the next column. A row-major masonry needs `grid-template-rows:
     masonry`, which WebKit does not ship, so this is the honest trade. */
  .cards.masonry {
    /* Multi-column does not apply to a flex container, and the column count
       replaces the picture height as the thing this view is sizing. The gap
       between columns is the same 10px the rows were separated by. */
    display: block;
    columns: var(--masonry-columns, 2);
    column-gap: 10px;
  }

  .cards.masonry .row {
    /* A card split across a column break loses its picture from its own text;
       and the vertical gap that `gap` used to give comes from each card now. */
    break-inside: avoid;
    margin-bottom: 10px;
  }

  /* The picture at its own aspect: the column's width, and whatever height the
     file is. No `aspect-ratio`, no cap, no crop — a crop would take away the
     only thing that makes the columns ragged, and the fixed comic window above
     would letterbox a page instead of staggering it. */
  .cards.masonry .lead {
    width: 100%;
    aspect-ratio: auto;
    max-height: none;
  }

  .cards.masonry .lead img,
  .cards.masonry .lead .panel {
    height: auto;
    max-height: 50cqh;
    object-fit: contain;
    object-position: center;
  }

  /* Half the visible column, at most.
     Without this a page's card is taller than the pane it is in, so the next
     row is only reachable by scrolling — or by shrinking the columns until the
     pictures happen to fit, which is not a way to browse. A picture may take
     half the port; the rest of the column shows the cards underneath it. */
  .cards.masonry .lead img {
    height: auto;
    max-height: 50cqh;
  }


  /* In a column the picture is at its own aspect either way, so a page and a
     photograph already sit right; `contain` above is what keeps the page whole. */

  /* Load more spans the columns rather than sitting in the shortest one. */
  .cards.masonry .more {
    column-span: all;
  }

  /* Where columns are not implemented, the cards are the rows they have always
     been: the comic window, one under the next. Better a plain Cards view than a
     single 300px column of unsized pictures. */
  @supports not (columns: 2) {
    .cards.masonry {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .cards.masonry .row {
      margin-bottom: 0;
    }

    .cards.masonry .lead {
      /* No column support: the card picture as the cards view draws it, capped
         at a page's height rather than set to a fixed box. */
      width: 100%;
      container-type: inline-size;
      margin-inline: auto;
    }

    .cards.masonry .lead img {
      height: 100%;
    }

    .cards.masonry .more {
      column-span: none;
    }
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
