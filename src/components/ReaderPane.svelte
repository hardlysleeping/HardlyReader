<script lang="ts">
  import { isRead, isStarred } from "../api/freshrss";
  import {
    canExtract,
    chooseBody,
    extractFor,
    imageSources,
    rememberedExtraction,
    sameImage,
    type Extracted,
  } from "../lib/extract";
  import { absoluteTime } from "../lib/format";
  import { hardenLinks, isExternalHttp, prepareImages, sanitizeArticle } from "../lib/sanitize";
  import { SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor } from "../lib/scroll-advance";
  import { thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { pullDown } from "../lib/pull";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";

  /**
   * `onLock` is the curtain in one press: the caller sends you home and locks,
   * in that order, so the jump never waits on the server. It is passed only in
   * the one-column layout, where the band — and its lock — is not on screen
   * while you are reading.
   */
  let { onClose, onLock }: { onClose?: () => void; onLock?: () => void } = $props();

  /** Locking needs something to lock with; without a passcode, say so instead. */
  const canLock = $derived(reader.hiddenAvailable && reader.hiddenHasPasscode && !reader.hiddenLocked);

  let scroller = $state<HTMLElement | null>(null);

  /**
   * The article's own width, for pictures that break out to the page's edges.
   *
   * A container query measures the page without its scrollbar, so an image sized
   * from it ran the last 15px behind the scrollbar. The element's own width does
   * not.
   */
  let pageWidth = $state(0);

  /**
   * The page's own height, for the same reason as its width: a comic page has to
   * be read whole, and "whole" is this frame, not the window. In a three-pane
   * layout the article is half the height it is on a phone, so a picture capped
   * against the window would still run off the bottom.
   */
  let pageHeight = $state(0);

  $effect(() => {
    const page = scroller;
    if (page === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        pageWidth = Math.round(entry.contentRect.width);
        pageHeight = Math.round(entry.contentRect.height);
      }
    });
    observer.observe(page);
    return () => observer.disconnect();
  });
  /** Wheel travel accumulated at the bottom, in pixels, against the pull curve. */
  let pull = $state(0);
  /** The setting decides how much travel the pull is worth. */
  const threshold = $derived(thresholdFor(reading.scrollEffort));
  let pullTimer: ReturnType<typeof setTimeout> | null = null;

  /** Nothing counts towards a switch until the wheel has been still this long. */
  let settleUntil = 0;

  function reduceMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Where the article is, so the key map and the wheel both know if it can move. */
  function onscroll(): void {
    const el = scroller;
    if (!el) return;
    const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    reader.setArticleScroll(el.scrollTop <= 2, end);
    // Leaving the bottom gives the pull back: it is a gesture, not a latch.
    if (!end) pull = 0;
  }

  function resetPull(): void {
    pull = 0;
    if (pullTimer !== null) {
      clearTimeout(pullTimer);
      pullTimer = null;
    }
  }

  function atEnd(el: HTMLElement): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  function atStart(el: HTMLElement): boolean {
    return el.scrollTop <= 2;
  }

  /**
   * Scrolling past either end of an article pulls towards its neighbour.
   *
   * Both directions work the same way and share one accumulator: down at the
   * end pulls towards the next post, up at the top pulls towards the previous
   * one, and reversing eats the pull already made instead of starting a second
   * counter. It is deliberately not linear — each pixel of travel adds less than
   * the last — so the final stretch needs a push rather than a flick, and the
   * filling line shows how far through that push you are: at the bottom edge for
   * downwards, the top edge for upwards. A pause gives the pull back, so a stray
   * scroll while reading does not leave a half-loaded switch waiting.
   */
  function onwheel(event: WheelEvent): void {
    const el = scroller;
    if (!reading.advanceOnScroll || !el || event.deltaY === 0) {
      resetPull();
      return;
    }
    if (performance.now() < settleUntil) {
      resetPull();
      return;
    }
    const pullingDown = event.deltaY > 0;
    if (pullingDown ? !atEnd(el) : !atStart(el)) {
      resetPull();
      return;
    }
    pull = accumulate(pull, event.deltaY, threshold);
    if (pullTimer !== null) clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      pull = 0;
      pullTimer = null;
    }, 700);
    if (!shouldAdvance(pull, threshold)) return;
    const direction = pull > 0 ? 1 : -1;
    resetPull();
    settleUntil = performance.now() + SETTLE_MS;
    void reader.advanceArticle(direction);
  }

  // A new article opens at the edge you arrived from: its top when moving
  // forwards, its end when scrolling up into it, so the reading direction never
  // reverses underneath you. Neither the scroll flags nor a part-finished pull
  // carry over.
  $effect(() => {
    const id = reader.selectedId;
    if (id === null) return;
    const edge = reader.landingEdge;
    resetPull();
    const el = scroller;
    if (!el) return;
    el.scrollTop = edge === "bottom" ? el.scrollHeight : 0;
    reader.setArticleScroll(el.scrollTop <= 2, el.scrollHeight <= el.clientHeight + 2);
  });

  // The read-after-dwell timer follows the open post and the preference: moving
  // on re-arms it, and turning the preference off disarms it without marking
  // whatever happened to be open.
  $effect(() => {
    reader.selectedId;
    reading.autoMarkRead;
    reader.syncDwell();
  });

  const item = $derived(reader.selected);

  const link = $derived(item?.alternate?.[0]?.href ?? item?.canonical?.[0]?.href ?? "");

  /**
   * The feed's own HTML, always available and always the fallback.
   *
   * Kept separate from `body` because extraction is an addition to this, not a
   * replacement: if it fails or comes back thin, this is what is on screen —
   * and it was on screen while the page was still being fetched, so nothing
   * blinks.
   */
  const feedBody = $derived(sanitizeArticle(item?.content?.content ?? item?.summary?.content ?? ""));

  /** The extraction for the open post, if one has arrived. */
  let extracted = $state<Extracted | null>(null);
  /** Which post that extraction belongs to, so a late result cannot land on the next one. */
  let extractedFor = $state<string | null>(null);

  $effect(() => {
    const current = item;
    const url = link;
    const wanted = reading.extract;

    if (!wanted || !current || url === "") {
      extracted = null;
      extractedFor = null;
      return;
    }

    const id = current.id;
    const remembered = rememberedExtraction(id);
    if (remembered) {
      extracted = remembered;
      extractedFor = id;
      return;
    }

    extracted = null;
    extractedFor = null;
    let cancelled = false;
    void extractFor(id, url).then((result) => {
      // Moving to another post cancels the landing: a slow page must never
      // replace the article the reader is now looking at.
      if (cancelled || result === null) return;
      extracted = result;
      extractedFor = id;
    });
    return () => {
      cancelled = true;
    };
  });

  /**
   * Experimental, per-article full read.
   *
   * The global preference extracts every post that has a link; this is the same
   * fetch on demand, for one article, from a button — the way to read a
   * summary-only feed without turning extraction on for a whole account. It is
   * keyed by id so a page that lands after the reader has moved on is dropped
   * rather than pasted over the next article.
   */
  let manualId = $state<string | null>(null);
  let manualBody = $state<Extracted | null>(null);
  let manualBusy = $state(false);
  /** Nothing is shown about a failure until the reader asked for one. */
  let manualFailed = $state(false);

  $effect(() => {
    const current = item?.id ?? null;
    if (current === manualId) return;
    manualId = null;
    manualBody = null;
    manualBusy = false;
    manualFailed = false;
  });

  const manualActive = $derived(manualId !== null && manualId === item?.id && manualBody !== null);

  /** The extraction in force for the open post, from either route. */
  const extractedNow = $derived(
    manualActive ? manualBody : extractedFor === item?.id ? extracted : null,
  );

  async function loadFullArticle(): Promise<void> {
    const current = item;
    if (!current || link === "" || manualBusy) return;
    const id = current.id;
    manualBusy = true;
    manualFailed = false;
    const result = await extractFor(id, link);
    if (item?.id !== id) return;
    manualBusy = false;
    // `chooseBody` already refuses a paywall stub or an extraction that found
    // less than the feed sent; asking for the full article does not override
    // that, it only overrides "do not fetch at all".
    if (result === null || chooseBody(result, feedBody).source !== "article") {
      manualFailed = true;
      return;
    }
    manualId = id;
    manualBody = result;
  }

  function dropFullArticle(): void {
    manualId = null;
    manualBody = null;
    manualFailed = false;
  }

  const body = $derived(sanitizeArticle(chooseBody(extractedNow, feedBody).html));

  /** A picture the feed sent, swapped out when the file is gone. */
  let brokenLeads = new Set<string>();

  /**
   * The lead picture above the text.
   *
   * Suppressed when the article body already contains that same picture: many
   * feeds repeat their enclosure image as the first thing in the content, and
   * showing it twice reads as a rendering bug rather than a feature. The
   * comparison is on the sources themselves rather than on the string of the
   * body, because promotion rewrites the body's picture to the largest file and
   * a substring test would miss the same photo at another size.
   */
  const lead = $derived.by(() => {
    if (!reading.articleImage || !item) return null;
    const url = thumbnailOf(item as ThumbSource).url;
    if (!url || brokenLeads.has(item.id)) return null;
    if (imageSources(body).some((src) => sameImage(src, url))) return null;
    return url;
  });

  async function openExternal(url: string): Promise<void> {
    if (!isExternalHttp(url)) return;
    if ("__TAURI_INTERNALS__" in globalThis) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  /** Feed links must leave the app, not replace it. */
  function intercept(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    void openExternal(anchor.getAttribute("href") ?? "");
  }

  /**
   * `html` is always the output of `sanitizeArticle()` above, which runs the
   * feed markup through DOMPurify with scripts, frames, forms and inline styles
   * removed. Assigning it here is the only place sanitised feed HTML is written
   * to the DOM; nothing raw from the server reaches this node.
   *
   * `prepareImages()` runs on the result, not on the string: a referrer policy
   * written into the markup does not survive DOMPurify (measured), and the
   * elements only exist once `innerHTML` has parsed them.
   */
  function attach(node: HTMLElement, html: string) {
    node.innerHTML = html;
    hardenLinks(node);
    prepareImages(node);
    // Delegated here rather than via an inline handler: the markup is feed HTML,
    // not Svelte-owned elements, and keyboard users activate the links directly.
    node.addEventListener("click", intercept);
    return {
      update(next: string) {
        node.innerHTML = next;
        hardenLinks(node);
        prepareImages(node);
      },
      destroy() {
        node.removeEventListener("click", intercept);
      },
    };
  }
</script>

<section class="reader" data-pane="article" aria-label="Article">
  {#if item}
    <header class="toolbar">
      <button class="icon" onclick={() => onClose?.()} aria-label="Back to list">←</button>
      <button
        class="icon"
        aria-label="Previous article"
        title="Previous article — moves through posts and into the previous feed, wrapping round before the first"
        onclick={() => void reader.advanceArticle(-1)}
      >↑</button>
      <button
        class="icon"
        aria-label="Next article"
        title="Next article — continues into the next feed at the end of this one, and wraps round after the last"
        onclick={() => void reader.advanceArticle(1)}
      >↓</button>
      <div class="spacer"></div>
      <button
        class="icon flow"
        class:on={reading.advanceOnScroll}
        aria-pressed={reading.advanceOnScroll}
        aria-label="Continue to the next article when scrolling past the end"
        title={reading.advanceOnScroll
          ? "Scrolling past the end continues to the next article — click to stop at the end of each article"
          : "Scrolling stops at the end of each article — click to continue into the next one"}
        onclick={() => reading.toggleAdvance()}
      >⇣</button>
      <button
        class="icon auto"
        class:on={reading.autoMarkRead}
        aria-pressed={reading.autoMarkRead}
        aria-label={`Mark read after ${reading.autoMarkSeconds} seconds on a post`}
        title={reading.autoMarkRead
          ? `Posts are marked read after ${reading.autoMarkSeconds} seconds on screen — click to keep them unread until you say so`
          : `Posts stay unread however far you scroll — click to mark read after ${reading.autoMarkSeconds} seconds on screen`}
        onclick={() => reading.toggleAutoMarkRead()}
      >⏱</button>
      <button
        class="icon star"
        class:on={isStarred(item)}
        aria-pressed={isStarred(item)}
        aria-label={isStarred(item) ? "Remove star" : "Add star"}
        onclick={() => reader.toggleStar(item)}
        title={isStarred(item) ? "Starred" : "Star"}
      >★</button>
      <button
        class="icon"
        aria-label={isRead(item) ? "Mark unread" : "Mark read"}
        title={isRead(item) ? "Mark unread" : "Mark read"}
        onclick={() => (isRead(item) ? reader.setRead(item, false) : reader.markRead(item))}
      >{isRead(item) ? "◯" : "●"}</button>
      {#if link && canExtract(link)}
        <!-- Experimental: one article, fetched on demand. Sat next to "open
             original" because it is the same page, read in here instead. -->
        <button
          class="icon full"
          class:on={manualActive}
          aria-pressed={manualActive}
          aria-busy={manualBusy}
          aria-label={manualActive ? "Show what the feed sent" : "Load the full article"}
          title={manualBusy
            ? "Fetching the publisher's page…"
            : manualActive
              ? "Showing the full article — click for what the feed sent"
              : "Experimental: fetch the publisher's page and show just the article"}
          onclick={() => (manualActive ? dropFullArticle() : void loadFullArticle())}
        >{manualBusy ? "⋯" : "¶"}</button>
      {/if}
      {#if link}
        <button class="icon" aria-label="Open original" title="Open original" onclick={() => openExternal(link)}>
          ↗
        </button>
      {/if}
      {#if onLock && canLock}
        <button
          class="icon lock"
          aria-label="Lock hidden categories and go to feeds"
          title="Lock hidden categories and go to feeds"
          onclick={() => onLock?.()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 7.5-2" />
          </svg>
        </button>
      {/if}
    </header>

    <!-- A finger dragging down at the top of an article means "up", and there are
         two ways up. With advance-on-scroll on, up is the previous post, as it is
         for the wheel. With it off there is nothing higher to reach, so up is out
         of the reader and back to the list it came from. -->
    <article
      bind:this={scroller}
      style:--page-width={pageWidth > 0 ? `${pageWidth}px` : null}
      style:--page-height={pageHeight > 0 ? `${pageHeight}px` : null}
      data-scroll="article"
      {onscroll}
      {onwheel}
      use:pullDown={{
        label: reading.advanceOnScroll ? "Pull down for the previous post" : "Pull down to go back",
        readyLabel: reading.advanceOnScroll ? "Release for the previous post" : "Release to go back",
        onPull: () => (reading.advanceOnScroll ? void reader.advanceArticle(-1) : onClose?.()),
      }}
    >
      <h1>{item.title || "(untitled)"}</h1>
      <p class="byline">
        <span>{item.origin?.title ?? ""}</span>
        {#if item.author}<span>· {item.author}</span>{/if}
        <span>· {absoluteTime(item.timestampUsec, item.published)}</span>
        {#if manualFailed}
          <span class="retry" role="status">
            · no full article
            <button class="inline" onclick={() => void loadFullArticle()}>try again</button>
          </span>
        {/if}
      </p>

      {#if lead}
        <img
          class="lead"
          src={lead}
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          draggable="false"
          onerror={() => {
            if (item) brokenLeads = new Set(brokenLeads).add(item.id);
          }}
        />
      {/if}

      {#if body}
        <div class="content" use:attach={body}></div>
      {:else}
        <p class="no-content">This item has no content. <button class="inline" onclick={() => openExternal(link)}>Open the original</button>.</p>
      {/if}
    </article>
  {:else}
    <div class="placeholder">
      <p>Select an article.</p>
    </div>
  {/if}
  {#if reader.traversalEnded}
    <p class="ended" role="status">That is every post in this view.</p>
  {/if}
  <div
    class="pull"
    class:visible={pull !== 0}
    class:up={pull < 0}
    style:--p={progressOf(pull, threshold)}
    aria-hidden="true"
  ></div>
</section>

<style>
  .reader {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  /* The feedback for the pull: fills left to right as the next article gets
     closer, and only exists while a pull is in progress. */
  .pull {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 3px;
    transform: scaleX(var(--p, 0));
    transform-origin: left center;
    background: var(--accent);
    opacity: 0;
    pointer-events: none;
    transition: transform 80ms linear, opacity 120ms ease;
  }

  .pull.visible {
    opacity: 0.9;
  }

  /* Scrolling up fills from the top edge, so the direction is visible as well as
     the amount. */
  .pull.up {
    top: 0;
    bottom: auto;
    transform-origin: right center;
  }

  .ended {
    position: absolute;
    right: 0;
    bottom: 10px;
    left: 0;
    margin: 0;
    text-align: center;
    font-size: 11.5px;
    color: var(--muted);
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .pull {
      transition: none;
    }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 40px;
    padding: 0 10px;
    border-bottom: 1px solid var(--edge-soft);
    background: var(--surface);
  }

  .spacer {
    flex: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }

  .star.on {
    color: var(--star);
  }

  /* The same padlock the band draws, so the curtain has one shape in the app. */
  .lock svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .lock:hover {
    color: var(--tone-lock-closed);
  }

  .flow.on {
    color: var(--accent-text, #6cb0f5);
  }

  /* The article is the page, edge to edge, and the reading column is what is
     centred inside it. Pictures break out of the column to the page's width, so
     the page is the thing that gets measured — a column cannot report the width
     it sits in, and a scrollbar would be unaccounted for. */
  article {
    --gutter: clamp(16px, 5vw, 48px);
    flex: 1;
    overflow-y: auto;
    padding-block: 22px 64px;
    max-width: none;
    width: 100%;
  }

  /* Headline, byline and prose keep a readable measure in the middle. */
  article > h1,
  article > .byline,
  .content {
    max-width: 780px;
    margin-inline: auto;
    padding-inline: var(--gutter);
  }

  h1 {
    margin: 0 0 8px;
    font-size: clamp(19px, 2.1vw, 24px);
    line-height: 1.25;
    letter-spacing: -0.015em;
  }

  /* The lead picture: the feed's own image, bled to the article's edges so it
     reads as a header rather than as part of the prose. `--thumb-scale` is the
     same setting the list rows use, so turning pictures up in the popout widens
     this too instead of leaving it at one size. */
  .lead {
    /* The feed's own picture is the article's width, edge to edge: a comic page
       or a photograph shown whole, never letterboxed into a narrower box. */
    display: block;
    width: var(--page-width, 100%);
    max-width: none;
    /* One page at a time: a comic taller than the frame is fitted to it and
       centred, so the whole page is readable without scrolling. Its width, and
       so its scale, is the largest that both edges allow — which for a page is
       the frame's height. */
    max-height: var(--page-height, none);
    height: auto;
    margin-block: 0 20px;
    margin-inline: calc((100% - var(--page-width, 100%)) / 2);
    object-fit: contain;
    background: var(--hover);
  }

  .byline {
    margin: 0 0 22px;
    font-size: 12px;
    color: var(--muted);
  }

  /* Says the page was fetched and refused, so the button is not just inert. */
  .retry {
    white-space: nowrap;
    opacity: 0.85;
  }

  .content {
    /* Size, leading and alignment all come from one place: the custom
       properties set on the pane container. */
    font-size: calc(15px * var(--read-scale, 1));
    line-height: var(--read-leading, 1.65);
    text-align: var(--read-align, left);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  /* Every picture in the body takes the pane's full width and keeps its own
     height. The text column stays at 780px; the pictures do not, because a
     column of empty space beside them is the thing being fixed. */
  .content :global(img) {
    display: block;
    width: var(--page-width, 100%);
    max-width: none;
    /* Same rule as the lead: a page fits the frame rather than running past its
       bottom. Contained, not cropped — the bars either side of a tall page are
       the price of showing all of it, and the alternative is a page you scroll
       to find the end of. */
    max-height: var(--page-height, none);
    height: auto;
    object-fit: contain;
    margin-block: 1em;
    margin-inline: calc((100% - var(--page-width, 100%)) / 2);
  }

  .content :global(pre) {
    overflow-x: auto;
    padding: 12px;
    border-radius: 8px;
    background: var(--surface);
    font-size: 12.5px;
  }

  .content :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
  }

  .content :global(blockquote) {
    margin: 0 0 1em;
    padding-left: 14px;
    border-left: 2px solid var(--border);
    color: var(--text-dim);
  }

  .content :global(a) {
    color: var(--accent-text);
  }

  .content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .content :global(td),
  .content :global(th) {
    padding: 4px 8px;
    border: 1px solid var(--border);
  }

  .no-content,
  .placeholder {
    color: var(--muted);
    font-size: 13px;
  }

  .placeholder {
    display: grid;
    place-items: center;
    height: 100%;
  }

  .inline {
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
