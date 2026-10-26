<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";

  import type { Session, UserInfo } from "../api/freshrss";
  import ArticleList from "../components/ArticleList.svelte";
  import FloodLayer from "../components/FloodLayer.svelte";
  import CategoryMenu from "../components/CategoryMenu.svelte";
  import Header from "../components/Header.svelte";
  import LayoutSwitch from "../components/LayoutSwitch.svelte";
  import LoadAura from "../components/LoadAura.svelte";
  import MobilePaneStack from "../components/MobilePaneStack.svelte";
  import PaneGutter from "../components/PaneGutter.svelte";
  import ReaderPane from "../components/ReaderPane.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { startAutoSync } from "../lib/auto-sync";
  import { startChangeWatch } from "../lib/watch-changes";
  import { transport } from "../api/transport";
  import { getRevision } from "../api/hardlyread";
  import { isTypingTarget, resolveKey, resolveShiftKey } from "../lib/keys";
  import { arriveKeyframes, gridTemplate, motionEase, motionMs, paneSlots, tracks } from "../lib/panes";
  import { backLabel, levelOf, stepBackTarget, whereLabel } from "../lib/one-pane";
  import { readingVars } from "../lib/reading-layout";
  import { chrome } from "../state/chrome.svelte";
  import { layout } from "../state/layout.svelte";
  import { mobileNav, slidesInPortrait } from "../state/mobile-nav.svelte";
  import { reading } from "../state/reading.svelte";
  import { reader } from "../state/reader.svelte";

  let {
    session,
    account,
    onsignout,
    onaddaccount,
  }: {
    session: Session;
    account: UserInfo | null;
    /** Sign out of every account on this device. */
    onsignout?: () => void;
    /** Sign a second account in without touching the one in use. */
    onaddaccount?: () => void;
  } = $props();

  /** A launch load newer than this counts as the launch sync. */
  const AUTO_SYNC_LAUNCH_GRACE_MS = 30_000;

  /**
   * Automatic sync: starts when the setting says so and stops when it stops.
   *
   * The effect re-runs on the toggle and on the interval, so turning it on takes
   * effect now and changing the period restarts the timer at the new period —
   * neither needs a relaunch. `launch` is false when the launch load already
   * fetched everything, so a start does not spend the same five requests twice
   * in one second; when that load failed there is nothing recent to trust and
   * the first automatic sync runs at once.
   */
  /**
   * The website writes the same state this app reads, and there is no channel
   * to be told about it, so it is asked: a token every few seconds, and the
   * state re-read only when the token moves. That is what makes clicking an eye
   * or a pin on the website show up here on its own.
   */
  $effect(() => {
    const watch = startChangeWatch({
      read: () => getRevision(transport, session),
      // Only the extension state: that is what the website's buttons write, and
      // every visible consequence of it (which categories are pinned, hidden,
      // locked, indented) is derived from it. The feed list and unread counts
      // come from FreshRSS's crawler and do not move when a view changes, so
      // re-reading them here would be three requests to learn nothing.
      onChange: () => {
        void reader.loadApiState();
      },
      busy: () => reader.sync.active,
      visible: () => document.visibilityState === "visible",
    });
    // Coming back to the window is the moment a stale view is most obvious, so
    // it checks at once instead of waiting out the interval.
    const wake = () => {
      if (document.visibilityState === "visible") watch.kick();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      watch.stop();
    };
  });

  $effect(() => {
    const enabled = chrome.autoSync;
    const hours = chrome.autoSyncHours;
    const started = launched;
    if (!enabled || !started) return;
    // Everything the timer touches is read outside the effect's tracking:
    // a sync updates `reader.sync` and `lastSyncAt`, and taking those as
    // dependencies would tear the timer down and rebuild it after every sync —
    // resetting the period each time the user pressed sync themselves.
    const run = untrack(() =>
      startAutoSync({
        enabled: () => chrome.autoSync,
        hours: () => hours,
        sync: () => reader.refresh(),
        busy: () => reader.sync.active,
        launch: Date.now() - reader.lastSyncAt > AUTO_SYNC_LAUNCH_GRACE_MS,
      }),
    );
    return () => run.stop();
  });

  /**
   * One column has two levels, not three: the feed list (where a feed opens its
   * posts in place) and the article. There is no posts screen to step into, so
   * nothing tracks it.
   */
  let panes = $state<HTMLElement | null>(null);

  const mode = $derived(layout.mode);

  /**
   * The phone's sliding stack, instead of the columns.
   *
   * True only for a phone held upright whose preference says `stack`. Everything
   * else — portrait with the walk, and every landscape or desktop frame — draws
   * the grid below exactly as it always has, which is what keeps the one-pane UI
   * and the desktop three-pane layout byte for byte what they were. The question
   * itself is asked once, in `slidesInPortrait`, so the panel cannot offer a
   * setting the view disagrees with.
   */
  const slideStack = $derived(
    slidesInPortrait({
      device: layout.device,
      portrait: layout.upright,
      mode: layout.mobilePortraitMode,
    }),
  );

  /**
   * Landing on one pane lands on the feeds, and landing on two lands on the
   * posts.
   *
   * One column is a walk — feeds, then posts, then the article — and collapsing
   * into it with an article open used to leave that article alone on screen:
   * the second pane's content, on a surface whose first pane is the feeds. The
   * walk always starts from the top, whether the collapse came from the window
   * or from the switch. Two panes have the same trap one step later: the second
   * column becomes the article while one is open, so arriving there from three
   * panes drew the feeds beside the *third* pane's content and read as panes 1
   * and 3 with 2 missing. Opening a post from the list still fills that column.
   */
  let drawn = layout.mode;
  $effect(() => {
    const now = layout.mode;
    if (now === drawn) return;
    drawn = now;
    if (now === 1 || now === 2) reader.closeReader();
  });
  const menu = $derived.by(() => {
    const point = reader.menu;
    const model = reader.menuModel;
    return point === null || model === null ? null : { x: point.x, y: point.y, model };
  });

  /**
   * True once the launch load has finished, so automatic sync starts after the
   * first paint rather than racing it.
   */
  let launched = $state(false);

  onMount(() => {
    // Three stores outlive a session, and this view is mounted once per session
    // — a switch remounts it — so this is where each one re-reads the account
    // that is now in use. The layout is the one that *had* to be told: it is
    // loaded at import, before there is an account to load for, so without this
    // call a switch kept the previous account's panes and mode in memory.
    layout.reload();
    chrome.load();
    reading.load();
    void reader.start(session).finally(() => (launched = true));

    // The mode is drawn from the real container width rather than from an
    // `innerWidth` guess, and the observer has one job: report that width.
    const observer =
      panes === null
        ? null
        : new ResizeObserver(([entry]) => layout.setAvailable(entry.contentRect.width));
    if (panes !== null && observer !== null) observer.observe(panes);

    // The observer is the measurement, and on this platform it is not always the
    // first to know: a frame that is dragged wider reports the new width to the
    // window before (or without) the grid's box changing, and a resize that
    // lands while a press's transition is still drawing used to leave the
    // columns at an interpolated width. So the window says so itself, the panes
    // are measured on the next frame as well, and the tracks are drawn without a
    // transition until the frame has stopped moving.
    const measure = (): void => {
      if (panes === null) return;
      layout.setAvailable(panes.clientWidth);
      // A press that is waiting on a resize already draws from the width it
      // asked for (`layout.pressing`), so the frame's own movement is not
      // what the tracks are made of — and arming `resizing` here would take the
      // transition off an element in the middle of the press's slide, which
      // lands the columns at the end value in one frame. That is the press that
      // snapped instead of sliding, and it only happened when the window
      // happened to report its new size while the slide was still running.
      //
      // `sliding` is the other half of it, and the half that made every press
      // with Keep widths on snap: the resize call lands in the middle of the
      // slide, `setAvailable` clears `pressing` as it lands, and this guard then
      // read false and armed `resizing` at the exact frame the transition was
      // due to finish its travel. Sharing the window, no press resizes anything,
      // so the slide was never interrupted — which is why only Keep widths broke.
      if (!layout.pressing && !sliding) {
        resizing = true;
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => (resizing = false), RESIZE_SETTLE_MS);
      }
      // Once more after layout: WebKit reports a resize before it has finished
      // laying out, so the width read in the event is sometimes the old one.
      requestAnimationFrame(() => {
        if (panes !== null) layout.setAvailable(panes.clientWidth);
      });
    };
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);

    window.addEventListener("keydown", onkeydown);
    return () => {
      window.removeEventListener("keydown", onkeydown);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      observer?.disconnect();
      reader.stop();
    };
  });

  function reduceMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function pageArticle(direction: -1 | 1): void {
    const el = document.querySelector<HTMLElement>('[data-scroll="article"]');
    if (el === null) return;
    el.scrollBy({
      top: direction * el.clientHeight * 0.85,
      behavior: reduceMotion() ? "auto" : "smooth",
    });
  }

  /**
   * The key map itself lives in `lib/keys.ts`; this carries the intents out.
   * Up/Down move between feeds in every mode, Right enters and Left backs out,
   * which is why article movement is Space, the toolbar buttons and scrolling.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const context = {
      typing: isTypingTarget(event.target),
      menuOpen: reader.menu !== null,
      hasArticle: reader.selectedId !== null,
      atArticleStart: reader.articleAtStart,
      atArticleEnd: reader.articleAtEnd,
    };
    const intent = event.shiftKey
      ? resolveShiftKey(event.key, context)
      : resolveKey(event.key, context);

    switch (intent.type) {
      case "none":
        return;
      case "stream":
        event.preventDefault();
        // Up/Down belong to the pane you are in: with a post on screen they walk
        // the posts, and with the feed list in hand they walk the feeds, which is
        // what they have always done here. Same list, same order as the view on
        // screen, so the step lands on something you can see.
        if (reader.selectedId !== null) {
          void reader.stepItem(intent.delta);
          return;
        }
        void reader.stepStream(intent.delta);
        return;
      case "first":
        event.preventDefault();
        void reader.firstStream();
        return;
      case "last":
        event.preventDefault();
        void reader.lastStream();
        return;
      case "enter":
        event.preventDefault();
        void reader.enter();
        return;
      case "back":
        event.preventDefault();
        // A drawer is the nearest thing in front of the reader, so it goes first:
        // one press closes the list, the next leaves the article.
        if (pulled) {
          pulled = false;
          return;
        }
        // Out of the article. In one column that is the feed list again, with
        // the feed you were reading still open where you left it.
        if (stackBack()) return;
        if (reader.back()) return;
        // Nothing open: Left still means "one column to the left", so the panes
        // give one up instead of the key doing nothing. The window is not asked
        // to shrink here — that belongs to the 1/2/3 buttons, and a key that
        // resizes the window would be a surprise you cannot undo with a key.
        layout.collapseOne();
        return;
      case "escape":
        if (pulled) {
          event.preventDefault();
          pulled = false;
          return;
        }
        if (reader.menu !== null) {
          event.preventDefault();
          reader.closeCategoryMenu();
          return;
        }
        if (reader.back()) event.preventDefault();
        return;
      case "page":
        event.preventDefault();
        if (intent.advance) void reader.advanceArticle(intent.direction);
        else pageArticle(intent.direction);
        return;
    }
  }

  function closeReader() {
    reader.closeReader();
  }

    /**
   * One column is a walk through the same three things the panes show side by
   * side: the feeds, the posts of one feed, and the article. Back therefore
   * steps exactly one of those at a time — article, then posts, then feeds — so
   * what you see happening matches where you land. Jumping straight from an
   * article to the feed list skips a screen you were just looking at, which
   * reads as the app losing your place.
   */
  const level = $derived(levelOf(reader.selectedId));


  /**
   * The panes are one grid, and every mode is a placement in it.
   *
   * They used to be `{#if}` branches, so a mode press destroyed and rebuilt the
   * panes it did not carry over: the feeds pane in one column was a different
   * component from the feeds pane in two, so the whole sidebar — rows, icons,
   * images, scroll — was torn down and decoded again on every walk across that
   * boundary, and the article list went with it. Here each pane is mounted once
   * and stays mounted: `paneSlots` says which ones are drawn, the grid's tracks
   * and the slot classes say where, and the ones that are not drawn are hidden
   * rather than removed.
   */
  const stackDrawn = $derived(layout.stacked && mode === 3);

  /**
   * Whether the feeds pane is folded away in the mode being drawn.
   *
   * One stored preference, honoured differently by each mode. Three panes fold
   * the feeds and give the stack the whole frame — that is the header's control
   * and `layout.collapsed` already says so. Two panes fold them and keep two
   * panes on screen: the posts and the article side by side, with the rail where
   * the feeds were. One column has nothing to fold and ignores the flag.
   *
   * `layout.collapsed` cannot answer this alone because it is defined as the
   * three-pane fold, and the fold has to be drawn from the mode the frame is
   * actually showing — so the view names the state it is drawing.
   */
  const folded = $derived(mode >= 2 && layout.sidebarCollapsed);

  /**
   * Reading in the list itself: a post opens out of its own row.
   *
   * This is what the Rows view's reading button means, and it is the opposite of
   * borrowing a column — the frame does not change at all. It is available in
   * two plain panes, where the sealed column beside the feeds is the only place
   * a post could otherwise be read; with three panes there is an article column
   * and the button is not offered.
   */
  const readInline = $derived(
    reading.readInPane && reading.listView === "regular" && mode === 2 && !folded,
  );

  /**
   * The post list as a sheet over a post opened in one column.
   *
   * One column is the phone, and there the list and the article are two jobs, not
   * two halves of a screen: the list is for browsing and the article for reading,
   * and a split gives each of them too little to do either. So in one column the
   * list is not a pane at all — it is a drawer pulled down over the article from
   * the top edge, and put back up when a post is chosen, because choosing is the
   * end of browsing. It used to stack instead, which put a permanent split where
   * a phone wanted a page.
   */
  const drawer = $derived(mode === 1 && level === "article");

  /**
   * Whether that drawer is down.
   *
   * Deliberately not a preference: it is open for the length of one browse, and
   * a list left hanging over a page the reader has walked away from would be
   * covering the feed list the next time they arrive.
   */
  let pulled = $state(false);

  /**
   * The drawer's edge, dragged.
   *
   * A press slides the sheet and a phone closes one with a thumb, so the same edge
   * takes a drag as well as a press: the sheet follows the pointer down and back
   * up, and on release goes to whichever half it is nearest — or the way it was
   * thrown, because a flick is how a drawer actually gets shut. `dragH` is the
   * height under the finger; it is null the rest of the time, when the stylesheet
   * owns the height and the press's own transition.
   */
  let dragH = $state<number | null>(null);
  let dragging = $state(false);
  let dragFromY = 0;
  let dragFromH = 0;
  let dragMaxH = 0;
  let dragMoved = false;
  let dragLastY = 0;
  let dragLastT = 0;
  let dragSpeed = 0;

  function grabDown(event: PointerEvent): void {
    const frame = panes;
    if (frame === null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragFromY = event.clientY;
    dragLastY = event.clientY;
    dragLastT = event.timeStamp;
    dragSpeed = 0;
    dragMaxH = Math.min(frame.clientHeight * 0.62, 560);
    dragFromH = postsSlot?.getBoundingClientRect().height ?? 0;
    dragH = dragFromH;
    dragging = true;
    dragMoved = false;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function grabMove(event: PointerEvent): void {
    if (!dragging) return;
    const dt = event.timeStamp - dragLastT;
    if (dt > 0) dragSpeed = (event.clientY - dragLastY) / dt;
    dragLastY = event.clientY;
    dragLastT = event.timeStamp;
    if (Math.abs(event.clientY - dragFromY) > 4) dragMoved = true;
    const next = dragFromH + (event.clientY - dragFromY);
    dragH = Math.max(0, Math.min(dragMaxH, next));
  }

  function grabUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    const height = dragH ?? dragFromH;
    // Nearest half, unless it was thrown: 0.5px/ms is slower than a flick and
    // faster than a considered drag, so it only answers a real throw.
    const thrown = Math.abs(dragSpeed) > 0.5 ? dragSpeed > 0 : null;
    pulled = thrown === null ? height > dragMaxH * 0.42 : thrown;
    // One frame with the height still pinned under the finger, then the stylesheet
    // takes it back: the release slides from where the finger left it rather than
    // jumping to the nearest end.
    requestAnimationFrame(() => {
      if (!dragging) dragH = null;
    });
  }

  function grabCancel(): void {
    if (!dragging) return;
    dragging = false;
    dragH = null;
  }

  $effect(() => {
    if (!drawer) {
      pulled = false;
      dragging = false;
      dragH = null;
    }
  });

  const slots = $derived.by(() => {
    const drawn = paneSlots({
      mode,
      level,
      stacked: stackDrawn,
      collapsed: folded,
      tuck: layout.stackTuck,
      swapped: layout.stackSwapped,
    });
    // A post open in its own row is still the posts column: the selection has
    // put a level on screen, but the page it would have drawn is inside the
    // list, so the list is what the column shows.
    if (readInline && drawn.article && !drawn.posts) {
      return { ...drawn, posts: true, article: false };
    }
    // The drawer needs both: the page underneath at its full size, so pulling the
    // list down covers what is being read instead of reflowing it.
    if (drawer) return { ...drawn, posts: true, article: true };
    return drawn;
  });

  /**
   * Is there article text on screen for the bar's A− and A+ to resize? An article
   * column, a page drawn over the list, or the one-pane view showing a post —
   * anywhere the page is what the reader is looking at. Where it is not — the
   * list alone, or the folded pair — the buttons resize the list instead.
   */
  const articleShown = $derived(
    Boolean(slots.article) || (readInline && reader.selectedId !== null) || level === "article",
  );

  /**
   * The frame's five column tracks, for the fold this mode draws.
   *
   * `paneSlots` and this are the same question asked twice — which panes, and
   * where — so both are given the one `folded` flag. `layout.columns()` still
   * draws every arrangement it can see; the two-pane fold is the view's own
   * because it is a change inside the frame rather than a resize of it, and no
   * path that folds a pane may ask the window for anything (`fitWindowTo` is
   * for the 1/2/3 buttons alone).
   */
  const columns = $derived(
    gridTemplate(mode, layout.shown, {
      // The width a press asked the window for while it is still on its way:
      // drawing from the live measurement meant a new track list on every resize
      // tick, and every one of those restarted the transition it was in the
      // middle of (see `layout.drawn`).
      available: layout.drawn,
      collapsed: folded,
      stacked: stackDrawn,
      keepWidths: layout.keepWidths,
    }),
  );

  /**
   * The same five tracks as numbers, for the panes to lay their content out at.
   *
   * A track that moves over a column that is laid out again every frame is an
   * expensive way to move a column: measured in WebKitGTK, one relayout of a
   * two-hundred-row posts list at a new width costs 16–20ms, and a slide asks for
   * one per frame — five to ten of them across a press. Laid out at the width the
   * slide ends at, the same track change costs 0–1ms (the content is only
   * clipped), and the rows are there before the column has any width at all.
   */
  const trackList = $derived(
    tracks(mode, layout.shown, {
      available: layout.drawn,
      collapsed: folded,
      stacked: stackDrawn,
      keepWidths: layout.keepWidths,
    }),
  );

  /**
   * True while the window itself is being resized.
   *
   * A window resize is the one change of the tracks that must never be drawn
   * over time: the frame is moving under the pointer, the panes are riding the
   * frame's edge, and a 185ms transition on top of that is a column that arrives
   * after the window has already stopped moving — pane two left behind the edge
   * it is supposed to end at. Interrupting that transition mid-flight is also
   * what leaves WebKit drawing an interpolated track list it never finishes.
   * The measurement and the class both come from the frame itself, not from a
   * press, so a press's own slide is untouched.
   */
  let resizing = $state(false);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long after the last resize event the frame counts as still moving. */
  const RESIZE_SETTLE_MS = 140;

  /**
   * True for the moment a press takes to move the columns.
   *
   * Armed by `layout.pressSeq`, which only a press bumps — a window resize, a
   * dragged divider and a settings slider all change the same tracks without
   * asking for the animation, and they must land in one frame (`sliding` also
   * carries the class the CSS transition hangs off, so this is what stops a
   * resize from feeling rubbery).
   */
  let sliding = $state(false);

  /**
   * The one timer that turns the slide off.
   *
   * Held here rather than returned as this effect's cleanup: the effect re-runs
   * whenever the slots it reads change, which outlives the press that armed it.
   * Clearing the timer on that rerun left `sliding` on for good — the tracks
   * were re-targeted under a live transition and the panes stayed drawn in the
   * arrangement they were leaving, which is a side-by-side press that looks
   * stacked.
   */
  let slideTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The panes themselves, so an arriving one can be given its own small bounce.
   * The bounce is a transform on the slot, never a wider track: see `ARRIVE`.
   */
  let feedsSlot = $state<HTMLElement | null>(null);
  let postsSlot = $state<HTMLElement | null>(null);
  let articleSlot = $state<HTMLElement | null>(null);

  /** Which panes were drawn on the last pass, to know what arrived. */
  let drawnSlots: { feeds: boolean; posts: boolean; article: boolean } | null = null;

  /** The press already drawn, so a non-press change of slots is not animated. */
  let animatedPress = 0;

  // A pre-effect, not an effect: this must be part of the same flush as the
  // track list it is arming. An effect runs after the DOM has taken the new
  // tracks, so the first change of a press was resolved with no transition on
  // the element — the browser then had to work out where the motion began, and
  // it began wherever the last frame happened to land. That was the lurch: the
  // first painted frame of a press was already a quarter of the way across, and
  // how far in depended on when the press fell inside a frame.
  $effect.pre(() => {
    // Read so the effect re-arms on every press, and on a change of feel.
    const press = layout.pressSeq;
    const ms = motionMs(layout.motion);
    const now = { feeds: slots.sidebar, posts: slots.posts, article: slots.article };
    const before = drawnSlots;
    drawnSlots = now;
    // Opening a post swaps the posts for the article without a press: that is a
    // change of content, not of layout, so it is drawn at once.
    if (press === animatedPress) return;
    animatedPress = press;
    if (press === 0) return;
    sliding = ms > 0;
    if (!sliding) return;
    // A press is the panes moving, and any resize it causes is the frame
    // following them. Drawing that flat would land the columns in one frame, so
    // a press takes the class off and leaves the frame's own travel to be drawn
    // by the tracks it is already heading for.
    resizing = false;
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    // A pane that was not drawn and now is: it comes in from its own side and
    // settles with a small overshoot. Panes that stay put and panes that leave
    // are untouched — the leaving ones keep their width and are clipped.
    const arrivals: Array<[boolean, HTMLElement | null, -1 | 1]> = [
      [now.feeds && before !== null && !before.feeds, feedsSlot, -1],
      [now.posts && before !== null && !before.posts, postsSlot, 1],
      [now.article && before !== null && !before.article, articleSlot, 1],
    ];
    for (const [arrived, element, from] of arrivals) {
      if (!arrived || element === null) continue;
      const frames: Keyframe[] = arriveKeyframes(from).map((frame) => ({
        transform: frame.transform,
        offset: frame.offset,
        easing: frame.easing,
      }));
      element.animate(frames, { duration: ms, easing: "linear", fill: "none" });
    }
    if (slideTimer !== null) clearTimeout(slideTimer);
    slideTimer = setTimeout(() => {
      sliding = false;
      slideTimer = null;
    }, ms + 70);
  });

  onDestroy(() => {
    if (slideTimer !== null) clearTimeout(slideTimer);
    slideTimer = null;
  });

  /**
   * What each pane is drawn at, measured as the press lands.
   *
   * A pane whose track is closing is *not* laid out at the width it is leaving
   * for: for a list of rows or a page of text, a track on its way to nothing is
   * a reflow per frame on the way down and a zero-width layout at the end, which
   * is the most expensive layout there is. Such a pane keeps the width it already
   * has and the closing track clips it — so its width is read here, before the
   * new tracks are written, and handed to its own slot as `--from`.
   *
   * This has to be a pre-effect: after the update the DOM already has the new
   * track list, and measuring it would (a) read the width we are moving to and
   * (b) flush the very change the transition is waiting to start from.
   */
  $effect.pre(() => {
    if (layout.pressSeq === 0 || panes === null) return;
    if (motionMs(layout.motion) === 0) return;
    for (const slot of panes.children) {
      const width = Math.round(slot.getBoundingClientRect().width);
      (slot as HTMLElement).style.setProperty("--from", `${width}px`);
    }
  });

  /** The article's own close button: out of the article, wherever you are. */
  function closeArticle(): void {
    if (mode === 1) stepBack();
    else closeReader();
  }

  function stepBack(): void {
    if (stepBackTarget(level) === "close-article") reader.closeReader();
  }

  /**
   * The stack's own back press, ahead of the walk's.
   *
   * The layers in front are the stack's: an overlay closes first, then the
   * article — and only when the stack has nothing left does the key mean what it
   * has always meant. False everywhere the stack is not drawn, so nothing about
   * one column, three columns or a desktop window changes.
   */
  function stackBack(): boolean {
    if (!slideStack) return false;
    const step = mobileNav.back();
    if (step === "overlay") return true;
    if (step === "article") return reader.back();
    return false;
  }

  /**
   * The article's own lock: home first, then the curtain.
   *
   * The jump is a local view change, so it happens immediately; the lock is a
   * write and catches up. Waiting for the server before moving would put the
   * network between the finger and the screen — the one thing the curtain is
   * for is getting away now.
   */
  function lockFromArticle(): void {
    goHome();
    void reader.lockHidden();
  }

  /** Home is the escape hatch: the feed list, in one press, from any depth. */
  function goHome(): void {
    if (mode === 1) reader.closeReader();
    showFeeds();
  }

  /** What the bar says you are looking at — one line, never wrapping. */
  const where = $derived(whereLabel(level, reader.activeTitle, reader.selected?.title ?? null));
  const backTo = $derived(backLabel(level, reader.activeTitle));

  /**
   * Swipe, for the phone layout: right is "out of here", left is "onward".
   *
   * Only horizontal-dominant, deliberate gestures count — a vertical flick is
   * the reader's own scrolling, and a short horizontal twitch is a mis-tap.
   */
  let swipeStart: { x: number; y: number; at: number } | null = null;

  function ontouchstart(event: TouchEvent): void {
    // The gesture belongs to the walk, which only one column has.
    if (mode !== 1) return;
    if (event.touches.length !== 1) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }

  function ontouchend(event: TouchEvent): void {
    if (mode !== 1) return;
    const start = swipeStart;
    swipeStart = null;
    if (start === null || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 64) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (Date.now() - start.at > 800) return;
    if (dx > 0) gestureBack();
    else gestureForward();
  }

  /** Right-swipe: one level out, the same step the back button takes. */
  function gestureBack(): void {
    stepBack();
  }

  /** Left-swipe: onward, into the first post of what is open. */
  function gestureForward(): void {
    if (reader.selectedId === null) void reader.enter();
  }

  /** The hamburger is the one-column way back to the feeds. */
  function showFeeds() {
    if (slideStack) {
      // Feeds are a pane in front here, not a mode: out of whatever is being
      // read, then the list slid in over the posts — the same two steps the
      // walk takes, as one press. Closing the article first is what keeps the
      // reader honest: a post still "open" behind the list would stop the next
      // one from arriving, because the level would not have changed.
      reader.closeReader();
      mobileNav.show(2);
      mobileNav.openPrevious();
      return;
    }
    if (layout.mode === 1) reader.closeReader();
    else layout.setMode(1);
  }
</script>

<div
  class="main"
  style={Object.entries(
    readingVars({
      textScale: reading.textScale,
      rowScale: reading.rowScale,
      leading: reading.leading,
      align: reading.textAlign,
      thumbScale: reading.thumbScale,
    }),
  )
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}
>
  <Header
    subtitle={account?.userName ?? session.email}
    server={session.serverUrl}
    controls={layoutSwitch}
    {onsignout}
    {onaddaccount}
    ontogglesidebar={showFeeds}
    textTarget={articleShown ? "article" : "list"}
  />

  <!-- The seam under the bar doubles as the activity light. -->
  <LoadAura />

  <!-- Feedback for actions that land: hide, pin, lock, a finished sync. -->
  <FloodLayer />

  {#if reader.error}
    <div class="error" role="alert">
      <span>{reader.error}</span>
      <button onclick={() => reader.dismissError()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <!-- The crumb strip belongs only to levels that have a level behind them: on
       the feeds surface back and home both go nowhere, so it was two dead
       buttons taking 34px off a column with none to spare. It sits outside the
       pane grid, which is also what keeps the grid's rows the same list in
       every mode — a row that appears and disappears would make the panes
       rescale instead of move. -->
  {#if mode === 1 && level !== "feeds"}
    <nav class="crumbs" aria-label="Location">
      <button
        class="step"
        onclick={stepBack}
        aria-label={backTo}
        title={backTo}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <button
        class="step"
        onclick={goHome}
        aria-label="Feeds"
        title="Feeds"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"
          ><path d="M2.5 7.2 8 2.5l5.5 4.7V13a.6.6 0 0 1-.6.6H3.1a.6.6 0 0 1-.6-.6Z" /></svg
        >
      </button>
      <span class="where" title={where}>{where}</span>
    </nav>
  {/if}

  {#if slideStack}
    <!-- The phone's sliding stack: the same three panes, one screen each, moved
         with transforms instead of drawn as columns. It replaces the grid below
         rather than living inside it, which is why a portrait phone that chose
         `single` runs the markup under `{:else}` untouched. -->
    <MobilePaneStack
      nav={mobileNav}
      onframe={(element) => (panes = element)}
      onClose={closeArticle}
      onLock={mode === 1 ? lockFromArticle : undefined}
    />
  {:else}
  <!-- One grid, every pane, always mounted. The tracks are five lengths in every
       mode (see `gridTemplate`), so moving between layouts is a change of widths
       rather than a rebuild, and a change of widths is something CSS can draw
       over time. Which pane is in which slot is a class; whether it is drawn at
       all is `paneSlots`, and "not drawn" means hidden, never removed. -->
  <!-- The one-column walk owns the swipe gesture; the grid is a container, not a
       control, so there is no widget role to give it. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="panes"
    class:one={mode === 1}
    class:two={mode === 2}
    class:three={mode === 3}
    class:stacked={stackDrawn}
    class:swapped={layout.stackSwapped}
    class:tucked={stackDrawn && layout.stackTuck !== null}
    class:folded={mode === 2 && folded}
    class:sliding
    class:resizing
    bind:this={panes}
    style:grid-template-columns={columns}
    style:grid-template-rows={layout.rows(stackDrawn)}
    style:--slide-ms={`${motionMs(layout.motion)}ms`}
    style:--slide-ease={motionEase(layout.motion)}
    style:--t1={`${trackList[0]}px`}
    style:--t2={`${trackList[1]}px`}
    style:--t3={`${trackList[2]}px`}
    style:--t4={`${trackList[3]}px`}
    style:--t5={`${trackList[4]}px`}
    {ontouchstart}
    {ontouchend}
  >
    <!-- The feed list. `inlinePosts` is the one-column walk: a feed opens its
         posts underneath itself instead of into a column. It is a prop rather
         than a second component, so the walk does not have to rebuild the list
         it is walking out of. -->
    <div class="slot feeds" class:away={!slots.sidebar} bind:this={feedsSlot}>
      <Sidebar inlinePosts={mode === 1} />
    </div>

    <div class="slot seam-x gut-feeds" class:away={!slots.seam}>
      <PaneGutter which="sidebar" fold={mode === 2 && !folded} />
    </div>

    <!-- The rail: what the folded feeds leave in two panes. It takes the seam's
         track, so the fold is a move within the frame, and it holds the way
         back — a button rather than a hidden edge, always drawn, because a 6px
         strip that only appears under the pointer is a strip nobody finds. -->
    <div class="slot rail" class:away={!slots.rail}>
      <button
        type="button"
        class="restore"
        aria-label="Show the feeds pane"
        title="Show the feeds pane"
        onclick={() => layout.toggleSidebar()}
      >
        <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M2 1.5 6 6l-4 4.5" /></svg>
      </button>
    </div>

    <!-- The posts column. A post opened here grows out of its own row, so the
         list is never covered and never inert: there is nothing on top of it. -->
    <div
      class="slot posts"
      class:away={!slots.posts}
      class:drawer
      class:pulled={drawer && (pulled || dragging)}
      inert={drawer && !pulled}
      style:height={dragH === null ? null : `${dragH}px`}
      style:transition-duration={dragging ? "0ms" : null}
      bind:this={postsSlot}
    >
      <ArticleList onOpen={() => (pulled = false)} />
    </div>

    <div class="slot seam-x gut-posts" class:away={!slots.seamPosts}>
      <PaneGutter which="list" />
    </div>

    <div class="slot article" class:away={!slots.article} bind:this={articleSlot}>
      <ReaderPane onClose={closeArticle} onLock={mode === 1 ? lockFromArticle : undefined} />
    </div>

    <!-- The seam between the posts and the article when they are stacked: the
         swap and tuck controls live on it, and it stays where the share is even
         while one of the two panes is away. -->
    <div class="slot seam-y gut-stack" class:away={!slots.seamStack}>
      <PaneGutter axis="y" />
    </div>

    {#if drawer}
      <!-- The pull hangs from the drawer's bottom edge — the top of the pane
           while it is up — and is the only thing on the page that is not the
           page. A press or a swipe on the sheet's edge does the same job as the
           arrow; the scrim below it means a press anywhere else puts it back. -->
      <button
        type="button"
        class="grab"
        class:down={pulled || dragging}
        aria-label={pulled ? "Put the post list back up" : "Pull the post list down"}
        title={pulled ? "Put the post list back up" : "Pull the post list down"}
        aria-expanded={pulled}
        style:top={dragH === null ? null : `${dragH}px`}
        style:transition-duration={dragging ? "0ms" : null}
        onpointerdown={grabDown}
        onpointermove={grabMove}
        onpointerup={grabUp}
        onpointercancel={grabCancel}
        onclick={() => {
          if (dragMoved) {
            dragMoved = false;
            return;
          }
          pulled = !pulled;
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {#if pulled}
            <path d="M3.6 9.6 8 5.2l4.4 4.4" />
          {:else}
            <path d="M3.6 6.4 8 10.8l4.4-4.4" />
          {/if}
        </svg>
      </button>
      {#if pulled}
        <div class="scrim" role="presentation" onclick={() => (pulled = false)}></div>
      {/if}
    {/if}
  </div>
  {/if}

  {#if menu}
    <CategoryMenu
      x={menu.x}
      y={menu.y}
      model={menu.model}
      busy={reader.hiddenBusy || reader.favoritesBusy || reader.feedBusy}
      onselect={(action) => void reader.applyMenuAction(action)}
      onclose={() => reader.closeCategoryMenu()}
    />
  {/if}
</div>

{#snippet layoutSwitch()}
  <!-- Fold the feeds pane away. It lives beside the pane switch because both
       answer "what do I want on screen", and it is drawn only where there is a
       sidebar to fold: one column has nothing to collapse. -->
  {#if mode === 3}
    <button
      class="fold"
      class:on={layout.collapsed}
      aria-pressed={layout.collapsed}
      aria-label={layout.collapsed ? "Show the feeds pane" : "Collapse the feeds pane"}
      title={layout.collapsed ? "Show the feeds pane" : "Collapse the feeds pane"}
      onclick={() => layout.toggleSidebar()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {#if layout.collapsed}
          <path d="M6 3.5 10.5 8 6 12.5" />
        {:else}
          <path d="M10 3.5 5.5 8 10 12.5" />
        {/if}
      </svg>
    </button>
  {/if}
  <!-- No pane-count switch where there is one column: the buttons could only
       report a choice the screen cannot honour. -->
  {#if layout.caps.paneCount}
    <LayoutSwitch />
  {/if}
{/snippet}

<style>
  /* The fold toggle: the same quiet weight as the pane switch beside it. */
  .fold {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--edge-soft);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    transition: color 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;
  }

  .fold svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .fold:hover {
    color: var(--text);
    background: var(--hover);
  }

  .fold.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 50%, var(--edge-soft));
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    /* clip, not hidden: hidden would make this a scroll container and take the
       scrolling away from the panes inside it. */
    overflow-x: clip;
  }

  .panes {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    /* Five tracks in every mode — feeds, its seam, the posts, their seam, the
       article — replaced inline from `layout.columns()`. A track list that
       changes length cannot be interpolated, which is why the modes share one
       list instead of each writing its own. This value is the first-paint
       fallback: one column, before the measured width arrives. */
    grid-template-columns: minmax(0, 1fr) 0 0 0 0;
    overflow: hidden;
  }

  /* The slide. Only a press turns this on (`sliding`), so a window resize, a
     divider drag and a settings slider still land in a single frame — they
     change the same tracks, and drawing them over 175ms would be lag on the
     thing the user is dragging. Both tracks move, because the stack splits rows
     and the modes split columns. */
  .panes.sliding {
    transition:
      grid-template-columns var(--slide-ms, 0ms) var(--slide-ease, ease),
      grid-template-rows var(--slide-ms, 0ms) var(--slide-ease, ease);
  }
  /* The frame is being resized: the tracks land where the window is, every
     tick, with nothing in between. Later in the sheet than `sliding` on
     purpose — same specificity, so this is what wins while the frame moves. */
  .panes.resizing {
    transition: none;
  }


  /* While a track moves, its pane's content is laid out at the width it will
     end at — `max(final, the track right now)`:
       - a column that is opening is laid out once, at its final width, and the
         opening track *reveals* it: the list is already drawn, so the frame that
         first shows the column shows its rows, and the slide asks the engine for
         no layout of that pane at all (measured in WebKitGTK with two hundred
         rows: the first row of the column is painted 51–78ms after the click, in
         every configuration tried, with no frame where the column was wide and
         empty);
       - a column that is closing follows its track down, which is the one case
         where the content *should* move with the track: it is a squeeze, the
         same one a window resize gives, and it lands exactly on the final width
         so nothing jumps when the slide ends.
     Either way the content never jumps against the track, and it is never laid
     out at a width it will not have.

     A pane that is leaving is the exception: its track is on its way to nothing,
     so it keeps the width it was drawn at (`--from`, measured as the press
     landed) and the closing track clips it. Laid out at zero it would be a
     column of one-word lines. */
  .panes.sliding .slot.feeds:not(.away) > :global(*) {
    flex: 0 0 auto;
    width: max(var(--t1), 100%);
  }

  .panes.sliding .slot.rail:not(.away) > :global(*) {
    flex: 0 0 auto;
    width: max(var(--t2), 100%);
  }

  .panes.sliding .slot.posts:not(.away) > :global(*) {
    flex: 0 0 auto;
    width: max(var(--t3), 100%);
  }

  /* The article is drawn in four different tracks: the only one in one column,
     the second column while a post is open in two, its own in three, and the
     third — beside the posts — when the pair is stacked. */
  .panes.sliding .slot.article:not(.away) > :global(*) {
    flex: 0 0 auto;
    width: max(var(--t5), 100%);
  }

  .panes.sliding.two:not(.folded) .slot.article:not(.away) > :global(*) {
    width: max(var(--t3), 100%);
  }

  .panes.sliding.stacked .slot.article:not(.away) > :global(*),
  .panes.sliding.stacked .slot.posts:not(.away) > :global(*) {
    width: max(var(--t3), 100%);
  }

  .panes.sliding.one .slot.article:not(.away) > :global(*) {
    width: max(var(--t1), 100%);
  }

  /* ...and the ones that are leaving keep the width they have. Scoped out of the
     rules above, so no track's rule can win over it. */
  .panes.sliding .slot.away > :global(*) {
    flex: 0 0 auto;
    width: var(--from, 100%);
  }

  /* A pane that is being drawn paints over one that is leaving, whatever order
     they are in. Two slots can share a track — the posts and the article both
     live in the third column of two panes, and in one column both live in the
     first — so the pane that is on its way out is still visible for the length
     of the slide, and without this it painted *over* the pane that replaced it:
     the posts column arrived holding the article's empty state, and its rows
     only appeared when `visibility` finally flipped. */
  .panes.sliding .slot:not(.away) {
    z-index: 1;
  }

  /* ...but a seam is not a pane: its chip straddles the track it lives in and
     has to paint over both of its neighbours, which the rule above would
     otherwise take away for the length of the slide. */
  .panes.sliding .slot.seam-x,
  .panes.sliding .slot.seam-y {
    z-index: 2;
  }

  /* A pane's slot. It is always in the grid and always has a parent that never
     changes, which is what keeps the components inside it mounted: moving a
     component between parents is a new component. Flex, so whatever is inside
     fills the slot on both axes — a seam is a 6px track and has to be exactly
     that tall to be draggable. */
  .slot {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .slot > :global(*) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  /* The list fills its pane, and keeps its own box: an opened post grows inside
     the column rather than over it. */
  .slot.posts > :global(*) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  /* One column with a post open: the list is a sheet over the page, pulled down
     from the top edge and pushed back up. It is not a split — the article keeps
     its size, its scroll and its place underneath, so browsing the list and
     reading are one press apart instead of one reflow apart. The slide is the
     panes' own motion, so reduced motion cuts instead of sliding. */
  .panes.one .slot.posts.drawer {
    position: absolute;
    inset: 0 0 auto 0;
    /* Its own grid area would place it in the posts' track, which in one column
       has no width at all: an absolutely positioned grid child is placed in its
       area, not in the frame. So the area is the whole frame. */
    grid-column: 1 / -1;
    grid-row: 1 / -1;
    z-index: 6;
    height: 0;
    overflow: hidden;
    background: var(--bg);
    pointer-events: none;
    visibility: hidden;
    transition:
      height var(--slide-ms, 0ms) var(--slide-ease, ease),
      visibility 0s linear var(--slide-ms, 0ms);
  }

  .panes.one .slot.posts.drawer.pulled {
    height: var(--sheet-h);
    visibility: visible;
    pointer-events: auto;
    border-bottom-left-radius: 14px;
    border-bottom-right-radius: 14px;
    box-shadow: 0 14px 30px rgb(0 0 0 / 0.42);
    transition:
      height var(--slide-ms, 0ms) var(--slide-ease, ease),
      visibility 0s;
  }

  /* The pull: a tab on the drawer's edge, the same language as the tab left by a
     tucked pane, and the one control that is on the page but not of it. */
  .panes.one .grab {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 9;
    display: grid;
    place-items: center;
    width: 44px;
    height: 24px;
    padding: 0;
    transform: translateX(-50%);
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 10px 10px;
    background: var(--bg-alt);
    color: var(--muted);
    box-shadow: 0 4px 10px rgb(0 0 0 / 0.26);
    cursor: pointer;
    transition: top var(--slide-ms, 0ms) var(--slide-ease, ease);
  }

  /* A drag on the edge is the drawer's, not the browser's: without this the touch
     scrolls the page under the finger and the sheet never moves. */
  .panes.one .grab {
    touch-action: none;
    cursor: grab;
  }

  .panes.one .grab:active {
    cursor: grabbing;
  }

  /* A thumb, not a hairline: the tab is 24px tall because that is what the shape
     wants, so the target around it is the size a finger actually is. */
  .panes.one .grab::before {
    content: "";
    position: absolute;
    /* Sideways and down, never up: above the tab is the crumb bar, and a tab that
       eats presses meant for the trail is a tab in the way. */
    inset: 0 -10px -12px;
  }

  .panes.one .grab.down {
    top: var(--sheet-h);
    border-bottom: 0;
  }

  .panes.one .grab:hover,
  .panes.one .grab:focus-visible {
    color: var(--text);
  }

  .panes.one .grab svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Below the sheet only: the page is visible, dimmed, and a press on it is the
     press that puts the list back. */
  .panes.one .scrim {
    position: absolute;
    inset: var(--sheet-h) 0 0;
    z-index: 7;
    background: rgb(0 0 0 / 0.4);
  }

  /* A seam is not a pane: the chip that carries the stack's controls straddles
     the 6px track and must be allowed to paint over both panes. */
  .slot.seam-x,
  .slot.seam-y {
    overflow: visible;
  }

  /* Not drawn is hidden, never removed: the sidebar keeps its rows, its images
     and its scroll, and the list keeps the reader's place in it. */
  .slot.away {
    visibility: hidden;
  }

  /* ...but a pane that is leaving stays visible for the length of the slide, so
     the column closes over content instead of over a hole. `visibility` flips at
     the end of the delay in the away direction, and immediately on the way back
     (the rule below only exists on the away side). */
  .panes.sliding .slot.away {
    transition: visibility 0s linear var(--slide-ms, 0ms);
  }

  /* Where each pane sits. Columns are the five tracks above; rows are the four
     `layout.rows()` draws. Side by side and two-pane layouts span every row. */
  .slot.feeds {
    grid-column: 1 / 2;
    grid-row: 1 / -1;
  }

  .slot.gut-feeds {
    grid-column: 2 / 3;
    grid-row: 1 / -1;
  }

  /* The rail stands where the folded feeds' seam was: the second track, which
     is 6px once the first one is drawn at 0 — the far left of the frame. */
  .slot.rail {
    grid-column: 2 / 3;
    grid-row: 1 / -1;
  }

  .slot.posts {
    grid-column: 3 / 4;
    grid-row: 1 / -1;
  }

  .slot.gut-posts {
    grid-column: 4 / 5;
    grid-row: 1 / -1;
  }

  .slot.article {
    grid-column: 5 / 6;
    grid-row: 1 / -1;
  }

  /* How much of the pane the drawer covers. A share of the pane rather than a
     fixed height, so a phone and a desktop window both get the same proportion
     of list, capped so a tall window does not hand the list two thirds of it. */
  .panes.one {
    --sheet-h: min(62%, 560px);
  }

  /* One column: the surface is the first track, and only the first. With
     "Keep window" it keeps its own width and the rest of the frame is empty —
     pressing 1 changes what is drawn inside the frame, not the frame. */
  .panes.one .slot.feeds,
  .panes.one .slot.article {
    grid-column: 1 / 2;
  }

  /* Two panes: the second column is the posts, and the article takes the same
     column while one is open. */
  .panes.two .slot.posts,
  .panes.two .slot.article {
    grid-column: 3 / 4;
  }

  /* Two panes with the feeds folded: the posts keep the third track they always
     have, and the article moves out of it into the fifth, with their own seam in
     the fourth. Two panes side by side — folding the feeds away must not leave
     one stretched column, which is what one-pane mode is for. */
  .panes.two.folded .slot.article {
    grid-column: 5 / 6;
  }

  /* Three panes side by side already sit in their own tracks. Stacked, the two
     right-hand panes share the third track and split it into rows, and the seam
     between them takes the third row. */
  .panes.stacked .slot.posts,
  .panes.stacked .slot.article {
    grid-column: 3 / -1;
  }

  .panes.stacked .slot.posts {
    grid-row: 2 / 3;
  }

  .panes.stacked .slot.article {
    grid-row: 4 / 5;
  }

  /* A swap is an order, not a re-division: the two panes trade rows and the
     split — a fraction of the column — does not move. */
  .panes.stacked.swapped .slot.posts {
    grid-row: 4 / 5;
  }

  .panes.stacked.swapped .slot.article {
    grid-row: 2 / 3;
  }

  .panes.stacked .slot.gut-stack {
    grid-column: 3 / -1;
    grid-row: 3 / 4;
  }

  /* A tucked half leaves one pane filling the column, and the seam is drawn over
     it at the share it will come back to — so the seam's slot spans every row
     and becomes the containing block the overlay is measured against. */
  .panes.stacked.tucked .slot.posts,
  .panes.stacked.tucked .slot.article,
  .panes.stacked.tucked .slot.gut-stack {
    grid-row: 1 / -1;
  }

  .panes > :global(*) {
    min-height: 0;
  }

  /* The rail's button: the whole 6px strip and the whole height, because 6px of
     width is not a target on its own. It is drawn from the first paint rather
     than on hover — the strip is the only thing left saying where the feeds went
     — and it strengthens when the pointer or the keyboard arrives. */
  .restore {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    border-right: 1px solid var(--edge-soft);
    background: color-mix(in srgb, var(--surface) 70%, var(--bg));
    color: var(--muted);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .restore:hover,
  .restore:focus-visible {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 22%, var(--surface));
  }

  .restore:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .restore svg {
    width: 6px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 34px;
    padding: 0 8px;
    border-bottom: 1px solid var(--edge);
    background: var(--surface);
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    flex: none;
  }

  /* Fixed-size, fixed-order controls: the pair keeps its geometry at every
     level, so pressing back never moves the thing you press next. */
  .step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .step svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .step:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .step:disabled {
    opacity: 0.32;
    cursor: default;
  }

  .where {
    min-width: 0;
    margin-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-dim);
  }

  /* Thumbs need bigger targets than pointers do. */
  @media (pointer: coarse) {
    .step {
      width: 34px;
      height: 34px;
    }

    .crumbs {
      height: 42px;
    }
  }

  .error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    font-size: 12.5px;
    color: #ffd9d9;
    background: #6b1d1d;
  }

  .error span {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .error button {
    border: 0;
    background: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
  }
</style>
