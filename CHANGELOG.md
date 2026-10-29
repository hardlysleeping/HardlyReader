# Changelog

All notable changes to HardlyReader are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.10] — 2026-10-28

### Added

- **Pictures a library has drawn are kept on the device**, at the size the pane
  draws them. Three settings (Off / Thumbnails / Everything), their own ceiling
  (100 / 200 / 500 MB, 200 by default), LRU by last use. A 73,527 B PNG comes
  back as a 14,624 B 192 px WebP and draws from the device. A server-backed
  library attaches no cache and makes no new request; the sync folder is
  untouched, so pictures never travel.
- **Hidden categories, the eye's three views and the lock work with no extension
  and on any server.** Hiding used to no-op when the adapter was absent, which
  meant a Miniflux — or a FreshRSS without the extension — could not hide a
  category at all. The set now lives on the device per account, survives a
  restart, and renders identically to the extension's answer.
- **A demo build on GitHub Pages.** <https://hardlysleeping.github.io/HardlyReader/>
  — the app with a sample library and a banner. It cannot fetch your feeds
  (Pages serves files, and a browser cannot fetch a publisher's RSS across
  origins), so it ships four sample feeds and says so.

### Changed

- **Settings → Extensions** tells you which of the three extensions your
  instance has, which are working, and links the one that is missing.
- **The README's setup table** no longer claims paid sync is pointless on a
  server profile because "your server merges everything". Sync mirrors a library
  *on this device*, which a server profile does not have, so it is not offered
  there — and a FreshRSS only carries hidden categories, pins, indent,
  preferences and position when the adapter and the category extensions are
  installed, which the table now says.

## [0.6.9] — 2026-10-27

The first release since 0.6.7: this section is 0.6.8's unpublished notes, cut
here because 0.6.8 was built and never shipped.

### Since 0.6.8

- **One person is one account.** Linking a provider keeps the account row and
  replaces only the identity; deleting the account takes the identity and the
  rows that hang off it, and cannot reach the library on the device.
- **Changing sync provider is a migration, not a re-connect.** The nine steps in
  `docs/sync-format.md` run in order, and a failure at any of them leaves the old
  provider in use and the new folder as it was found.
- **The sync folder is a versioned file set**, so two devices cannot overwrite
  each other's records; a sync archive exports and imports the whole set.
- **The reading position belongs to this device**, and the adapter has no route
  that would make a server's opinion of it possible.
- **Settings → Account**: the doors, the devices, and a deletion that has
  somewhere to go.
- **A release is four bundles or it is not a release.** `scripts/release.sh`
  refuses to touch GitHub until the AppImage, the Flatpak, the APK and the IPA
  are all present, are the size they should be and are the kind of file they
  claim to be.
- **In Cards the keys step the column, and it follows, centred** — the wheel's
  own placement, once per step, and never on a click.
- A settings section cannot be missing its open state (it was, for Saved text).

### Proven

- **Local mode runs the owner's acceptance list, as one command.**
  `pnpm test:acceptance` launches a fresh library, adds a feed through the form's
  own method, imports an OPML file with two folders and a feed in each, refreshes
  an hour later and gets a new article, reads it, stars it, marks it read, closes
  the database and opens a new handle on the same file — 51 checks, and the run
  prints which of the nine steps it ran. It uses the app's own SQLite engine on a
  real file (only the plugin IPC link is substituted), serves the feeds over real
  HTTP on localhost, and fails if anything is requested that is not one of the
  three fixtures. `docs/local-acceptance.md` carries the same list as a
  two-minute pass to tap through on a phone, and says plainly what neither pass
  can prove: iOS killing the app, and IndexedDB eviction under storage pressure.
### Local library

- **Changing sync provider is a migration, not a re-connect.** Picking another service in Settings
  no longer just remembers a different folder and lets the next run reconcile against a blank page:
  `switchProvider` runs the nine steps in `docs/sync-format.md` — sync the current provider, read
  canonical state, connect the new one, look for state already there, merge, write, read it back and
  compare it, and only then move authority (`withSwitch`, which replaces the agreement with the
  migrated document so the abandoned provider's state cannot come back on the next run). A failure
  at any step leaves the old provider in use, the new folder as it found it and the library untouched
  from the read onwards, and says which step stopped and which service is still in use. The old
  folder is never written to after step 2 and never deleted — the section says so in its own words,
  both before a switch and after one. `tests/unit/provider-switch.mjs` proves it, including the
  owner's acceptance: one device switches while a second is offline, both end on the new provider
  with the same feeds and marks, and the old file is still there and complete.

- **A library on this device keeps the text of the posts you open.** Before this, a local library
  held what each feed's XML carried — a summary, or the whole piece if the publisher sent one — and
  the article behind a "continue reading" was fetched again every time the post was opened, and
  lost on the way to another device. The body is now kept beside its entry, in the same store:
  `extractions` gains the headline, byline, length, size and last-read stamp it needs to answer for
  a post on its own. Three answers under the Aa panel's **Saved text** — off (the default), on
  open, on open and ahead — with a ceiling of 8, 24 or 64 MB per device, least-recently-used when
  it is full and never at the cost of the post on screen. The panel says who sees the request: a
  body is fetched from the publisher's own page, so this device's address lands in that publisher's
  log, and a library on this device has no server in between. Bodies are deliberately *not* in the
  sync document. [`docs/article-bodies.md`](docs/article-bodies.md) has the whole shape.

### Licence

- **PolyForm Noncommercial 1.0.0, named everywhere it is machine-readable.** The
  repo's `LICENSE` and the README carried it; `package.json` and the Tauri crate
  declared nothing at all, so a package manager or a crates.io listing would have
  read this as unlicensed. Both now point at the file rather than inventing an
  SPDX id — PolyForm Noncommercial has none, which is also why GitHub reports
  "Other". The adapter's README says the same next to its FreshRSS note.

## [0.6.7] — 2026-10-26

### Packaging

- **0.6.7 ships on all four platforms.** The AppImage and the Flatpak are both
  built from a binary compiled in Ubuntu 22.04, because an Arch build needs a
  newer glibc than either package can guarantee; the Flatpak carries no libraries
  of its own and takes GTK and WebKitGTK from `org.gnome.Platform//46`. The APK is
  signed with the key 0.6.0–0.6.6 used, versionCode 6007, so it upgrades in place.
  The IPA is unsigned, as every release here is, and installs through AltStore or
  Sideloadly.

### Changed

- **The connect screen is a card, and it leaves upwards.** The first screen was a
  form stretched across the window: three boxes, one of them shorter than the
  others because a "Show" button sat inside it. It is now one panel on the
  window's own background — equal boxes, an eye inside the password field, a
  Connect button that lifts and casts an accent-coloured shadow on hover, and the
  instructions split into what to type and what else works. Connecting adds the
  account first and slides the panel up over the reader that is already there:
  up, a short elastic settle back, then out of the window. Nothing about the
  reader waits for the animation, and `prefers-reduced-motion` gets a fade.

## [0.6.6] — 2026-10-26

### Changed

- **A fit shows the whole card, with its neighbours showing too.** The window
  was sized to the card exactly, which reads as the end of the stream; it is now
  the card's picture *and* its star, mark-read, headline and byline, plus 24px
  above and below so the cards on either side are visible. Those slivers fade
  into the pane over the same 24px, so a fitted card sits just past its own fade
  and nothing is cut off square. A real blur would need a strip pinned outside
  the scroller; the fade does the job with paint alone.

### Fixed

- **The pull works on a card taller than the pane.** One card per row made the
  tall case the normal one, and the wheel belonged entirely to the scroll there:
  no pull, no filling line, no step — the gesture and its effort setting were
  unreachable on exactly the comics that are read in Cards. The card's own end
  now hands the rest of the gesture to the step, as the article pane does at the
  bottom of a document, so the line fills and one card moves.

- **A panel strip asks for the full-size file, not the crop.** A card that
  flips through "Panel 1", "Panel 2" pictures took the publisher's URL exactly as
  the feed named it, while every other picture was sharpened out of its
  `-600x200` crop first. With one card per row the panel is drawn across the
  whole pane, so the crop was upscaled into mush; panels are sharpened the same
  way as thumbnails, with the same remembered crop to fall back to.

### Removed

- **Cards are one per row, and the columns are gone.** The view offered a
  masonry arrangement — a pick in the bar, then 2, 3 or 4 columns — with a store,
  a storage key and a preferences namespace behind it. One card per row is the
  shape: the pick, the column CSS, the model and its key are removed, and a
  stored choice is simply no longer read.

## [0.6.5] — 2026-10-26

### Changed

- **Fit the window to the comic is a button, not a mode.** It used to be a lit
  control that followed the stream, and a lit control had to answer whenever the
  stream moved under it — every answer was a window resize the reader did not
  ask for, and the resize that answered it asked for another. A press now
  measures the card in the middle and fits once. With nothing watching the
  stream or the window, scrolling cannot resize anything.

## [0.6.4] — 2026-10-26

### Fixed

- **Fit stops fighting the window.** The fit's own resize arrives back as a
  window resize, and every arrival asked for another fit: scrolling a stream of
  comics resized the window over and over, and the window jumped between two
  sizes while the reader was only scrolling. A fit is now once per card, the size
  it asked for is recognised and left alone, and three fits in a second stop the
  argument instead of continuing it.
- **Fit does something on a strip.** A press could only widen the window, so a
  comic already narrower than the pane — a daily strip is short and wide — changed
  nothing at all. A press now fits the page in both directions, and the window
  never goes below the 480px height the shell itself allows, because asking for
  less is asking for a clamp and then asking again.
- **Fit measures the picture, not the pane.** A post that carries several pictures
  draws one panel at a time, narrower than the pane so the pages share one zoom.
  Fitting that panel's own pixels without knowing its share of the pane asked for
  a window wider than it needed, and the strip did not change size.

## [0.6.3] — 2026-10-26

The seam follows the pointer, hidden works without the extension, and a phone can
sign in by pairing.

### Added

- **Pairing a phone that cannot answer a captcha.** On a phone, “Pair this device”
  asks the server for a one-time eight-digit code; on a desktop,
  `Settings → Accounts → Pair a device` lists what is waiting, with a countdown,
  and approving it is what signs the phone in. The code is single-use and expires
  in five minutes, the credential it buys is revocable from either end, and the
  payload never carries a session token. With no pairing routes on the server the
  phone offers nothing and the desktop says "not offered here".
- **Hidden categories work with no extension at all.** Without the extension the
  app used to no-op and a server silently lost the feature. Hidden is now
  device-local per account — the same storage shape pins already used — with the
  same three-state eye, the same instant toggle, and the same filtering: the
  extension answers when it is there, and the local set is never written then and
  never merged with it.
- **The band says who is enforcing.** The ENFORCED badge names its authority, and
  the eye reads "on this device" when the local set is what is doing the work.
- **Preferences travel with the account.** Reading, cards, theme and deep search
  are stored per account through the extension's `/v1/preferences`, last writer
  wins by entry stamp, per-namespace merge so an older client cannot prune what it
  does not know. Session tokens, passwords, the server address and the theme's
  background picture never leave the device, and a server that cannot hold any of
  it degrades to local-only in silence.
- **Stream switching is fast.** A generation counter and an AbortController per
  stream, so a slow answer cannot paint over a newer one; a 60-second, 20-stream
  cache that draws a revisit in the frame the switch happens and revalidates
  behind it; prefetch on hover and on category expand, capped at two in flight,
  where a click rides the guess instead of aborting it; per-stream scroll
  restoration; and performance marks so the numbers are measurable.
- **The Cards fit is pinned.** A WordPress square crop is upgraded to the
  full-size picture at the same path (the crop kept as the 404 fallback), a new
  suite holds the shapes that make comics fit against the real stylesheet, and it
  is proved to bite: a `max-height` or a `cover` in that rule fails it with the
  side bars named.

### Fixed

- **The stacked seam follows the pointer.** It measured the 6px track it is drawn
  in rather than the column it splits, so one pixel of travel was a whole share
  and every drag jumped to 25% or 75%. It measures the column now, and the share
  moves by the pointer's own travel over it.
- **Cards snap on touch** — one card at a time, centred, with the snapport made to
  equal the scroll port so a snap lands where the wheel's centring puts a card. A
  card taller than the pane still scrolls within itself.
- **The star in the article's toolbar** is an 18px glyph in a 32px box instead of a
  13px speck beside ● and ⇣.
- **The test harness names its own gap.** Six suites each carry a copy of the
  import-rewrite list that lets the reader store compile under node; a new import
  in that store used to fail ten suites with a message about a generated file.
  `harness-imports.mjs` now reports the specifier and the file missing it.

## [0.6.2] — 2026-10-26

The phone gets its own chrome, its own proportions, and a reveal that does not
make you wait.

### Added

- **A phone bar that knows where you are.** The desktop toolbar is not drawn on a
  phone any more. In its place: the wordmark at the root, `‹ Feeds` above the
  list, `‹ Posts` above the article, Sync at the trailing edge, and one `•••`
  that opens the settings sheet the desktop opens from its menu. Back is the
  same `nav.back()` the edge swipe and the hardware key already used.
- **The status region belongs to the app.** The safe area used to be one
  rectangle of padding around everything, which left the strip above the bar and
  the strip below the list painted by the page rather than by the app. The shell
  is edge to edge now (`100dvh`), the header paints through the status bar and
  insets only its own controls, the list clears the home indicator, and in
  landscape only the outermost columns step around the notch.
- **A phone in landscape is laid out as a phone.** The panes were a fixed
  168px + 240px, a desktop answer in a phone frame: a fifth of the width for
  feeds, and an empty article column taking half of what was left. They are now
  proportional — 28% feeds, 33% posts, the remainder for the article — and with
  nothing selected the article's share goes to the posts pane. Stored widths
  still win; a saved profile of some *other* phone frame is re-asked in the
  current one, so a phone put down in portrait cannot open in landscape with a
  150px drawer.
- **A search field a phone can type into.** On a phone the field is 44px tall
  instead of 28, its type is 15px instead of 12.5, and the three marks inside it
  — clear, people, paragraph — are 36px with 44px hit boxes instead of 18px
  targets under a thumb. The two mode marks sit 4px apart, so their boxes take
  that gap and stop rather than covering each other. Desktop keeps 28 and 18.
- **A thumb's targets.** The controls a phone is pressed on — Sync, `•••`, back,
  a post's star, read mark and open, the category carets — keep their glyphs and
  grow their hit boxes to 44×44, capped to the space each one actually has so a
  box can never take its neighbour's tap.

- **A phone's navigation is a layer, not a wall.** The bar, its `•••` control and
  the settings sheet are drawn as translucent material — a 20px blur at 180%
  saturation under 72% of the surface colour, one hairline, and a shadow that
  falls onto the top of the content — so the chrome reads as floating over the
  reading instead of stopping it at a divider. Nothing else is translucent: feed
  rows, cards, categories and article text keep the surface they had.
  This is an imitation on purpose, and it is an imitation: on iOS the real
  Liquid Glass is a `UIVisualEffectView` composed by the system, and a WKWebView
  cannot be handed one. `backdrop-filter` is the web's approximation of the same
  idea — sample what is behind, blur it, tint it — without the system's
  adaptivity, its lit edge, or its GPU budget. Where the backdrop cannot be
  blurred, or the system is set to reduce transparency, all three surfaces go
  back to a solid `--surface`: 72% of a surface with no blur behind it is a bar
  with the list showing through it.

### Changed

- **Revealing a hidden category no longer waits for the network.** Hiding was
  instant — the app draws the flag itself — but revealing was not: in Strict mode
  the server leaves a hidden category's feeds out of the subscription list, so
  the app held the flag and no rows and waited out a debounce plus four requests.
  The last sidebar the server actually sent is now kept in memory for the
  account, and a reveal adds the rows it is missing for the categories the new
  state draws — immediately, before anything is awaited. Existing rows win,
  nothing is ever removed, and the server's answer still replaces the list a
  moment later, so a feed deleted elsewhere still disappears. A locked state
  draws nothing from it, and neither does a copy older than a week.
- **The bottom of Feeds on a phone is the list, not a form.** Import and Export
  moved into `Settings → Feeds`, and the empty "No file chosen" line no longer
  draws at all. The Feeds pane's fixed chrome loses about 44px at 390×844.

- **Every way back is the same step.** The edge swipe's back direction and Escape
  now take the `mobileNav.back()` the bar's `‹`, the Android back key and the
  browser's history already took, so a gesture and a button cannot land on
  different layers. Each press still unwinds exactly one, and the panes keep the
  slide they had.
- **One strip on a phone.** The sliding stack's own back bar — the second 42px
  strip it drew while a pane was slid over another — is removed. Its state is a
  depth the phone bar can already name, so the step out lives there and the pane
  keeps that height.

## [0.6.1] — 2026-10-26

The phone stops fighting the thumb, and the app opens knowing what it is showing.

### Added

- **Launch is a sync.** Opening the app refreshes it whether or not the auto-sync
  interval is on — that setting is for a window left open, not permission to open
  on last week's posts. Coming back to the window refreshes too, after a wait you
  choose in Settings → Sync: 5 minutes (the default), 10, 30, always, or never.
  `Never` silences only that path; opening the app still syncs.
- **The server add-on says which it is.** One row in Settings → Sync: connected,
  not installed, or unknown. Read from state already in hand, so it costs no
  request and has no button.

### Fixed

- **The app knows what the extension hides before it draws.** It used to paint a
  sidebar with no idea which categories were hidden or whether a lock was down —
  the state only arrived with a sync — so a hidden category could appear and a
  curtain could lift. The last state the server gave the account is now kept per
  account and painted before the first frame, then replaced by the live read in
  the same round as the sidebar. A lock that is drawn stays drawn when a read
  fails: a dropped connection is not an unlock.
- **A finger can scroll the list from anywhere.** The app pans its own lists, and
  it used to refuse any press that started on a control, which made the row's
  star / read / open strip and every feed row a dead zone with no browser pan to
  fall back on. That refusal was written for the mouse; it is now a mouse-only
  rule, and a press that lands on a control scrolls after 10px instead of 5 so a
  shaky tap still lands.
- A pan no longer leaves the control it started on looking pressed — except one
  that is switched on, which keeps its colour.

### Changed

- **A Content-Security-Policy.** The webview shipped without one, so DOMPurify was
  the only thing between a bad feed article and the app's own window. Scripts are
  now `'self'` with no `eval`; objects, frames, workers, `<base>` and form posts
  are blocked outright. The sources that must stay open are named rather than
  wildcarded: images and media from any feed host, your FreshRSS server over http
  or https (a LAN address included), and Tauri's own IPC channel. The `opener`
  permission is narrowed to http and https URLs, which is all the app opens.

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
