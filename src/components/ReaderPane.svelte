<script lang="ts">
  import { isRead, isStarred } from "../api/freshrss";
  import {
    bodyFor,
    canExtract,
    chooseBody,
    extractFor,
    imageSources,
    rememberedExtraction,
    sameImage,
    type Extracted,
  } from "../lib/extract";
  import { ledger, type BodyChoice } from "../lib/extract-ledger";
  import { absoluteTime } from "../lib/format";
  import { hardenLinks, isExternalHttp, prepareImages, sanitizeArticle } from "../lib/sanitize";
  import { SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor } from "../lib/scroll-advance";
  import { fittedWidth } from "../lib/image-fit";
  import { IMAGE_SCALE, scalePercent } from "../lib/reading-layout";
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
  let {
    onClose,
    onLock,
    onRead,
  }: {
    onClose?: () => void;
    onLock?: () => void;
    /**
     * Called when this pane marks the post read.
     *
     * The posts column draws the article over its own list when reading there,
     * so marking it read is the end of the visit and the list comes back.
     * Marking *unread* does not: that is a correction, not a finish.
     */
    onRead?: () => void;
  } = $props();

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
  /** For the buttons' tooltips: what the pictures are currently sized to. */
  const picturesAt = $derived(scalePercent(reading.imageScale, IMAGE_SCALE));

  /**
   * Draw one picture at the width the fit gives it.
   *
   * The width is written in pixels rather than left to the stylesheet because no
   * stylesheet can see a file's natural size: `max-width: 100%` would upscale a
   * 300px icon into a blurry 900px panel, and no CSS at all can say "this big,
   * but never bigger than the file". `fittedWidth` decides that, and the pane's
   * own box is the frame it decides against.
   *
   * The offset is the same trick the stylesheet used: the picture bleeds out of
   * the 780px prose measure and centres on the pane, so a page can be as wide as
   * the pane even though the words are not.
   */
  function paintPicture(img: HTMLImageElement): void {
    const width = fittedWidth(
      { width: img.naturalWidth, height: img.naturalHeight },
      { width: pageWidth, height: pageHeight },
      reading.imageScale,
    );
    if (width === null) return;
    img.style.width = `${width}px`;
    img.style.height = "auto";
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    img.style.marginInline = `calc((100% - ${width}px) / 2)`;
  }

  /** Fit every picture on the page, and keep fitting the ones still loading. */
  function fitPictures(): void {
    const root = scroller;
    if (root === null) return;
    for (const img of root.querySelectorAll("img")) {
      if (img.dataset.fitBound !== "1") {
        img.dataset.fitBound = "1";
        // The natural size is not known until the file has decoded, and every
        // measurement above is taken from it.
        img.addEventListener("load", () => paintPicture(img));
      }
      paintPicture(img);
    }
  }

  // A new article, a bigger or smaller picture setting, or a frame that changed
  // shape: all three mean the same arithmetic has to run again.
  $effect(() => {
    void reading.imageScale;
    void pageWidth;
    void pageHeight;
    fitPictures();
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
    reader.rememberScroll("article", el.scrollTop);
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
  // carry over. A launch resumes the line that was being read instead.
  //
  // The open post is remembered here so that clearing the resume hint — which is
  // itself reactive — does not read as a new post and snap the pane to an edge.
  let openedPost: string | null = null;

  $effect(() => {
    const id = reader.selectedId;
    const resume = reader.articleScrollRestore;
    if (id === null) return;
    const el = scroller;
    if (!el) return;
    if (resume !== null) {
      openedPost = id;
      reader.clearScrollRestore("article");
      resetPull();
      // The body is laid out over the next frames — pictures especially — so the
      // offset is re-applied until it sticks, and given up if the post changes.
      // A timer rather than a frame: a window that is not on screen still
      // resumes, which is the case this is here for.
      el.scrollTop = resume;
      const deadline = performance.now() + 2500;
      const put = (): void => {
        if (reader.selectedId !== id) return;
        el.scrollTop = resume;
        if (Math.abs(el.scrollTop - resume) <= 1) return;
        if (performance.now() < deadline) setTimeout(put, 60);
      };
      setTimeout(put, 60);
      return;
    }
    if (openedPost === id) return;
    openedPost = id;
    const edge = reader.landingEdge;
    resetPull();
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

  /**
   * What the reader decided about this one post, when they decided anything.
   *
   * The account-wide switch is "extract every post"; this is "this one", in
   * either direction — asking for the article on a summary-only feed, or for the
   * feed's own text on a post whose extracted version is worse. It is written to
   * the ledger by entry id, so it outlives the next post, the next launch and
   * the next sync, and it never travels to another account.
   */
  let choice = $state<BodyChoice | null>(null);
  /** The entry that choice belongs to, so switching posts cannot inherit it. */
  let choiceFor = $state<string | null>(null);

  $effect(() => {
    const current = item?.id ?? null;
    if (current === choiceFor) return;
    choiceFor = current;
    choice = current === null ? null : ledger.choice(current);
  });

  /** The extraction for the open post, if one has arrived. */
  let extracted = $state<Extracted | null>(null);
  /** Which post that extraction belongs to, so a late result cannot land on the next one. */
  let extractedFor = $state<string | null>(null);
  /** A press is waiting on a page. */
  let fetching = $state(false);
  /** Nothing is said about a failure until the reader asked for one. */
  let refused = $state(false);

  $effect(() => {
    const current = item;
    const url = link;
    // The feed's own text needs no page, and neither does a post the reader has
    // put back on the feed. Everything else waits for one fetch — and the
    // ledger decides whether that fetch is worth making at all.
    const wanted = (reading.extract || choice === "article") && choice !== "feed";

    if (!wanted || !current || url === "") {
      extracted = null;
      extractedFor = null;
      fetching = false;
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
   * The per-article switch, in both directions.
   *
   * The account-wide preference extracts every post that has a link; this is one
   * article at a time, from a button — the way to read a summary-only feed
   * without turning extraction on for a whole account, and the way to put a post
   * back on the feed's own text when the extracted version is worse.
   */
  /** The extraction in force for the open post. */
  const extractedNow = $derived(extractedFor === item?.id ? extracted : null);

  /** What is on screen, and where it came from. */
  const picked = $derived(bodyFor(choice, extractedNow, feedBody));
  const body = $derived(sanitizeArticle(picked.html));
  /** Whether the article, rather than the feed's own text, is what is being read. */
  const showingArticle = $derived(picked.source === "article");

  /**
   * A press on the article returns to the feed's text; a press on the feed
   * fetches this one page.
   *
   * The fetch is explicit, so it is also a retry: the ledger may have parked this
   * URL after a paywall or a timeout, and pressing the button is the reader
   * saying they want it tried anyway. Nothing is remembered as "this post reads
   * as the article" until an article actually arrives — a remembered choice is a
   * fact about the post, not a wish.
   */
  async function toggleReading(): Promise<void> {
    const current = item;
    if (!current || link === "" || fetching) return;
    if (showingArticle) {
      setChoice("feed");
      return;
    }
    const id = current.id;
    fetching = true;
    refused = false;
    const result = await extractFor(id, link, { force: true });
    // Moving on cancels the landing: a slow page must never replace the article
    // the reader is now looking at.
    if (item?.id !== id) return;
    fetching = false;
    // `chooseBody` already refuses a paywall stub or an extraction that found
    // less than the feed sent; asking for the full article does not override
    // that, it only overrides "do not fetch at all".
    if (result === null || chooseBody(result, feedBody).source !== "article") {
      refused = true;
      return;
    }
    setChoice("article");
    extracted = result;
    extractedFor = id;
  }

  /** One place writes the choice, so the ledger and the pane cannot disagree. */
  function setChoice(next: BodyChoice | null): void {
    const id = item?.id ?? null;
    choice = next;
    choiceFor = id;
    if (id === null) return;
    if (next === null) ledger.forget(id);
    else ledger.remember(id, next);
  }

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
    fitPictures();
    // Delegated here rather than via an inline handler: the markup is feed HTML,
    // not Svelte-owned elements, and keyboard users activate the links directly.
    node.addEventListener("click", intercept);
    return {
      update(next: string) {
        node.innerHTML = next;
        hardenLinks(node);
        prepareImages(node);
        fitPictures();
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
        class="icon pictures"
        aria-label="Smaller pictures"
        title={`Pictures at ${picturesAt} of the automatic fit — smaller, so the words get more room`}
        onclick={() => reading.stepImageScale(-1)}
      >⊖</button>
      <button
        class="icon pictures"
        aria-label="Larger pictures"
        title={`Pictures at ${picturesAt} of the automatic fit — larger, past the file's own size if you say so`}
        onclick={() => reading.stepImageScale(1)}
      >⊕</button>
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
        onclick={() => {
          if (isRead(item)) {
            reader.setRead(item, false);
            return;
          }
          reader.markRead(item);
          onRead?.();
        }}
      >{isRead(item) ? "◯" : "●"}</button>
      {#if link && canExtract(link)}
        <!-- Experimental: one article, fetched on demand. Sat next to "open
             original" because it is the same page, read in here instead. -->
        <button
          class="icon full"
          class:on={showingArticle}
          aria-pressed={showingArticle}
          aria-busy={fetching}
          aria-label={showingArticle ? "Show what the feed sent" : "Load the full article"}
          title={fetching
            ? "Fetching the publisher's page…"
            : showingArticle
              ? "Showing the full article — click for what the feed sent"
              : "Experimental: fetch the publisher's page and show just the article"}
          onclick={() => void toggleReading()}
        >{fetching ? "⋯" : "¶"}</button>
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
        {#if refused}
          <span class="retry" role="status">
            · no full article
            <button class="inline" onclick={() => void toggleReading()}>try again</button>
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

  /* The star is the one mark in this row drawn smaller than its own box: ★ at
     the row's 13px reads as a speck next to ● and ⇣, which sit on the baseline
     at their full size. It gets a larger glyph and a little more room without
     growing the row — the toolbar's height is the bar's, not this button's. */
  .star {
    min-width: 32px;
    font-size: 18px;
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
    /* The article is panned by the app's drag module like the lists: the browser
       would take the pointer on the first move and then stop dead on release. */
    touch-action: none;
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
    /* The automatic fit, for the moment before the file has decoded and the pane
       has measured itself: no wider than the pane, no taller than it, and never
       wider than the file. Once both are known the pane writes an exact width in
       pixels, because only it can see the file's natural size — this is what a
       picture looks like until then. */
    width: auto;
    max-width: var(--page-width, 100%);
    max-height: var(--page-height, none);
    height: auto;
    margin-block: 0 20px;
    margin-inline: auto;
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
    /* Same rule as the lead, and the same reason: a page fits the frame rather
       than running past its bottom, and it is never stretched past the file it
       came from. The exact width comes from the pane in pixels; this is the
       shape of a picture before that has happened. */
    width: auto;
    max-width: var(--page-width, 100%);
    max-height: var(--page-height, none);
    height: auto;
    object-fit: contain;
    margin-block: 1em;
    margin-inline: auto;
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
