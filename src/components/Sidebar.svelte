<script lang="ts">
  import ArticleList from "./ArticleList.svelte";
  import IndentControl from "./IndentControl.svelte";
  import SidebarBand from "./SidebarBand.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { READING_LIST, STATE_STARRED, type Subscription } from "../api/freshrss";
  import {
    LongPressTracker,
    anchorForRect,
    armsLongPress,
    isMenuKey,
  } from "../lib/contextmenu";
  import { parseFeedUrls } from "../lib/add-feeds";
  import { DEMO } from "../lib/demo";
  import { exportFeedsOpml, importFeedsFile } from "../lib/feeds-io";
  import {
    DEFAULT_ICON_PROVIDER,
    feedIcon,
    feedIconImage,
    markFeedIconBroken,
    type FeedIcon,
    type FeedIconFailures,
    type FeedIconProvider,
  } from "../lib/feedicon";
  import { pullDown } from "../lib/pull";
  import { createFeedDrag, LIST_CATEGORIES } from "../lib/feed-drag";
  import { reading } from "../state/reading.svelte";
  import { reader, type CategoryGroup } from "../state/reader.svelte";
  import { MARKER_PATH, pinWords } from "../lib/theme";
  import { statusFacts } from "../lib/band";
  import { groupHits, searchFeeds } from "../lib/search";
  import { authorPanel, peoplePanel, toggleSearch } from "../lib/people";
  import { search } from "../state/search.svelte";
  import { people } from "../state/people.svelte";
  import { theme } from "../state/theme.svelte";
  import { chrome } from "../state/chrome.svelte";
  import { layout } from "../state/layout.svelte";

  const words = pinWords();

  /**
   * The strip at the foot of the sidebar: the hidden count, the ENFORCED badge
   * and the pinned count, in the band's own three-state rule.
   *
   * A lock empties the hidden half — the count and the badge both — so the only
   * number left on screen is the one that says what to show, not what is hidden.
   */
  const strip = $derived(
    statusFacts({
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      hiddenCount: reader.hiddenCount,
      enforced: reader.hiddenEnforced,
      pinnedCount: reader.pinnedCount,
    }),
  );

  /** Something typed: the sidebar shows results instead of the tree. */
  const searching = $derived(search.query.trim() !== "");

  /**
   * A phone held upright, where the bottom of the pane is compressed.
   *
   * A feed list is imported and exported a handful of times in a year, and the
   * footer these two buttons sit in is the last strip above the home indicator —
   * every pixel of it comes straight out of the tree. So upright on a phone the
   * footer keeps the one control that is used (`+ Add feed`) and the two file
   * actions move into `Settings → Feeds`, which the phone header's `•••` opens.
   * Sideways, and on every other device, nothing moves: a landscape phone has
   * the height for the full block and a desktop has always had it, file-name
   * line included. */
  const compressedFooter = $derived(layout.device === "phone" && layout.upright);

  /**
   * A phone's sidebar, which carries one row fewer than a window's.
   *
   * The `Indent` row — the label, its number and the slider under them — is a
   * look-setting, not content, and it was permanent: two lines at the top of the
   * one column a phone has. It lives in `Settings → Feeds` instead, where the
   * same `IndentControl` sits on a row of its own, and the day / night switch
   * moves beside the band rather than owning a row of its own.
   *
   * Nothing is dropped: the indent is the same slider and the same reader write
   * on both surfaces, and the switch is the same `ThemeToggle`. Every other
   * device keeps the row exactly where it was, which is why this is one gate and
   * not a second layout.
   */
  const phoneSidebar = $derived(layout.device === "phone");

  /**
   * The field itself.
   *
   * Held so clearing can be a write to the input and not only to the state
   * behind it: a search input keeps its own value, and an empty query behind a
   * box still showing text reads as a field that will not clear.
   */
  let findBox = $state<HTMLInputElement | null>(null);

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

  /**
   * What the field is searching right now.
   *
   * The toggle is always in the field — a control that appears only on some
   * servers makes the same field a different width per account, and a mode with
   * no way to see it is a mode nobody finds. Availability decides what the
   * toggle searches, never whether it is there: names where the server can look
   * them up, the account's own authors where it cannot.
   */
  const mode = $derived(people.modeFor(reader.session));

  /** The second search itself, which is also what the field promises while off. */
  const second = $derived(people.secondFor(reader.session));

  /**
   * What the list says while people mode is on.
   *
   * The toggle is exclusive, so this is the whole of the list in that mode: the
   * feed and category rows are not drawn beside it, and there is nothing to
   * fall back to when the answer is empty or broken — which is why "broke" and
   * "nothing matched" are two different answers here rather than one line.
   */
  const panel = $derived(
    peoplePanel({
      query: search.query,
      settled: people.settled(search.query),
      count: people.results.length,
      note: people.note,
    }),
  );

  /**
   * People rows, with the feed each one already is when it is subscribed.
   *
   * The lookup answers with a name and whether it is subscribed, never with a
   * stream id — so the feed to open is found in the sidebar by that name. A
   * subscribed name with no feed behind it is drawn as a plain statement rather
   * than a button that would do nothing.
   */
  const peopleRows = $derived(
    people.results.map((person) => {
      const name = person.name.toLocaleLowerCase();
      return {
        name: person.name,
        added: person.added,
        feed: reader.subscriptions.find((feed) => feed.title.toLocaleLowerCase() === name) ?? null,
      };
    }),
  );

  /**
   * The author index, kept in step with the posts the app already holds.
   *
   * Nothing here asks for anything: the index is rebuilt when the held post
   * list changes — a page of older posts, or another stream — and left alone
   * while only the field changes, so typing costs a scan of a list already in
   * memory. Built even while the toggle is off, because the mode has to be able
   * to answer on the first keystroke after it is turned on.
   */
  $effect(() => {
    people.indexAuthors(reader.items);
  });

  /** The author rows what is typed narrows the index to. */
  const authorRows = $derived(people.authorMatches(search.query));

  /**
   * What author mode says: what to type, then the truth about the answer. There
   * is no waiting state — the index is in memory, so the answer is the same
   * frame as the keystroke.
   */
  const authorView = $derived(authorPanel(search.query, authorRows.length));

  /**
   * Typing drives the lookup, once the field has rested. The store abandons the
   * request before the last keystroke, so a slow answer to "ant" cannot arrive
   * under "antonio".
   */
  $effect(() => {
    people.watch(search.query, reader.session, mode);
  });

  /**
   * The author filter only exists while its mode does. Availability can change
   * under a session (a fresh `/state` answer), and a narrow list with no row on
   * screen to widen it again would be a filter the user cannot see or lift.
   */
  $effect(() => {
    if (mode !== "author" && reader.authorFilter !== null) reader.setAuthorFilter(null);
  });

  function togglePeople() {
    // One turn decides the mode, the text and the filter together, so the three
    // cannot disagree about what a press meant.
    const turn = toggleSearch({ enabled: people.enabled, query: search.query, author: reader.authorFilter });
    people.setEnabled(turn.enabled);
    // Off is the whole feed list: the author the posts were narrowed to is let
    // go with the mode, so nothing stays filtered behind an off toggle.
    reader.setAuthorFilter(turn.author);
    if (turn.query === search.query) return;
    // Off, and there was something in the field: the empty query is what brings
    // the whole feed list back, and it is written to the input as well as to the
    // state — a search input keeps its own value, and an empty query behind a
    // box that still shows text reads as a field that will not clear.
    search.clear();
    if (findBox !== null) findBox.value = "";
  }

  /**
   * A picked author narrows the posts and nothing else: the mode stays on and
   * the field keeps what is typed, so the rows under it still answer the same
   * name and the way back is in sight rather than a blank box.
   */
  function chooseAuthor(name: string) {
    reader.setAuthorFilter(reader.authorFilter === name ? null : name);
  }

  /**
   * The field's own ×: both kinds of search end with it, so it clears the query
   * and the author filter together — otherwise the posts would stay narrowed by
   * a name the field no longer shows.
   */
  function clearFind() {
    search.clear();
    reader.setAuthorFilter(null);
    if (findBox !== null) findBox.value = "";
  }

  /**
   * A person row is one of two things: a subscription to add, or a feed to open.
   */
  async function choosePerson(name: string, added: boolean, feed: Subscription | null) {
    if (!added) {
      if (await people.add(reader.session, name)) await reader.loadSidebar();
      return;
    }
    if (feed === null) return;
    if (inlinePosts) jumpTo(feed);
    else void open(feed.id, feed.title);
  }

  function submitSearch(event: KeyboardEvent) {
    if (event.key === "Escape") clearFind();
  }

  function toggleDeep() {
    void search.setDeep(!search.deep, reader.subscriptions, reader.session);
  }

  /**
   * `inlinePosts` is the one-panel layout: there is no posts column to step
   * into, so a feed opens under itself and the reader is the only thing that
   * replaces the sidebar.
   *
   * `iconProvider` is where a feed's mark comes from. The default is the
   * feed's own icon, served by the server this client is signed in to; a
   * build for local feeds with no FreshRSS behind them can pass `third-party`
   * instead. Until it does, nothing is ever requested from a third party.
   */
  let {
    inlinePosts = false,
    iconProvider = DEFAULT_ICON_PROVIDER,
    onconnect,
  }: {
    inlinePosts?: boolean;
    iconProvider?: FeedIconProvider;
    /**
     * Opens the connect-a-service screen. It is the same one the account panel
     * presses, handed down rather than rebuilt here: syncing is an offer the
     * empty library makes, not a second way into it.
     */
    onconnect?: () => void;
  } = $props();

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
   * A library with nothing in it yet.
   *
   * The one moment the panel has to say what it is for. It is the same three
   * answers the old one-line notice used — the feeds mode, no subscriptions and
   * no load in flight — so nothing is re-decided here; the block that draws on
   * it only says more. It goes the moment a feed arrives, because a list with
   * one feed in it needs no introduction.
   */
  const emptyLibrary = $derived(
    mode === "feeds" && reader.subscriptions.length === 0 && !reader.loadingList,
  );

  /**
   * Whether the invitation is still on screen.
   *
   * The add form lives in the footer, so pressing `+ Add feed` in the block has
   * to give way to it: the invitation stands aside while the form is open
   * rather than offering the same control twice, and it never comes back once a
   * feed exists.
   */
  const startsHere = $derived(emptyLibrary && !adding);

  /**
   * Image URLs that failed to load. A dead icon falls back to the letter tile
   * instead of leaving a broken-image gap in the list, and the failure is
   * remembered against the URL, so a feed whose icon changes is tried again.
   */
  let brokenIcons = $state<FeedIconFailures>({});

  /**
   * The mark for a feed: its icon through the chosen provider, or its initial.
   * Resolved once per feed shape and remembered, so a re-render is a lookup
   * and never another request for an icon already on screen.
   */
  function iconFor(feed: Subscription): FeedIcon {
    return feedIcon(feed, { serverUrl: reader.session?.serverUrl ?? "", provider: iconProvider });
  }

  /**
   * Set when a long press has opened the menu, so the click that the browser
   * still sends on lift does not also open the category stream.
   */
  let swallowClick = false;
  let press: LongPressTracker | null = null;

  /**
   * The category the last tap in one panel selected.
   *
   * One panel has no separate posts column, so a tap on a category cannot mean
   * "open" and "fold" at once without one of them happening by accident: the
   * first tap picks the category, the next one on the same category opens it.
   */
  let pickedCategory = $state<string | null>(null);

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

  /**
   * The category's own name, which does two things at once.
   *
   * A category is a feed: FreshRSS labels are streams, so the name opens every
   * post in every feed under it — and it still folds and unfolds the group, which
   * is what the name did before there was anything else to do with it.
   *
   * One panel is the exception, because the list is the screen: the first tap
   * only selects the category (unfolded, so its feeds are in front of you), and
   * the second tap on the same, already-selected category is the one that opens
   * its posts. Below that a tap folds and unfolds as it always did.
   */
  function clickCategory(category: CategoryGroup, folded: boolean) {
    if (categoryDrag.justDropped()) return;
    if (!inlinePosts) {
      toggle(category.id);
      openCategory(category);
      return;
    }
    if (pickedCategory !== category.id) {
      pickedCategory = category.id;
      if (folded) toggle(category.id);
      return;
    }
    if (reader.activeStream !== category.id) {
      if (folded) toggle(category.id);
      openCategory(category);
      return;
    }
    toggle(category.id);
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
   * Pulling the list down asks for news.
   *
   * With a feed open that means that feed; with nothing open there is no "that
   * feed", so it is the whole account — the same thing the sync button does.
   */
  function pullRefresh(): void {
    if (reader.activeStream !== "") void reader.reloadStream({ force: true });
    else void reader.refresh();
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
    // Same press, two readings: a small move is still a click or a long press, a
    // real drag cancels the press and the menu never opens behind it.
    categoryDrag.arm(event, category.id);
  }

  /**
   * Where a dragged feed would land, while a feed is being dragged.
   *
   * Held here rather than in the drag module so the sidebar can draw the
   * insertion line: the module only says what is under the pointer, the markup
   * decides what that looks like.
   */
  let drop = $state<{ target: string; before: string | null } | null>(null);

  /**
   * Where a dragged *category* would land. A second value, not a second module:
   * the two drags never arm at once, because each only arms from its own rows
   * and a category title is never a feed row.
   */
  let catDrop = $state<{ target: string; before: string | null } | null>(null);

  // The drop rules live with the drag (`FEED_ROWS` in `lib/feed-drag.ts`): a
  // feed dropped just over a folder's title belongs to the folder *above* it —
  // the space above a title is where the previous folder ends, not a way into
  // this one. The rows carry the attributes those rules read.
  const feedDrag = createFeedDrag({
    // A drag and a long-press start the same way; the drag wins once the
    // pointer travels, so the context menu must not open behind it.
    onStart: () => cancelPress(),
    onHover: (target) => (drop = target),
    onEnd: () => (drop = null),
    onDrop: ({ moving, target, before }) => {
      void reader.arrangeFeed(moving, target, before);
    },
  });

  const categoryDrag = createFeedDrag(
    {
      onStart: () => cancelPress(),
      onHover: (target) => (catDrop = target),
      onEnd: () => (catDrop = null),
      // Order only: nothing about membership, hidden state or pins moves, and
      // nothing is sent — this is a local arrangement, like the feeds'.
      onDrop: ({ moving, before }) => reader.arrangeCategory(moving, before),
    },
    {
      rowAttr: "data-drop-cat-row",
      targetAttr: "data-drop-cat-row",
      nextAttr: "data-drop-cat-next",
      sectionAttr: "data-cat-section",
      sectionNextAttr: "data-cat-next",
      listName: LIST_CATEGORIES,
      // The title is the handle, the folder is what is carried.
      blockAttr: "data-drag-block",
    },
  );

  $effect(() => () => {
    feedDrag.dispose();
    categoryDrag.dispose();
  });

  function onFeedPointerDown(event: PointerEvent, feed: Subscription) {
    armPress(event, (point) => reader.openFeedMenu({ id: feed.id, title: feed.title }, point));
    feedDrag.arm(event, feed.id);
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
  let feedTree = $state<HTMLElement | null>(null);
  let starredRow = $state<HTMLButtonElement | null>(null);
  const feedLines = $derived(parseFeedUrls(feedUrl).length);

  /** The field at its floor: one line, nothing in it. */
  const FEED_BOX_FLOOR = 30;

  /* The box's own metrics, so its height and its line limit come from the same
     arithmetic instead of from a measurement: Chrome reports a textarea's
     `scrollHeight` with a line to spare, which makes "does this fit" answer no
     even for a single line. */
  const FEED_LINE = 16;
  const FEED_PAD = 14; // 6px top and bottom, plus the border

  /** Lines in the text as typed, blank ones included: they hold their height. */
  const feedTextLines = $derived(Math.max(1, feedUrl.split("\n").length));

  function feedBoxHeight(lines: number): number {
    return FEED_PAD + Math.max(1, lines) * FEED_LINE;
  }

  /** How many lines the cap will show before the box starts scrolling. */
  function feedLineLimit(cap: number): number {
    return Math.max(1, Math.floor((cap - FEED_PAD) / FEED_LINE));
  }

  /**
   * The tallest the box may get, measured from the Starred row.
   *
   * The tree is the only part of the panel that gives height, so every pixel the
   * box takes comes off the bottom of the tree — the box grows upward over the
   * feeds. That growth stops at Starred: the row is the landmark the panel is
   * read from, and a box that swallowed it would leave nothing to say where the
   * list went. Measured with the box forced back to its floor, because the room
   * left at any other height is the room already spent.
   *
   * A long paste is not growth: past the cap the box scrolls, so two hundred
   * pasted feeds are a box and a count, not a wall across the panel.
   */
  function feedCap(): number {
    const box = feedBox;
    const tree = feedTree;
    if (box === null || tree === null) return 128;

    const was = box.style.height;
    const scrolled = box.scrollTop;
    box.style.height = `${FEED_BOX_FLOOR}px`;
    const list = tree.getBoundingClientRect();
    const star = starredRow?.getBoundingClientRect() ?? null;
    box.style.height = was;
    box.scrollTop = scrolled;

    // The tree clips from the bottom, so the row that survives longest is the
    // one nearest its top: the limit is measured as the depth the row sits at,
    // not the space beneath it. Growth stops while the tree still shows every
    // row down to Starred.
    const depth = star === null ? list.height * 0.4 : star.bottom - list.top;
    const room = Math.max(0, Math.min(list.height - depth - 6, list.height * 0.7));
    return Math.round(Math.min(FEED_BOX_FLOOR + room, 360));
  }

  function fitFeedBox(): void {
    const box = feedBox;
    if (box === null) return;
    const cap = Math.max(FEED_BOX_FLOOR, feedCap());
    box.style.height = `${Math.min(feedBoxHeight(feedTextLines), cap)}px`;
    box.style.maxHeight = `${cap}px`;
  }

  $effect(() => {
    feedUrl;
    fitFeedBox();
  });

  // The cap is the tree's spare height, so it has to be taken again when the
  // box appears and whenever the panel changes height — a window resize is the
  // same measurement with a different answer.
  $effect(() => {
    if (!adding) return;
    const fit = () => fitFeedBox();
    const frame = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  });

  /**
   * Enter is a new line, always, and Ctrl/Cmd+Enter is the add.
   *
   * Enter used to add whenever the box held a single feed, so the box closed
   * itself the moment one URL went in: the second feed of a list had to wait for
   * the field to be opened again, which is exactly the chore a pasted list is
   * meant to save. The box now behaves like the list it is for, and the Add
   * button carries the count — "Add 4" — so it is clear what a click will do.
   */
  function onFeedKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void submitFeed();
      return;
    }
    // A new line is only worth adding while the box can show it: the box stops
    // at Starred, and a line past that edge cannot be read back. Pasting is
    // untouched — a pasted list arrives as a block, and it scrolls.
    if (feedTextLines >= feedLineLimit(Math.max(FEED_BOX_FLOOR, feedCap()))) event.preventDefault();
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
   * The reading, the subscribing, the download and the sentence about what
   * happened live in `lib/feeds-io.ts`, because a phone's `Settings → Feeds`
   * draws the same two actions (see `compressedFooter` below). What the sidebar
   * keeps for itself is the one line that makes them clear at a glance: the name
   * of the file in play, on screen, so it is obvious whether the last file came
   * in or went out.
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
      const done = await importFeedsFile(file, (feeds) => reader.importOpml(feeds));
      opmlName = done.name;
      opmlNote = done.note;
    } finally {
      // So choosing the same file twice runs again instead of doing nothing.
      input.value = "";
    }
  }

  /** Writes the feed list out as OPML; the note says where it went. */
  async function exportOpml(): Promise<void> {
    const done = await exportFeedsOpml(reader.categories);
    opmlName = done.name;
    opmlNote = done.note;
  }
</script>

<nav class="sidebar" data-pane="feeds" aria-label="Feeds" style="--feed-indent: {reader.sidebarIndent.px}px">
  <!-- One file picker for the whole panel. The footer's Import label and the
       empty library's Import OPML are two labels for this one control — the
       empty block is the only way in on a phone, where the footer's file row is
       folded away, and a second input would be a second entrance to the same
       dialog. Not inside the footer, because the footer is not drawn then. -->
  <input
    id="opml-file"
    type="file"
    class="opml-input"
    accept=".opml,.xml,text/xml,application/xml,application/octet-stream"
    disabled={reader.feedBusy}
    onchange={pickOpml}
  />

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
      bind:this={findBox}
      value={search.query}
      oninput={(event) => search.setQuery(event.currentTarget.value)}
      onkeydown={submitSearch}
    />
    {#if searching || reader.authorFilter !== null}
      <button class="find-clear" aria-label="Clear search" title="Clear search (Esc)" onclick={clearFind}>×</button>
    {/if}
    <!-- Always here, on every account: a mode switch, not a capability badge.
         Its second mode is whatever this account can actually search — names,
         or the authors of the feeds it already has. -->
    <button
      class="find-deep find-person"
      class:on={mode !== "feeds"}
      aria-pressed={mode !== "feeds"}
      aria-label={mode === "people"
        ? "Searching people only — click for feeds"
        : mode === "author"
          ? "Searching your authors only — click for feeds"
          : second === "people"
            ? "Search people by name instead of feeds"
            : "Search your authors instead of feeds"}
      title={mode === "people"
        ? "Searching people only — click to search feeds"
        : mode === "author"
          ? "Searching your authors only — click to search feeds"
          : second === "people"
            ? "Searching feeds — click to search people instead"
            : "Searching feeds — click to search your authors instead"}
      onclick={togglePeople}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </button>
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

  <!-- The band, and — on a phone — the day / night switch beside it. The rail is
       `display: contents` everywhere else, so on a window the band's margins and
       stacking are exactly what they were: the wrapper makes no box. -->
  <div class="rail">
    <SidebarBand />
    {#if phoneSidebar}
      <ThemeToggle />
    {/if}
  </div>

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
       visible instead of the control silently doing nothing.

       A phone does not draw this row at all: `IndentControl` is in
       `Settings → Feeds` there, and it is the same slider — same store, same
       write — so the tree starts that many pixels higher instead of the row
       costing them. -->
  {#if !phoneSidebar}
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
        <IndentControl />
      {/if}
      <span class="right"><ThemeToggle /></span>
    </div>
  {/if}

  <!-- Everything that can grow scrolls here and nowhere else: the search field,
       the band and the indent strip stay put above, the counts and the add/OPML
       block stay put below. The list is the only thing with a length. -->
  <div
    class="scroll"
    bind:this={feedTree}
    use:pullDown={{
      label: "Pull down to check for new posts",
      readyLabel: "Release to check for new posts",
      enabled: () => !reader.loadingList && !reader.sync.active,
      onPull: pullRefresh,
    }}
  >
  {#if mode === "people"}
    <!-- People mode owns the list. The category and feed rows are not drawn at
         all while it is on — not filtered down to nothing and not hidden with
         CSS — so the field searches names and nothing else, and turning the
         toggle off brings the whole tree back exactly as it was. -->
    {#if panel === "prompt"}
      <p class="empty">Type a name to search people.</p>
    {:else if panel === "waiting"}
      <p class="find-note">Looking for people…</p>
    {:else if panel === "failed"}
      <!-- A lookup that broke says so in the space the rows would have taken:
           "nothing matched" is a different answer and is not borrowed for it. -->
      <div class="section">
        <p class="empty">{people.note}</p>
      </div>
    {:else if panel === "names"}
      <div class="section">
        <div class="group">
          <div class="row group-title search-title">
            <span class="label">People</span>
          </div>
        </div>
        {#each peopleRows as person (person.name)}
          <button
            class="row feed hit"
            disabled={person.added && person.feed === null}
            aria-label={person.added ? `${person.name}, already in your feeds` : `Add ${person.name}`}
            onclick={() => void choosePerson(person.name, person.added, person.feed)}
          >
            <span class="label">{person.name}</span>
            <span class="why">
              {people.adding === person.name ? "Adding…" : person.added ? "Subscribed" : "Add"}
            </span>
          </button>
        {/each}
      </div>
      {#if people.note !== null}
        <p class="find-note">{people.note}</p>
      {/if}
    {:else}
      <div class="section">
        <p class="empty">No one named “{search.query}”.</p>
      </div>
    {/if}
  {:else if mode === "author"}
    <!-- The second search on an account whose server cannot look names up: the
         authors of the posts this app has already loaded. Nothing here asks for
         anything — the index is rebuilt when the held post list changes and the
         field only filters it — so the rows are there on the first keystroke.
         A row narrows the posts column to that author; the row above the list
         is the way back, and so are the field's × and turning this toggle off. -->
    {#if reader.authorFilter !== null}
      <div class="section">
        <button
          class="row feed hit"
          title="Show every post in this stream again"
          onclick={() => reader.setAuthorFilter(null)}
        >
          <span class="label">Posts by {reader.authorFilter}</span>
          <span class="why">Show all</span>
        </button>
      </div>
    {/if}
    {#if authorView === "prompt"}
      <p class="empty">Type an author's name.</p>
    {:else if authorView === "names"}
      <div class="section">
        <div class="group">
          <div class="row group-title search-title">
            <span class="label">Authors</span>
            <span class="why">{authorRows.length} of {people.authors.length}</span>
          </div>
        </div>
        {#each authorRows as author (author.name)}
          <button
            class="row feed hit"
            class:active={reader.authorFilter === author.name}
            aria-pressed={reader.authorFilter === author.name}
            title={reader.authorFilter === author.name
              ? `Showing only ${author.name} — click to show everyone`
              : `Show only posts by ${author.name}`}
            onclick={() => chooseAuthor(author.name)}
          >
            <span class="label">{author.name}</span>
            <span class="count">{author.count}</span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="section">
        <p class="empty">
          No author named “{search.query}” in the posts you have loaded.
        </p>
      </div>
    {/if}
  {:else if searching}
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
      bind:this={starredRow}
      onclick={() => open(STATE_STARRED, "Starred")}
    >
      <span class="label">Starred</span>
      {#if reader.countIfKnown(STATE_STARRED) !== null}
        <span class="count">{reader.countFor(STATE_STARRED)}</span>
      {/if}
    </button>
  </div>

  {#each reader.categories as category, index (category.id)}
    {@const pinned = reader.isCategoryPinned(category.label)}
    {@const hiddenCat = reader.isCategoryHidden(category.label)}
    {@const folded = reader.isCategoryCollapsed(category.id)}
    <div
      class="section"
      data-drag-block
      data-cat-section={category.id}
      data-cat-next={reader.categories[index + 1]?.id ?? null}
      data-drop-section={category.label}
    >
      <div class="group" class:pinned>
        <button
          class="row group-title"
          class:active={reader.activeStream === category.id}
          class:pinned
          class:is-hidden={hiddenCat}
          class:drop-into={drop !== null && drop.target === category.label && drop.before === null}
          class:drop-end={drop !== null &&
            drop.target === category.label &&
            drop.before === null &&
            (folded || category.feeds.length === 0)}
          class:drop-cat-before={catDrop !== null && catDrop.before === category.id}
          class:drop-cat-end={catDrop !== null &&
            catDrop.before === null &&
            index === reader.categories.length - 1}
          data-drop-cat={category.label}
          data-drop-cat-row={category.id}
          data-drop-cat-next={reader.categories[index + 1]?.id ?? null}
          data-drop-head={category.label}
          data-drop-head-prev={reader.categories[index - 1]?.label ?? ""}
          data-drop-head-first={category.feeds[0]?.id ?? ""}
          onclick={() => clickCategory(category, folded)}
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
               fold — the arrow always describes the click.

               The wrapper is the arrow's hit box and nothing else: it is the
               same 13px wide as the glyph inside it, so the row's spacing does
               not move, and on a phone it carries `.tap44` (see `app.css`),
               which lays a thumb-sized box over the caret. The press is still
               the row's press — the box is inside the button. -->
          <span class="fold-hit" class:tap44={layout.device === "phone"}>
            <svg class="fold" class:up={!folded} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
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
        {#each category.feeds as feed, index (feed.id)}
          <!-- Resolved once for the row: a re-render looks the mark up rather
               than asking the provider again. -->
          {@const icon = iconFor(feed)}
          {@const mark = feedIconImage(icon, brokenIcons)}
          <button
            class="row feed"
            class:active={reader.activeStream === feed.id}
            class:pinned={reader.isFeedPinned(feed.id)}
            class:unfolded={inlinePosts && expandedFeed === feed.id}
            class:drop-before={drop !== null && drop.target === category.label && drop.before === feed.id}
            class:drop-after={drop !== null &&
              drop.target === category.label &&
              drop.before === null &&
              index === category.feeds.length - 1}
            data-drop-feed={feed.id}
            data-drop-cat={category.label}
            data-drop-next={category.feeds[index + 1]?.id ?? null}
            data-no-drag-scroll
            onclick={() => {
              // The drag ends with a click on whatever the pointer was over.
              if (feedDrag.justDropped()) return;
              if (inlinePosts) void toggleFeed(feed);
              else openFeed(feed);
            }}
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
            {#if mark !== undefined}
              <img
                class="icon"
                src={mark}
                alt=""
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                onerror={() => (brokenIcons = markFeedIconBroken(brokenIcons, mark))}
              />
            {:else}
              <span class="icon letter" style="--hue: {icon.hue}" aria-hidden="true"
                >{icon.initial}</span
              >
            {/if}
            <span class="label">{feed.title}</span>
            {#if reader.countFor(feed.id) > 0}
              <span class="count">{reader.countFor(feed.id)}</span>
            {/if}
          </button>

          {#if inlinePosts && expandedFeed === feed.id}
            <!-- The posts of this feed, in the same list the other modes show:
                 the same four views, the same star and read toggles, and the
                 feed's mark in the bar above them. Nested, so it does not try
                 to be a column with its own scrollbar. -->
            <ArticleList nested />
          {/if}
        {/each}
      {/if}
    </div>
  {/each}
  {/if}

  {#if startsHere}
    <!-- The empty library, and the only place the panel explains itself: the
         two ways to get feeds in, and syncing as the upgrade it is rather than
         something to do first. One short block — no wizard, no second flow —
         and it is gone the moment a feed exists. -->
    <div class="start">
      <p class="start-lead"><b>Start reading</b> — Add a feed or import your subscriptions.</p>
      <p class="start-note" hidden={!DEMO}>In this demo the feeds are samples: adding your own needs the installed app.</p>
      <div class="start-actions">
        <button class="start-add" onclick={startAdding}>+ Add feed</button>
        <label
          class="start-import"
          class:busy={reader.feedBusy}
          for="opml-file"
          title="Import feeds from an OPML file — folders come too"
        >
          {reader.feedBusy ? "Importing…" : "Import OPML"}
        </label>
      </div>
      {#if onconnect}
        <p class="start-sync">
          Want feeds synced across devices?
          <button class="start-connect" onclick={onconnect}>Connect a sync service</button>
        </p>
      {/if}
      {#if opmlNote}
        <p class="start-note" role="status">{opmlNote}</p>
      {/if}
    </div>
  {/if}
  </div>

  <div class="status" aria-live="polite">
    {#if strip.hiddenCount !== null && strip.hiddenCount > 0}
      <span class="stat">Hidden <b>{strip.hiddenCount}</b></span>
      {#if strip.enforced}
        <span
          class="badge"
          title={strip.authority === "local"
            ? "Filtered on this device"
            : "Filtered by the server"}
        >ENFORCED</span>
      {/if}
    {/if}
    {#if strip.pinnedCount > 0}
      <span class="stat">{words.count} <b>{strip.pinnedCount}</b></span>
    {/if}
  </div>

  <!-- The footer, unless the empty library is introducing itself above: that
       block carries the same two ways in, so drawing both would be the panel
       saying one thing twice. The form still lives here, which is why the gate
       reopens the moment `adding` is set. -->
  {#if !startsHere}
  <div class="add">
    {#if adding}
      <form onsubmit={submitFeed}>
        <label class="visually-hidden" for="feed-url">Feed URLs, one per line</label>
        <textarea
          id="feed-url"
          class="url"
          class:grow={feedLines > 1}
          rows="1"
          placeholder="One feed per line — ⌘/Ctrl+Enter to add"
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
         between two buttons would only ever show its first few letters.

         A phone held upright does not draw this block at all (see
         `compressedFooter`): the two file actions are in Settings → Feeds, and
         the name of the file in play is reported there, next to the control that
         chose it. What stays here is `+ Add feed` above — the one that is used.
         Every other shape of window draws exactly what it always drew. -->
    {#if !compressedFooter}
      <div class="opml">
        <div class="opml-row">
          <label
            class="opml-import"
            class:busy={reader.feedBusy}
            for="opml-file"
            title="Import feeds from an OPML file — folders come too"
          >
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
    {/if}
  </div>
  {/if}
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
    /* Panned by the app's drag module, so a flick throws here the way it does in
       the post list. See `lib/drag-scroll.ts`. */
    touch-action: none;
  }

  .section + .section {
    margin-top: 2px;
  }

  /* Counts line up at one right edge across every kind of row: the feed row's
     padding and the category button's padding meet the same 10px inset, so the
     numbers read as one column instead of two, two pixels apart. */
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px 7px 16px;
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

  /* Selected: the accent is the highlight and the hairline around the row, and
     the words keep the ink every other row uses. Accent text on a 16% wash of
     the same hue is the accent drawn on its own glow — and at 12.5px in light
     mode the title was the one thing on the selected row that could not be
     read. The mark is a border and a fill, never the colour of the letters.
     `outline` rather than `box-shadow` so a pinned row, which already wears a
     ring, does not lose it by being selected. */
  .row.active {
    background: var(--accent-soft);
    color: var(--text);
    outline: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    outline-offset: -1px;
    border-radius: 5px;
  }

  /* Both marks on one row: the pin's own ring is the stronger claim about what
     this row is, so it keeps the edge, and the selection keeps the fill. */
  .row.pinned.active,
  .feed.pinned.active {
    outline-color: color-mix(in srgb, var(--tone-pinned) 45%, transparent);
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
     rather than one loud one, so a pinned row is obvious without shouting.
     A category's outline is drawn on the group, not on its title: the count is
     the title's neighbour rather than part of it, and an outline that stops
     before the number is an outline around the wrong thing. */
  .group.pinned,
  .search-title.pinned,
  .feed.pinned {
    outline: 1px solid color-mix(in srgb, var(--tone-pinned) 45%, transparent);
    outline-offset: -1px;
    border-radius: 5px;
    box-shadow:
      inset 0 -2px 0 color-mix(in srgb, var(--tone-pinned) 60%, transparent),
      0 0 9px color-mix(in srgb, var(--tone-pinned) 18%, transparent);
  }

  .group-title.pinned .label,
  .search-title.pinned .label,
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

  /* The caret's hit box, and only that: a flex item the size of the glyph, so
     the row's gap and its own height are exactly what they were. On a phone the
     box inside it grows to 44px wide, and vertically only as far as the row —
     7px of padding, a 16px line and 7px again. The next row up is a different
     category, so a box that crossed that seam would fold the wrong one. */
  .fold-hit {
    display: inline-flex;
    flex: none;
  }

  :global(html[data-device="phone"]) .fold-hit.tap44 {
    --tap44-h: 30px;
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

  /* Where the feed will land. A line above the row, not a gap: the row keeps its
     height so nothing under the pointer moves while the pointer is over it. */
  .feed.drop-before::before {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    top: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* The end of a folder: the line goes under the row that would become its
     last, because the slot itself has no row of its own to sit on. */
  .feed.drop-after::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* Same idea when the folder is folded or empty and draws no rows: its title
     says where the feed would go. */
  .group-title.drop-end::after {
    content: "";
    position: absolute;
    left: 6px;
    right: 6px;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* Where the dragged category will land: the same bar the feed rows use, on
     the folder title. The row keeps its height, so nothing shifts under the
     pointer while it is over a target. */
  .group-title.drop-cat-before::before {
    content: "";
    position: absolute;
    left: 6px;
    right: 6px;
    top: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* The last slot has no row below it to light up, so the end of the list says
     it itself — otherwise the only drop in the sidebar with no feedback would be
     the one that puts a category last. */
  .group-title.drop-cat-end::after {
    content: "";
    position: absolute;
    left: 6px;
    right: 6px;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* Dropped on the category itself: the end of that category's list. */
  .group-title.drop-into {
    box-shadow: inset 0 0 0 1px var(--accent);
    border-radius: 5px;
  }

  /* Feed rows take the server's indent on top of a small base inset. The base
     used to be 34px — a full caret column's width — which pushed the first
     child's icon 46px into a 250px sidebar and its name to ~70px, so the tree
     read as though it started in the middle of the panel. Children now begin
     near the edge (8px + the extension's indent) and are told apart from their
     category by size, weight and colour rather than by a deep column. Category
     rows still take no indent: that is the hierarchy the indent expresses. */
  .feed {
    /* The drop line is drawn against the row's own box, so the row has to be
       the containing block for it. */
    position: relative;
    padding-left: calc(8px + var(--feed-indent, 12px));
    font-size: 12.5px;
    color: var(--text-dim);
  }

  /* Selected, a feed keeps the ink of every other row and is marked by the
     highlight its title wears — never by turning the letters the accent. */
  .feed.active {
    color: var(--text);
  }

  .feed.unfolded {
    color: var(--text);
    font-weight: 600;
  }

  /* Posts under an open feed, in the one-panel layout. Indented to the same
     column as the feed's name so the nesting is legible without the feed's icon
     column being repeated, and quiet enough that the feeds below still read as
     the list's spine. */
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

  /* A phone's search field is the size of a thumb, not of a mouse pointer.
     28px with three 18px marks inside it is a field you hit by luck: the field
     grows to 44 and its marks to 36, which leaves the two mode marks 4px apart
     so their 44px hit boxes (see app.css) touch rather than overlap. The glyphs
     are drawn bigger with the boxes, since a 13px magnifier in a 44px field
     reads as a mistake rather than as restraint. Desktop keeps 28 and 18. */
  :global(html[data-device="phone"]) .find {
    height: 44px;
    gap: 4px;
    margin: 8px 10px 4px;
    padding: 0 4px 0 10px;
    border-radius: 11px;
  }

  :global(html[data-device="phone"]) .find-input {
    font-size: 15px;
  }

  :global(html[data-device="phone"]) .glass {
    width: 15px;
    height: 15px;
  }

  :global(html[data-device="phone"]) .find-clear,
  :global(html[data-device="phone"]) .find-deep {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    font-size: 15px;
  }

  :global(html[data-device="phone"]) .find-deep {
    opacity: 0.75;
  }

  :global(html[data-device="phone"]) .find-deep svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The portrait mark is the same quiet control as the paragraph mark, with a
     glyph instead of a character: it inherits the size, the dimming and the
     "on" state, and only the drawing belongs to it. */
  .find-person svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A subscribed name with no feed behind it states the fact instead of
     offering a press that would do nothing. */
  .hit:disabled {
    cursor: default;
    opacity: 0.65;
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

  /* The rail: the band, and on a phone the day / night switch beside it.
     `contents` on a window means the wrapper makes no box at all — the band's
     own margins and the sidebar's stacking are the ones it always had — and a
     phone turns it into the one row the two controls then share. */
  .rail {
    display: contents;
  }

  :global(html[data-device="phone"]) .rail {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding-right: 10px;
  }

  /* A thumb's target, drawn around a 20px glyph: the switch keeps its size and
     its place, and the box a finger lands in grows to the band's own height. */
  :global(html[data-device="phone"]) .rail > :global(.mode) {
    align-self: center;
    width: 34px;
    height: 34px;
    margin-bottom: 6px;
  }

  .count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    /* The trim's own job: the quiet mark at the end of a row. It was a setting
       nothing but the read toggle ever read, so the tone the theme exposes for
       exactly this sat unused while every number on the panel was the same grey
       as the label it followed. */
    color: var(--tone-trim);
  }

  /* The empty library. It takes the footer's place rather than sitting beside
     it, so the panel offers each way in once: one lead line naming both, the
     two controls, then the sync offer underneath as an upgrade. Sized to be
     read at a glance in a phone's drawer — three short parts, no headings. */
  .start {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px 12px 16px;
  }

  .start-lead {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-dim);
  }

  .start-lead b {
    color: var(--text);
    font-weight: 600;
  }

  .start-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .start-add,
  .start-import {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding: 0 11px;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  .start-import {
    color: var(--text-dim);
  }

  .start-add:hover,
  .start-import:hover {
    color: var(--text);
    background: var(--hover);
    border-color: var(--border);
  }

  .start-import.busy {
    opacity: 0.55;
    cursor: default;
  }

  /* A thumb would rather have two more pixels than a tighter line, and the
     block has the height to spare in a drawer. */
  :global(html[data-device="phone"]) .start-add,
  :global(html[data-device="phone"]) .start-import {
    height: 32px;
  }

  .start-sync {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* A link drawn as a link, inside the sentence that makes it an offer: the
     account panel's own connect card is what it opens. The padding is for a
     thumb and the negative margin gives the paragraph its line spacing back, so
     the target grows without the words moving. */
  .start-connect {
    padding: 3px 0;
    margin: -3px 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .start-connect:hover {
    color: var(--text);
  }

  .start-note {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-dim);
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
    min-height: 30px;
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
    /* A list is being built: two lines, before the height is set from the
       line count. */
    min-height: 46px;
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

  /* The file input is nobody's visible business: the labels in the footer and
     in the empty library are the controls, and the browser's own chrome would
     break the row. One input, two labels, one dialog. */
  .opml-input {
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
