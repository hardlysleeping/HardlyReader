# Changelog

All notable changes to HardlyReader are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
