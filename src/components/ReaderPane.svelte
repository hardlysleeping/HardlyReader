<script lang="ts">
  import { onDestroy } from "svelte";

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
  import { looksTruncated, wantsFullText } from "../lib/full-text";
  import { absoluteTime } from "../lib/format";
  import { hardenLinks, isExternalHttp, prepareImages, sanitizeArticle } from "../lib/sanitize";
  import { bodies } from "../state/bodies.svelte";
  import { picture as drawPicture } from "../state/pictures.svelte";
  import { SETTLE_MS, accumulate, progressOf, shouldAdvance, thresholdFor } from "../lib/scroll-advance";
  import { fittedWidth } from "../lib/image-fit";
  import {
    atRest,
    doubleTap,
    drag,
    fitInto,
    midpoint,
    pinch,
    restZoom,
    span,
    transformOf,
    type Point,
    type Size,
    type Zoom,
  } from "../lib/picture-zoom";
  import { IMAGE_SCALE, scalePercent } from "../lib/reading-layout";
  import { thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { pullDown } from "../lib/pull";
  import { shareArticle } from "../lib/share";
  import { layout } from "../state/layout.svelte";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";

  /**
   * How long "Link copied" stays in the byline: long enough to read once, short
   * enough that it never becomes part of the article's furniture.
   */
  const SHARE_NOTE_MS = 2400;

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

  /**
   * The page's content box: what the observer would report, read from the
   * element instead.
   *
   * `clientWidth` is the padding box less the scrollbar, and the content box is
   * that less its padding — the same rectangle `entry.contentRect` gives, so the
   * two paths cannot disagree about the frame a picture is fitted to.
   */
  function pageSize(page: HTMLElement): { width: number; height: number } {
    const style = getComputedStyle(page);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    return {
      width: Math.round(page.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
      height: Math.round(page.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
    };
  }

  /**
   * The frame a picture is fitted to, measured when the article is bound and
   * kept up to date by the observer.
   *
   * Measuring on the element matters because the observer's first delivery is
   * not a promise. An article built inside a pane that is not in front — the
   * phone's stack keeps every layer mounted and moves them with `transform`, so
   * the article is drawn off screen and `inert` until it is slid in — can be
   * observed and then never reported on, and the pane used to wait for that
   * report forever: `pageWidth` stayed 0, so every picture was drawn at its
   * file's own width and a 684px comic was clipped to a 390px pane. Nothing
   * wrote a width, and nothing was going to.
   */
  $effect(() => {
    const page = scroller;
    if (page === null) return;
    const write = (): void => {
      const size = pageSize(page);
      // A frame with no width has not been laid out yet, which is not the same
      // as a frame that is zero wide: writing it would un-fit every picture.
      if (size.width <= 0) return;
      pageWidth = size.width;
      pageHeight = size.height;
    };
    write();
    const observer = new ResizeObserver(write);
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
    // Nothing to fit against yet. The stylesheet is already holding the picture
    // to the pane by then (`width: auto` inside a `max-width: 100%`), so this
    // is the one case where saying nothing is the right answer: writing the
    // file's own width instead is what drew a 684px comic 684px wide inside a
    // 390px pane and clipped it.
    if (pageWidth <= 0) return;
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
        // A tap opens the picture itself, where it can be pinched. On a pointer
        // device the tap means nothing: a mouse has no pinch, and hijacking the
        // click would break the link an image is often wrapped in.
        if (touching) img.addEventListener("click", (event) => openPicture(img, event));
      }
      paintPicture(img);
    }
  }

  /**
   * Whether a finger is what presses things here.
   *
   * Asked once, at load: a phone that reports a coarse pointer is the surface
   * this viewer exists for, and the same page in a browser tab keeps its clicks.
   */
  const touching =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  /** The picture on its own layer, and where the fingers have put it. */
  let opened = $state<{ src: string; alt: string; natural: Size } | null>(null);
  let zoom = $state<Zoom>(restZoom());
  let layer = $state<HTMLElement | null>(null);
  let frame = $state<Size>({ width: 0, height: 0 });

  /** The size the picture is drawn at before zoom, recomputed when the frame moves. */
  const drawing = $derived(
    opened === null ? { width: 0, height: 0 } : fitInto(opened.natural, frame),
  );

  /** Fingers currently down on the layer, in the layer's own coordinates. */
  const fingers = new Map<number, Point>();
  let gesture: { start: Zoom; from: number; centre: Point; travel: number } | null = null;
  let lastTapAt = 0;

  function openPicture(img: HTMLImageElement, event: Event): void {
    const src = img.currentSrc || img.src;
    if (!src) return;
    event.preventDefault();
    event.stopPropagation();
    opened = {
      src,
      alt: img.alt || "",
      natural: { width: img.naturalWidth, height: img.naturalHeight },
    };
    zoom = restZoom();
    fingers.clear();
    gesture = null;
  }

  function closePicture(): void {
    opened = null;
    fingers.clear();
    gesture = null;
  }

  function pointOf(event: PointerEvent): Point {
    const box = layer?.getBoundingClientRect();
    return {
      x: event.clientX - (box?.left ?? 0),
      y: event.clientY - (box?.top ?? 0),
    };
  }

  function onPointerDown(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    fingers.set(event.pointerId, pointOf(event));
    if (fingers.size === 2) {
      const [a, b] = [...fingers.values()];
      gesture = { start: zoom, from: span(a, b), centre: midpoint(a, b), travel: 0 };
    } else if (fingers.size === 1) {
      gesture = { start: zoom, from: 0, centre: pointOf(event), travel: 0 };
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!fingers.has(event.pointerId)) return;
    const before = fingers.get(event.pointerId);
    const next = pointOf(event);
    fingers.set(event.pointerId, next);
    if (gesture === null) return;
    gesture.travel += Math.hypot(next.x - (before?.x ?? next.x), next.y - (before?.y ?? next.y));

    if (fingers.size >= 2 && opened !== null) {
      const [a, b] = [...fingers.values()];
      zoom = pinch(gesture.start, gesture.from, span(a, b), midpoint(a, b), frame, drawing);
    } else if (fingers.size === 1 && opened !== null) {
      zoom = drag(
        gesture.start,
        { x: next.x - gesture.centre.x, y: next.y - gesture.centre.y },
        drawing,
        frame,
      );
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!fingers.has(event.pointerId)) return;
    fingers.delete(event.pointerId);
    if (fingers.size > 0) {
      // A finger lifted from a pinch: the remaining one starts dragging from
      // where it is now, not from where the pinch began.
      const [only] = [...fingers.values()];
      gesture = { start: zoom, from: 0, centre: only, travel: 0 };
      return;
    }
    const travelled = gesture?.travel ?? 0;
    gesture = null;
    if (travelled > 10) return;

    const now = Date.now();
    const at = pointOf(event);
    if (now - lastTapAt < 320) {
      lastTapAt = 0;
      zoom = doubleTap(zoom, at, frame, drawing);
      return;
    }
    lastTapAt = now;
    if (atRest(zoom)) closePicture();
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
   * The link a share can carry: the post's own address, if the feed gave one.
   *
   * Same rule as "open at source" — an external http(s) URL, never a relative
   * one and never something the feed invented. Without it there is nothing to
   * share, so the control is not drawn at all rather than drawn dead.
   */
  const shareUrl = $derived(isExternalHttp(link) ? link : "");

  /**
   * The picture a share can carry: the lead image the feed itself named.
   *
   * Read here rather than from the `lead` below, which is the picture the
   * article pane *draws* — that one honours the reader's image preference and
   * hides a duplicate, and neither is a reason to send a link without its
   * photograph. A feed with no picture answers empty, which the payload drops.
   */
  const shareImage = $derived(item ? thumbnailOf(item as ThumbSource).url : "");

  /**
   * What the share press has to say for itself.
   *
   * The sheet needs no announcement — it is on screen and it is the answer — but
   * a copy lands silently, so it gets a word. It clears itself, because a line
   * about a press three minutes ago is clutter in a byline.
   */
  let shareNote = $state<string | null>(null);
  let shareNoteTimer: number | null = null;

  function noteShare(text: string): void {
    if (shareNoteTimer !== null) clearTimeout(shareNoteTimer);
    shareNote = text;
    shareNoteTimer = null;
    if (typeof window === "undefined") return;
    shareNoteTimer = window.setTimeout(() => {
      shareNote = null;
      shareNoteTimer = null;
    }, SHARE_NOTE_MS);
  }

  /**
   * Offer this post to the device, and say so only when copying had to stand in.
   *
   * Called straight from the press with nothing awaited before the sheet: Web
   * Share is checked against the click's own activation, so a fetch or a state
   * write first would spend it and the sheet would refuse to open.
   */
  async function shareThis(): Promise<void> {
    // Read once into locals: the derived values are read through Svelte's own
    // accessors, and a value checked for null and then read again is not the
    // same binding to the type checker.
    const current = item;
    const url = shareUrl ?? "";
    const image = shareImage ?? "";
    if (current === null || url === "") return;
    const outcome = await shareArticle({
      title: current.title ?? "",
      url,
      image,
    });
    if (outcome === "copied") noteShare("Link copied");
    else if (outcome === "failed") noteShare("Couldn't copy the link");
  }

  onDestroy(() => {
    if (shareNoteTimer !== null) clearTimeout(shareNoteTimer);
  });

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
   * The feed this post came from — the unit a full-text answer belongs to.
   *
   * Both account kinds name it the same way (`feed/<url>`), so the answer follows
   * the feed in a local library as well as on a server.
   */
  const feedId = $derived(item?.origin?.streamId ?? null);

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

  /**
   * Tell the bodies cache which post is on screen.
   *
   * Two surfaces can be drawing two posts at once, so this is a set rather than a
   * field: the list's inline reader and this pane both say what they are showing,
   * and the budget passes over both. A body no pane is drawing has no claim on
   * the space.
   */
  $effect(() => {
    const drawn = item?.id ?? null;
    if (drawn === null) return;
    bodies.showing(drawn);
    return () => bodies.hidden(drawn);
  });

  $effect(() => {
    const current = item;
    const url = link;
    // Where this post's text comes from: the reader's own ¶ press on this entry,
    // the feed's answer (Auto / Feed / Full webpage), or Auto's read — the
    // account-wide switch, what Auto already knows about the feed, and this
    // post's own markup. The feed's text needs no page, and neither does a post
    // the reader has put back on the feed; everything else waits for one fetch,
    // and the ledger decides whether that fetch is worth making at all.
    const wanted = wantsFullText({
      post: choice,
      feed: reader.feedExtract(feedId),
      accountWide: reading.extract,
      remembered: reader.feedTruncated(feedId),
      html: feedBody,
    });

    // Auto's verdict, written once for the feed that proved it: the piece this
    // feed sends stops short, so its later posts need no second test. Silent on
    // purpose — it changes nothing that is drawn, and the fetch below is the
    // answer to the post on screen.
    if (wanted && reader.feedExtract(feedId) === "auto" && looksTruncated(feedBody)) {
      reader.noteFeedTruncated(feedId);
    }

    if (!current || url === "") {
      extracted = null;
      extractedFor = null;
      fetching = false;
      return;
    }

    const id = current.id;

    if (!wanted) {
      // Keeping a copy is not the same as showing it. A reader who asked this
      // device to keep the post it opens gets the page fetched and stored, and
      // still reads the feed's own text — the two answers are separate on
      // purpose, because "show me the article" and "keep it for later" are
      // different requests. With keeping off nothing is fetched here at all.
      extracted = null;
      extractedFor = null;
      fetching = false;
      if (bodies.keeping) void extractFor(id, url);
      return;
    }

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
      tabindex="-1"
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
        {#if layout.caps.share && shareUrl !== ""}
          <!-- The phone's way out: the post's own title and link, through the
               device's sheet. In the byline rather than the toolbar, which is
               already at the width of a 375px screen, and next to the words it
               is sharing. -->
          <span class="share">
            · <button class="inline" onclick={() => void shareThis()}>Share</button>
            {#if shareNote}
              <span class="share-note" role="status">{shareNote}</span>
            {/if}
          </span>
        {/if}
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
          use:drawPicture={{ url: lead, variant: "full", frame: pageWidth }}
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
  {#if opened}
    <!-- The picture on its own layer: one finger drags, two pinch, a tap on an
         unzoomed picture closes it. `touch-action: none` is what lets the layer
         see the gestures instead of the browser scrolling the article under it. -->
    <div
      class="zoombox"
      role="dialog"
      aria-modal="true"
      aria-label={opened.alt || "Picture"}
      bind:this={layer}
      bind:clientWidth={frame.width}
      bind:clientHeight={frame.height}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <img
        src={opened.src}
        alt={opened.alt}
        draggable="false"
        style:width={`${drawing.width}px`}
        style:height={`${drawing.height}px`}
        style:transform={transformOf(zoom)}
      />
      <button class="zoomclose" onclick={closePicture} aria-label="Close picture">✕</button>
    </div>
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

  /* The tapped picture, over everything the pane draws. `touch-action: none` is
     load-bearing: without it the webview scrolls the article under the fingers
     and a pinch never becomes a pinch. */
  .zoombox {
    position: fixed;
    inset: 0;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #000000e0;
    touch-action: none;
    overscroll-behavior: contain;
  }

  .zoombox img {
    max-width: none;
    max-height: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
    will-change: transform;
    touch-action: none;
  }

  .zoomclose {
    position: absolute;
    top: max(10px, env(safe-area-inset-top));
    right: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border: 1px solid #ffffff3d;
    border-radius: 999px;
    background: #000000a6;
    color: #fff;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
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

  /* The share press and its answer, kept on the byline's own line so a copy
     that had to stand in for a sheet does not move the article under the thumb
     that just pressed it. */
  .share {
    white-space: nowrap;
  }

  .share-note {
    margin-left: 6px;
    color: var(--accent-text);
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
