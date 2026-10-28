# HardlyReader

A feed reader that runs without a server, and reads your own one when you have it:
three panes that fold to one, a keyboard that never needs the mouse, and no reflow
while you scroll. Cards is built for reading comics one page after another — a page
fills the pane at its own size, one push moves one post, and nothing is cropped.

Two ways to read, one app:

- **No account at all.** A library on the device — feeds you add or import, folders,
  read state, stars, OPML, a real lock, and the text of posts you keep — stored in
  SQLite (IndexedDB in a browser tab). Nothing leaves the machine.
- **Your own server.** Point it at [FreshRSS](https://freshrss.org), Miniflux, Tiny
  Tiny RSS or The Old Reader and everything syncs through it, extension state
  included. Your server does the syncing, for free, as it always has.

Moving a local library between devices is free and manual: **Settings → Device sync →
Archive** exports `HardlyReader-Sync.zip` and imports it back — feeds, folders, hidden
categories, pins, arrangements, read and starred marks, preferences, positions. The
same canonical files the folder providers write, so a zip can be unzipped, read, kept,
or dropped into iCloud Drive by hand. Automatic mirroring through iCloud, Google Drive,
Dropbox or OneDrive is the one paid feature — see *Free, and what a subscription adds*
below.

Svelte 5, TypeScript, Tauri 2. One codebase: a Linux desktop window, a browser build
(also shipped as a container), Android, and iOS.

![Three panes: feeds, posts, article](docs/screenshots/three-panes.png)

When three columns will not fit they stack — feeds beside the post list, the article
underneath, nothing dropped. One pane is the phone: the feed you picked fills it. Two
panes with Cards reads a comic page at its own size, one card per row.

<p align="center">
  <img src="docs/screenshots/three-panes-stacked.png" width="300" alt="Three panes stacked: feeds beside the post list, the article below">
  <img src="docs/screenshots/one-pane-phone.png" width="200" alt="One pane on a phone, opened on a single feed">
  <img src="docs/screenshots/two-panes-cards.png" width="430" alt="Two panes with Cards: one comic page per card">
</p>

## Install

### Docker (browser, and phone over the LAN)

```sh
docker run -d --name hardlyreader -p 8080:8080 \
  ghcr.io/hardlysleeping/hardlyreader:latest
```

Open `http://localhost:8080` and enter your FreshRSS address on the connect
screen — the same one field the desktop app asks for. There is nothing to
configure in the container.

From a clone, `docker compose up -d --build` does the same thing.

One catch that is the browser's, not the app's: a page served over **https** can
only call a server over https. If FreshRSS already has a certificate, put this
page behind one too (any reverse proxy will do); over plain http on a LAN it just
works.

### Linux desktop

Download `HardlyReader_<version>_amd64.AppImage` from
[Releases](https://github.com/hardlysleeping/HardlyReader/releases), then:

```sh
chmod +x HardlyReader_*_amd64.AppImage
./HardlyReader_*_amd64.AppImage
```

A Flatpak bundle is on the same release (`ing.hardlysleep.hardlyreader-<version>.flatpak`,
`flatpak install --user` it). The AppImage needs glibc 2.39 or newer and WebKitGTK 4.1
(`webkit2gtk4.1` on Fedora, Arch and openSUSE; `libwebkit2gtk-4.1-0` on Debian/Ubuntu).
On some Wayland setups WebKitGTK paints nothing and the window stays one flat grey —
start it with `WEBKIT_DISABLE_COMPOSITING_MODE=1` to take the non-compositing path.

### Android and iOS

Both from [Releases](https://github.com/hardlysleeping/HardlyReader/releases).

**Android:** `app-universal-release.apk` — sideload it (Allow from this source). Every
release is signed with the same key, so it installs in place; check the version in
*Settings → About*.

**iOS:** `HardlyReader-<version>-ios-unsigned.ipa` — unsigned on purpose; there is no
paid Apple developer account behind it. Install with [AltStore](https://altstore.io)
or Sideloadly and a free Apple ID (7-day signing). Needs iOS 15 or newer. It is built
by the `iOS unsigned IPA` workflow in this repo on a macOS runner, so every release can
carry one without a second CI account.

## Connect it to FreshRSS

Every install asks for three things once:

- **Server** — the base URL of your FreshRSS, e.g. `https://feeds.example.org`
  (loopback works too: `http://127.0.0.1:8080`). For Docker, this is the
  container's own URL, not the server's.
- **User** — the account name you sign in with.
- **API password** — from FreshRSS *Settings → Authentication → API*, **not**
  the account password. Enable API access there first.

An account whose web login asks for a captcha can be paired instead: the phone
shows a code, and a device that is already signed in approves it under
*Settings → Accounts → Pair a device*. The paired credential is separate from
the password and either side can revoke it.

## What it does

- **Panes that fit the window.** One, two or three columns; the feeds pane folds
  away without disturbing the other two, and dragged widths stay put.
- **Four ways to list posts** — Regular, List, Cards, Grid — one row structure
  behind all four, so every action works in every shape.
- **Cards, for comics.** A page fills the pane's width at its own aspect ratio
  and height: no cap, no crop, no letterbox. One wheel notch or flick moves one
  post and centres it; multi-picture posts page sideways with dots underneath.
  The fit button sizes the window to the whole card — buttons and all — with the
  neighbouring cards showing above and below.
- **The article pane fits a page whole** — by width, height and the file's own
  pixels, whichever is smallest — with a multiplier from 50% to 200%.
- **Keyboard first.** Next/previous post and feed, mark read, star, open in
  browser, back; `?` lists them.
- **Hidden, pinned and locked categories**, via optional extensions (below).
  Hidden categories stay out of counts and screen readers; locked ones sit
  behind a passcode.
- **Search** across feed names, categories and — deeply — post text.
- **Settings in three tabs**: colours (dark, light, automatic, every tone), layout
  (panes, widths, row shape, corners), reading (measure, leading, alignment, type
  scale, automatic read marking).
- OPML import and export, feed icons with a drawn fallback, and a session and
  reading position that survive a restart.

## Free, and what a subscription adds

The app is two halves of the same thing, and which half owns your state depends only on which
profile you are reading with:

- **Free, with your own server.** Point HardlyReader at FreshRSS, Miniflux, Tiny Tiny RSS or The
  Old Reader and everything syncs through it, as it always has — feeds, read state, stars, and,
  when the extensions are installed, hidden categories, pins, sidebar indent, preferences and
  reading position. Nothing in this path ever asks about a subscription.
- **Free, on this device alone.** A local library needs no account and no server: feeds, folders,
  read/star state, OPML and a real lock, stored in SQLite (or IndexedDB in a browser tab). It can
  also keep the text of the posts you open, so a post read on the train reads the same in the
  evening — [`docs/article-bodies.md`](docs/article-bodies.md) says what that costs, how much it
  holds, and who sees the request.

**Moving a local library between devices is free.** Two ways, and neither asks for money:

- **By hand, always.** *Settings → Device sync → Archive* writes `HardlyReader-Sync.zip` — feeds,
  folders, hidden categories, pins and arrangements, read and starred marks, preferences, reading
  positions — and imports one back. Import is a merge, not a replace: what the archive has is
  added, what this device has is kept. The zip is the same canonical files the folder providers
  write, so it also drops straight into an iCloud Drive or Google Drive folder by hand.
- **Automatically**, if you subscribe: **HardlyReader Sync** mirrors a *local* library across your
  devices through iCloud Drive, Google Drive, Dropbox or OneDrive, and keeps them merged in the
  background — one subscription covers all four, because a provider is storage, not a product. It
  does not apply to a server-backed library and does not appear there; your server already does
  that job, for free.

So the subscription buys convenience, not access: no feature, no file and no way out of your own
data is behind it. Unsubscribing stops the automatic mirroring and leaves the library, the folder
and the zip exactly where they are.

The rule that keeps this coherent: **one authority per profile.** FreshRSS and its extensions own
a server-backed profile; the local database owns a local one. No state is ever written by two
authorities, and `docs/authority.md` spells out which feature lives where.

## Extensions (optional)

| Extension | What it adds |
|---|---|
| [Pinned Categories](https://github.com/hardlysleeping/xExtension-FavoriteCategories) | Which categories are pinned, and their order |
| [Hidden Categories](https://github.com/hardlysleeping/xExtension-HiddenCategories) | Which categories are hidden, the eye state, and the passcode lock — shared between devices |
| [Hardly Read adapter](https://github.com/hardlysleeping/xExtension-HardlyRead) | One request returning all of the above, plus the sidebar indent |

The app runs without them: pins and hidden categories are kept on the device, so
the sidebar behaves the same way, and the one control that genuinely needs an
extension says so instead of breaking. The extensions themselves are separate
repos and stay optional on the server.

## Build from source

```sh
pnpm install
pnpm dev            # browser build on 127.0.0.1:1420
pnpm dev:window     # desktop window (tauri dev, compositing disabled — see Notes)
pnpm build          # static browser build in dist/
pnpm tauri build    # desktop bundle
pnpm check          # svelte-check
pnpm test           # unit suites, headless: no browser, no server
```

Building needs Node 22+, pnpm, Rust and Tauri 2's Linux dependencies
(WebKitGTK 4.1). A container needs none of that — see `Dockerfile`.

`pnpm dev` also proxies `/freshrss` to `HARDLYREAD_SERVER` (default
`http://127.0.0.1:18080`) as a convenience when testing against a local
instance; it is not required, and in the desktop app requests go through Tauri's
http plugin regardless.

## Releasing

A release is four bundles on four platforms, in one GitHub release:

- Linux, portable — `HardlyReader_<version>_amd64.AppImage`
- Linux, Flatpak — `ing.hardlysleep.hardlyreader-<version>.flatpak`
- Android — `app-universal-release.apk`
- iOS — `HardlyReader-<version>-ios-unsigned.ipa`

Fewer than four is not a release, even when every step that ran passed. The four
come from different tools, so a step can be skipped without anything failing; a
release that carried only the AppImage has shipped here before. `scripts/release.sh`
is what stops that:

```sh
scripts/release.sh 0.6.8 --ipa path/to/HardlyReader-unsigned.ipa --dry-run
scripts/release.sh 0.6.8 --ipa path/to/HardlyReader-unsigned.ipa
```

It collects the bundles, checks each one exists, is close to the size it should
be and is the kind of file it claims to be, then creates the release as a draft,
uploads all four, reads the draft back, and only then publishes and reads the
published release back. A missing or wrong bundle is named and the run stops
before anything is created on GitHub.

`--build` runs the three builders that work on Linux
(`scripts/build-appimage.sh`, `scripts/build-flatpak.sh`,
`scripts/android-build.sh --release`) first; `--appimage`, `--flatpak` and
`--apk` point at a bundle built somewhere else. The IPA has no Linux builder, so
it is passed in: the `iOS unsigned IPA` workflow (`.github/workflows/ios-unsigned.yml`)
builds it on a macOS runner — `gh workflow run ios-unsigned.yml` — and
`codemagic.yaml` carries the same recipe for anyone who prefers that. `--dry-run`
does every check and prints the exact commands it would run, calling nothing.

## Notes

- The Tauri window runs under a Content-Security-Policy; [`docs/csp.md`](docs/csp.md)
  explains each directive and what only a built app can prove.
- [`docs/android.md`](docs/android.md) covers the Android build and signing.
- No offline cache of article bodies or images for a **server-backed** library: a server that is
  down is a server that is down. A library on this device is the exception, and it keeps only the
  text you asked it to keep — [`docs/article-bodies.md`](docs/article-bodies.md).
- Screenshots use invented feeds; no real subscriptions appear in this repo.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): free for any **noncommercial** use —
read it, run it, change it, share it, build on it. **Commercial use, and
distribution through an app store or TestFlight, needs written permission from
the author.** That includes selling it, bundling it into something sold, or
shipping it to a store under your own name.

This is deliberately not an open-source licence: GPL-3.0 and friends cannot carry
a "no commercial use" condition, because GPL §7 forbids adding restrictions on
anyone the code is passed to.
