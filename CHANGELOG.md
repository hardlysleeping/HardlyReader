# Changelog

All notable changes to HardlyReader are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-10-25

The device holds more than one account, the phone gets one settings sheet, and
the claim about what a key may contain is now true.

### Added

- **Accounts are a list.** Add a second account without signing out, switch
  between them, and remove one: a switch re-authenticates before it re-points
  the client and re-reads the layout, reading preferences and sidebar chrome for
  the account that came in. Removing an account forgets that sign-in only — its
  settings stay on the device, so signing back in finds them.
- **One settings sheet.** On a phone the hamburger opens six sections —
  Accounts, Appearance, Reading, Layout, Sync, About — each mounting the control
  the desktop already had rather than a copy of it.

### Fixed

- **The integration suite runs in CI.** It used to be wired to paths and
  variable names that nothing read, so the job reported success while the
  FreshRSS checks never executed. It now checks out both extensions, drives a
  real FreshRSS, and fails if anything is missing. 86 checks.

### Changed

- **Per-account device state, honestly described.** The remembered place and the
  IndexedDB cache (sidebar, stream pages, post text) are scoped by the same
  account slug as everything else, so no key this build writes carries a server
  or an address. Cache entries written by 0.5.1, whose keys spelled both out, are
  deleted on first launch rather than migrated. The hash is a name, not a secret:
  anyone holding the device who can guess an address can hash the guess and see
  whether a key is theirs. Retained pre-scoping `localStorage` blobs, kept for
  downgrade, still hold an address until they are overwritten.

## [0.5.1] — 2026-10-25

The phone gets its own way to move, and a device can hold more than one account.

### Added

- **Sliding panes, for a phone held upright.** One pane at a time, sliding out
  of the way: an edge swipe from the posts to the feed list, from the posts to
  the article, and back again. A back button unwinds one layer before anything
  app-level happens. Off by default — "One pane" is what portrait did before.
- **Per-account device state.** The layout, reading preferences, sidebar chrome,
  pins and local indent are now stored under a hash of the account rather than
  once for the whole device, so a second login starts from its own state. The
  hash is the server and the address; neither ever appears in a key.

### Unchanged on purpose

- Landscape and the desktop grid keep exactly the layout they had. A rotation
  never writes the layout mode, and the 1/2/3 buttons, gutters and thresholds
  are untouched.

## [0.5.0] — 2026-10-25

The window decides how many panes it can hold, and the panes give way one at a
time instead of all at once.

### Added

- **A stacked three is priced as a two-pane window.** Three panes drawn as a pair
  spend one content column, so the width they need is the width two panes need —
  the layout's own two-pane minimum — rather than the price of a third column
  that is not being drawn.
- **Panes tuck away in order.** Shrinking a window with three panes chosen goes
  three columns, then the stacked pair, then two panes, then one, each at its own
  width. It used to jump from the stack straight to a single column.

### Fixed

- **A press slides instead of snapping.** Every press that asks the window to
  resize was cutting its own slide short: the frame's arrival switched the
  transitions off in the frame the slide was due to travel. Only visible with
  Keep widths on, because that is the mode where a press resizes the window.
- **Pressing 3 while the pair was forced stacked** asked for the stack's cheap
  width instead of the columns', so the frame never grew and the button looked
  dead.

### Changed

- **Auto is the real dark or the real light theme**, not a third charcoal palette
  in between.
- **Sidebar counts follow Trim**, so the counts and the trim colour agree.
- **Fresh installs open with the thumbnail on the left**, rows in the Pill shape,
  and narrower columns, matching the layout this app is developed against.

## [0.4.0] — 2026-10-25

One column that actually works as one column, rows that carry a picture and an
action end without falling apart, and the sidebar stops rebuilding itself on
every row it draws.

### Added

- **One column.** Feeds, then the posts of the feed you opened unfolded under
  it, then the post itself — a list sheet pulled down over the page, closed by
  its tab, the scrim, Back or Escape. The tab pulls the list down; the list body
  still swipes to turn pages, and never to close.
- **A category row opens the category's posts** under its own name, with the
  feeds that are in it folded beneath, rather than jumping to a feed.
- **Read a post where you found it**: in two panes, an opened post can expand
  inline in the list instead of taking the article pane.
- **Date tabs in List** — months, weeks and days as folder tabs, one step in per
  level.
- **Rows: the action end** holds its three marks together and says what they do;
  the picture can fill the end of a row, corner and all, and the row's foot can
  be tightened to a hairline.
- **Cards: fit the window to the comic** (experimental, off by default), and
  edge zones that turn the page on a post with more than one picture.
- **Android and the network** (0.3.0): the same reader on a phone or tablet, a
  server address you can type, and the window's own title bar under the bar.
- **Settings: ten colours**, in the groups they belong to — background, and an
  optional picture behind it — with a light theme that is a colour scheme rather
  than a filter.

### Changed

- **Cards steps against the pane it is in.** In one column the list has no
  scroll box of its own, so its wheel was measuring and scrolling a block that
  cannot scroll: the wheel did nothing while the drag worked. It now finds the
  box that actually moves.
- **A press outside a panel closes it** — Settings, the reading controls and
  every menu, anywhere in the app, without eating the press underneath.
- **A mode press moves the columns once, from rest**, and the window it asks for
  is the one it draws, even when the press happens mid-resize.
- **A window has a floor**, and the bar has a breakpoint: the account block
  leaves the bar before the rest of it does.

### Fixed

- The sidebar is built once per change, not once per row — an account with a few
  hundred feeds made one paint take minutes and the window look frozen.
- A hidden-category write that lands beside a read no longer flips the eye back.
- Reopening the window lands where you were, down to the line in the post.
- A flung list keeps going, and a hand on it stops it.
- Three panes stay three panes when the window narrows; a resize is not a
  scroll.

## [0.2.0] — 2026-10-24

Cards stops being a second grid and becomes the way this reads comics, the
article pane learns to fit a page without blurring it, and a day of reading in
one window no longer needs the mouse.

### Added

- **Cards is the comics view.** A card's picture fills the pane's width at its
  own aspect ratio and its own height — no crop, no height cap, no letterbox —
  and a strip taller than the pane scrolls through it normally instead of being
  squeezed to fit. Small pictures are drawn up to the width; they are not
  sharpened into mush. The masonry wall is still there as a separate pick.
- **One card per push.** A wheel notch past a card that fits steps to the next
  one and centres it, with its neighbours peeking above and below. The step is
  the same pull the article pane uses — same effort setting, same delay — and it
  never opens a post: a tap in the middle still does that.
- **A finger gets the same promise.** On touch the column snaps card to centre
  and stops a fling at each card, so a flick crosses one card instead of three
  or four; a slow deliberate drag still scrolls the column and lands on a card.
- **Multi-picture posts: swipe or step.** Pages wrap at both ends, a gesture has
  to travel 36px sideways to turn one, and a drag that is mostly vertical is
  left to the scroll. Invisible edge zones turn the page too, 10% of the card's
  width per side by default and adjustable to 45%.
- **Articles fit their pictures.** A picture in the article pane is fitted to
  the frame — width, height and the file's own resolution, whichever is
  smallest — so a page arrives whole and unblurred, and the text stays. A
  multiplier in the article toolbar (50–200%, 5% steps) goes past that fit for
  anyone who would rather have the picture bigger, or under it to give the text
  the room; it is remembered for every post and across restarts, because it is a
  preference about the reader, not about the post.
- **Reading settings**: text, row, thumbnail and article-picture scales,
  measure, leading, alignment, first-line indent, and one step size (5% by
  default) shared by every size control, with typed values for anything past
  the sliders.
- **Settings in three tabs** behind a gear, instead of one long column: colours,
  layout, reading. The header drops what does not fit into a menu rather than
  scrolling sideways.
- **Layout thresholds as settings**, with a switch for what a mode press does to
  the window — *Keep widths* (the window is the sum of the panes) or *Keep
  window* (the panes fit the window).
- **Arrow keys on every seam**, and double-click to reset a pane to its default
  width.
- **Pull down** in the post list to ask a feed for new posts, or in an article
  to leave it.
- **A lock in the article toolbar** that goes home first, sync that reads as
  finished when it is, and a short flood of accent light as feedback on a press.
- **OPML in and out**, adding a feed from a pasted list, feed icons with a drawn
  fallback, and thumbnails on unfolded posts in the one-column walk.

### Changed

- **Unread is said by the row itself.** No dot beside the headline: unread rows
  carry an accent hairline along the bottom that turns up the right edge over a
  filled corner, and read rows step back as a whole. Cards carry the same two
  marks, so a post looks read in every view of it.
- **Category rows are pinned or not.** The star and the wording switch are gone:
  a favourite category here is a pinned one, and the two used to disagree.
- **Mark read** is a named choice — manual by default — with the dwell time as a
  setting, and **scroll effort** is adjustable rather than fixed.
- The paragraph-indent option is gone; first-line indent is a reading setting.

### Fixed

- **A wheel gesture crossed several cards.** The handler stopped the notch that
  tipped the step over and let the rest of the gesture through, so the column
  scrolled underneath the step it had just made and the snap picked whichever
  card it stopped near. Every delta over a card that fits now belongs to the
  step, and one that arrives during the settle window holds it rather than
  counting as a second gesture.
- **Small article pictures were blown up.** The first fit scaled to the frame
  regardless of the file, which is blur by default; the automatic size is now
  capped at the file's own pixels.
- **Pane one kept several widths.** The one-pane width was a stored number of
  its own, so a mode switch moved the feeds pane; it is one width now.
- **A mode press could resize the window without switching.** The measurement
  that followed the press arrived inside the dead zone the layout keeps for
  accidental drags, so the window grew and the mode stayed put.
- Hidden-category writes are queued, so a fast sequence of clicks is neither
  dropped nor repainted from a stale reply; a stream can no longer show one
  stream's posts under another's title; the band keeps equal halves under the
  lock and the feeds pane has a floor it fits into.

### Notes

- Source only: no bundles are attached to this release. The 0.1.1 Linux
  artefacts were built against a newer glibc than the platforms they targeted
  and are not fit to ship.
- The article picture multiplier is a reading preference stored per device.
  Carrying a reader's settings between devices is planned, not built.

## [0.1.1] — 2026-10-23

The layout switch stops lying, pane one keeps its width, and this is the first
release with something to download.

### Fixed

- **Pressing 3 sometimes resized the window without switching.** From one pane,
  the press asked the window for the three-pane width, the measurement that
  followed arrived inside the 120px dead zone the layout keeps for accidental
  drags, and the mode stayed at one — a wide window with a single stretched
  pane. It looked intermittent because it depended on whether the window resize
  or the promise came back first, and pressing 3 twice appeared to fix it. A
  press now claims the measurements that follow it before the resize travels,
  and two fast presses are applied in the order they were made.
- **Pane one's width is one number.** The one-pane width was a separate stored
  value, so pressing 1 always collapsed the window to it and the feeds pane came
  back an odd size. It is now the width of pane one itself: the settings slider
  and a dragged divider write the same value, and 3 → 2 → 1 → 3 leaves every
  pane exactly where it was.
- A window wider than the display it is judged by is no longer squeezed to that
  display when it collapses.

### Added

- **Settings → Layout → "On a switch"**: *Keep widths* (the window is the sum of
  the panes, so 3 → 2 slides the article out and takes its width with it) or
  *Keep window* (the window stays and the posts pane takes the space). Saved with
  the layout.
- **Android**: `docs/android.md`, `scripts/android-build.sh`, the generated
  Android project, and a signed universal release build.
- **Reader view extraction** (`src/lib/extract.ts`) — keep the article, drop the
  page around it — with its own rules and suite.
- **Watching for changes made elsewhere** (`src/lib/watch-changes.ts`), so
  extension state written by the website shows up without a reload.
- **Automatic sync** (`src/lib/auto-sync.ts`): on launch and every few hours
  while the window is open. Off by default.
- **The app's own feed order** (`src/lib/feed-order.ts`), with drag reordering.
- **A passcode keypad** (`src/lib/pinpad.ts`, `PinPad.svelte`) whose rules are
  tested without a DOM.
- **The server this window is on** in the top bar (`src/lib/server-label.ts`),
  reduced to `host:port` so it never pushes the account out.
- **Drag-scroll** and **near-view** helpers: drag the content like a
  touchscreen, and hand the engine only the pictures close to the viewport.
- Twelve new unit suites; the suite now runs 43 files.

### Notes

- Linux packaging: see the release notes. The AppImage still needs
  `libwebkit2gtk-4.1` on the host, because a Tauri app links against the
  platform webview rather than bundling one.

## [0.1.0] — 2026-10-23

First tagged release: a desktop FreshRSS reader that is usable for a day's
reading, with the extensions optional throughout.

### Added

- **Three-pane layout** — feeds, posts, article — with thresholds that decide
  when a second and third pane appear, and a layout switch that either setting
  or resizing the window can satisfy. Pane widths are draggable and remembered.
- **Fold the feeds pane** away without losing the other two; the posts keep the
  width they had. Ignored in one column, where the sidebar is the app.
- **Four post shapes** — Regular (thumbnail and preview), List (density), Cards
  and Grid (pictures first) — one row structure behind all of them, so the star
  and the read toggle work in every shape.
- **One-column mode** with a feed's posts unfolded in place, one feed at a time.
- **Reading controls**: text scale (85–150%), row scale (80–140%), leading,
  alignment, thumbnail side and size, article images on/off, scroll effort,
  text advance as a percentage, and manual or automatic read marking with a
  delay.
- **Keyboard operation** for every common action — next/previous post and feed,
  read, star, open in browser, back — with `?` for the list.
- **Pull down** in a feed to ask it for new posts, and in an article to leave it
  (or go to the previous post when advance-on-scroll is on).
- **Dark, light and automatic themes**, with accent, hidden, pinned, lock,
  unlock and sync tones configurable, plus optional accent-tinted separators.
- **Settings in tabs** — Colours, Layout, Reading — opened from a gear.
- **Search across feeds and categories**, with category frames kept around the
  feeds a search found: a category whose name matches brings all of its feeds,
  and a feed that matches on its own is still shown inside its category, with a
  count of how much of it is visible.
- **Hidden categories** with three eye states (hidden, revealed, only), applied
  optimistically, and a **lock** with passcode that keeps hidden categories out
  of counts, the sidebar and the accessibility tree.
- **Pinned categories** on the server and **pinned feeds** locally.
- **Sidebar indent** adjustable from the sidebar, stored on the server by the
  adapter.
- **OPML import and export**, folders included.
- **Feed icons** from the server with a drawn fallback, and per-post thumbnails
  taken from enclosures, Media RSS, or the first image in the post.
- **Where you were is remembered**: the feed being browsed, the post that was
  open, the feed unfolded in place, and which categories are folded — per
  account, on the device.
- **An app icon** drawn from geometry: one dot and two quarter arcs on a
  near-black tile, in every size and platform format Tauri bundles.

### Changed

- **Relicensed under [PolyForm Noncommercial 1.0.0](LICENSE)** — free for any
  noncommercial use; commercial use and app-store or TestFlight distribution
  need written permission. GPL-3.0 was considered and rejected: it cannot carry
  a no-commercial condition, because §7 forbids further restrictions on anyone
  the code is passed to.

- The sidebar's hidden/pin/lock controls fold into a compact band that can be
  collapsed, so the feed list gets the height.
- The header gives up its subtitle, sign-out and Aa/gear group under 560px, with
  the same actions in the hamburger menu; no horizontal scrolling at any width
  from 322px up.
- Category favourites are called **pinned** everywhere. Article stars are
  unchanged — they were never category pins.
- Paragraph indentation was removed from the reader; alignment is a setting.

### Fixed

- A feed opened in one column stayed closed after coming back out of an article.
- The 1/2/3 layout switch kept a dark background in the light theme, because its
  colour variables existed in neither palette.
- Pull gestures fired while a pane was already scrolling.
- Lock and sync feedback flooded the frame when several states changed at once;
  they now pulse once.
- Reading-list counts could disagree with the visible list while a filter was
  applied.

### Known limitations

- No offline cache of article bodies or images; a server that is unreachable
  cannot be read.
- iOS, Android and the PWA are planned from the same code but are not built.
- The integration suite needs a Hidden Categories checkout and is not part of
  the default test run.
