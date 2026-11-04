# One authority at a time

HardlyReader is one app, and the same features everywhere. What differs is **who is
authoritative for each feature** — decided per feature, never as one "FreshRSS vs cloud" switch.
That distinction is the rule everything else follows.

```
FreshRSS profile                 Local profile
─────────────────                ─────────────
FreshRSS + its extensions        the local database
are authoritative                is authoritative
        │                                 │
        │  free                           │  optional paid cloud provider
        ▼                                 ▼
no billing, ever                 HardlySyncing (iCloud / Drive / Dropbox / OneDrive)
```

**A profile has exactly one authority.** Two writers for the same hidden category, pin or
read mark is not a feature, it is a conflict generator: the server says hidden, the cloud
says revealed, and whichever ran last wins on a device nobody is looking at.

So: a FreshRSS profile never writes its hidden/pinned/read state to a cloud provider, and a
local profile never writes it to a FreshRSS server. The paid tier is a property of the
*local* profile only. Free FreshRSS users keep every feature and keep syncing it through
FreshRSS exactly as today, and nothing about billing touches that path.

## The ladder, per feature

```
does this backend support the feature?
  → yes:  the backend is authoritative (a server, or the local database)
  → no, and the reader pays for Sync: HardlyReader cloud snapshot is authoritative for it
  → no, and free: it stays on this device
```

Since a backend is whatever the profile points at, that one ladder covers every case:

| profile | core RSS (feeds, read, stars, folders) | HardlyReader extras |
|---|---|---|
| Local | local database | paid Sync mirrors it; free stays on the device |
| FreshRSS **with** the extensions | FreshRSS | **free — the extensions carry them** |
| FreshRSS without them | FreshRSS | local, or paid Sync |
| The Old Reader / Miniflux / Inoreader / Tiny Tiny RSS | that service | local, or paid Sync |
| Local + paid | local database | paid iCloud / Drive / Dropbox / OneDrive |

The extras are hidden categories, pinned categories, category and feed ordering when the service does
not preserve it, sidebar indent, lock/reveal state, reading position, and HardlyReader's own layout
and preferences.

Worked example — The Old Reader, paid:

```
The Old Reader                    HardlySyncing
├── feeds                         ├── hidden categories
├── folders                       ├── pinned categories
├── read / unread                 ├── custom ordering
└── starred                       ├── layout and preferences
                                  └── reading position
```

And the same reader without paying keeps every one of those features — on that device.

### The mechanism

`src/lib/capabilities.ts` is the whole model, and it is pure: no state, no network, no provider
name. `ReaderBackend.capabilities` (optional, partial) says what a backend can store; a backend that
declares nothing is treated as a plain GReader service.

```
GREADER_CAPABILITIES               feeds, folders, read, stars
FRESHRSS_EXTENSION_CAPABILITIES    + ordering, hidden, pins, prefs
LOCAL_CAPABILITIES                 everything (the backend is the local database)
```

The reading position is deliberately absent from the FreshRSS line. `/v1/positions` carries the
arrangement — category ids and feed ids — and `/v1/preferences` carries reading, theme and search
settings; neither is where the reader was, and there is no third route. The place is `lib/place`,
keyed per account in device storage, which is where it actually lives on every backend today, so the
declaration says `false` rather than claiming a route the adapter cannot honour. Giving the
extension a place route is the other way to make it true, and that would be a version: a block on
`/v1/positions` (or a `/v1/place`), a bumped `HardlyReadApi::API_VERSION`, and a row in
`ADAPTER_ROUTES` in the same change.

`resolveAuthority(feature, { capabilities, paid, observed })` returns `backend`, `cloud` or `local`,
and `upgradePitch({ capabilities, paid, observed, server })` says what buying would actually add:
`nothing` for FreshRSS with the extensions (their server already does it), `mirror` for a local
library, `extras` for a service with nowhere to put them. The pitch counts only features some adapter
has a route for (`adapterCarries`), which is why the place does not turn "nothing" into a price for a
FreshRSS reader: no backend is meant to hold it, so a subscription is not what would put it anywhere.
`paid` is the entitlement's one capability, passed in rather than imported: this module is pure, and
the store that asks it is told the answer by the shell (`App.svelte`), so no reading path imports a
receipt.

### One resolver, and every extra asks it

`ReaderState.featureAuthority(feature)` is the only caller of the ladder in the app
(`src/state/reader.svelte.ts`). It answers with the belief the backend declared, folded with every
answer that was an answer, plus `paid` — and the features that used to keep a rule of their own read
its answer instead of branching on `session !== null`:

| what asks | feature | `backend` means | otherwise |
|---|---|---|---|
| `hiddenScope`, the hide/show writes | `hiddenCategories` | the extension's block, as it came | this device's own set (cloud: the same set, mirrored) |
| `isCategoryPinned`, `pinView`, the pin writes | `pinnedCategories` | Pinned Categories holds the mark | this device's pins |
| the indent read and write | `preferences` | the adapter's indent block | this device's number |
| the arrangement (`/v1/positions`) | `feedOrder` / `categoryOrder` | the account's document | this device's arrays; a `cloud` answer stops the write entirely |
| `adoptPlace` | `readingPosition` | a backend with a place route owns the place, so a document may not overwrite it — no adapter has one today, so a FreshRSS reader's place is this device's | this device takes the other device's place |

Two of those sentences are worth spelling out, because they are where the code and the wire meet:

- **A route is not an authority.** Whether `/v1/positions` exists is learned from the route itself
  (`positionsRoute`, from the first read or the first `404`), and a route that answers is not a
  claim about who owns the feature. The ladder decides ownership; the route decides whether there
  is anywhere to write.
- **`cloud` draws the same block as `local`.** A paid mirror is merged *into* this device's copy by
  `state/device-sync`, so `hiddenScope` and the pins have no third reader and no second place to
  look. What `cloud` changes is who wins, and that is the merge's job, not the sidebar's.

The section that sells the subscription asks `reader.upgradePitch`, so it says what buying would
add for *this* backend: a FreshRSS-with-extensions reader is told **nothing to buy**, a local
library is offered the **mirror**, and a service with nowhere to put the extras is offered them.


### A declaration is not evidence

`ReaderBackend.capabilities` is what a backend *says* it is. The real FreshRSS adapter can be in
three states that look alike from a declaration and are not: **installed but disabled** (its routes
`404`), **older than the route we would call** (a `404` at the first write), or **down while the
server restarts** (a `5xx`, a timeout, an offline socket). Only the first two mean "this server
cannot store it".

So the measurement is a separate thing, per feature, with three states
(`CapabilityState` in `src/lib/capabilities.ts`):

```
supported     something answered and the route is there
unsupported   something answered and the route is not: 404, disabled, too old
unknown       nothing answered: 5xx, timeout, offline, a proxy error page
```

`ReaderBackend.probeCapabilities()` is the measurement (`probeCapabilities` in
`src/api/hardlyread.ts` for the extension adapter); it never throws, and it reads the answer as
follows:

- **A `200` from `/v1/state`** — `capabilitiesFromState` reads the adapter's `apiVersion` and the
  two block extensions' own `available` flags. A block reporting `false` is a definite no.
- **`404`** (or a server whose GReader prefix cannot host the extension at all) — `unsupported`,
  the same answer as before the extension existed.
- **Anything else** — `unknown`. A `401` counts too: a rejected credential says nothing about
  which routes exist.

**`unknown` decides nothing.** `remember()` folds only real answers into the belief the decision
reads, and `resolveAuthority` falls back to that belief for an `unknown` report — so a server that
is restarting for ten seconds does not hand its features to the cloud and leave two writers for one
field when it comes back. `explainAuthority()` hands the UI the same authority plus
`couldNotCheck`, which is the permission to say "could not check" without moving anything.

### Which version carries which route

`apiVersion` on `/v1/state` is the **adapter's** version — not the preferences document's
(`PREFS_API_VERSION`) and not the marketing version in `metadata.json`. `ADAPTER_ROUTES` in
`src/lib/capabilities.ts` lists, per version, the extended features that version answers; an
adapter that reports no version at all reads as version 0 and is assumed to carry none of them. An
older extension therefore *reports fewer capabilities* instead of answering `404` later, which is
what keeps a feature from being half-claimed.

Adding a route to the adapter means bumping `HardlyReadApi::API_VERSION` and appending a row to
`ADAPTER_ROUTES` in the same change.

The reading position appears in no row, because no version of the adapter carries a place: the
arrangement is `/v1/positions`, settings are `/v1/preferences`, and there is no third route. So
`capabilitiesFromState` answers it `unsupported` at every version — a measurement that agrees with
the declaration in `src/lib/capabilities.ts` instead of contradicting it — and a FreshRSS reader keeps
the place in `lib/place`, on the device, per account, exactly as a reader on any other server does.
A place route would be a new version plus a row here; a `true` in the declaration without them is a
claim about a route that does not exist, which is the failure this section exists to prevent.

The gap that rule is closing, stated plainly: `API_VERSION` was already 1 when the arrangement
(`/v1/positions`) and preferences (`/v1/preferences`) routes arrived, so a v1 adapter from before
those routes cannot be told apart from one that carries them — both report 1, and the older copy
over-claims until its first `404` (which the write path already reads as "local only"). No version
number can separate two copies that report the same one; the rule is what keeps the next route from
joining them.

## The same features, two storage adapters

Internally these are HardlyReader features with two adapters, not "FreshRSS features":

| Feature | FreshRSS adapter | Local adapter |
|---|---|---|
| Feeds, folders, ordering | FreshRSS subscription API | local SQLite + cloud snapshot |
| Read / unread | GReader state | local DB + cloud snapshot |
| Stars | GReader state | local DB + cloud snapshot |
| Hidden categories | `xExtension-HiddenCategories` | local hidden state → cloud snapshot |
| Pinned categories | `xExtension-FavoriteCategories` | local pins → cloud snapshot |
| Hidden view / revealed | extension `view` | local view → cloud snapshot |
| Sidebar indent | `xExtension-HardlyRead` | local preference → cloud snapshot |
| Reading, layout, theme | extension prefs doc, local fallback | local prefs doc → cloud snapshot |
| Reading position | device, per account — no extension route (`src/lib/place.ts`) | local place → cloud snapshot |
| Lock / passcode | extension routes | none today; per device if built — never in the snapshot |

One row has a single adapter rather than two: the reading position. The extension has no place route,
so on a FreshRSS profile it is this device's, per account, exactly as it is on a local one — the way to
the cloud is the local snapshot, not the server.

The repo works this way, and the seam is one function: `featureAuthority` decides which store answers
(see above), `resolveHidden` / `hiddenStore` in `src/state/hidden.ts` draw whichever it named, and
`savePrefs` writes the same document (pins, hidden, collapsed, indent, order, categoryOrder,
positions) whether the authority is a server or the device. Cloud sync extends the local side of
that; it does not add a third authority.

`hiddenStore` takes one fact the ladder does not carry — whether there is a server at all — because a
library on this device declares *itself* the backend for every feature (`LOCAL_CAPABILITIES`). So
`backend` there means this device's store, never an extension it has no way to run; reading the
ladder's word without that fact is what made a local library unable to hide a category. The write
paths ask the authority before the session for the same reason: a press is refused only when the
*server* is the store and there is none, never merely because `session` is null.

## What the sync document already carries

Checked against the code, not assumed. `SidebarDoc` in `src/lib/sidebar-doc.ts` is exactly the
owner's table for the local adapter:

```
hidden[]        hidden categories          pins[] / pinFeeds[]   pinned categories and feeds
hiddenView      hidden | revealed | only   pinView               all | only | without
indentPx        sidebar indent             feedOrder[]           feed order
categoryOrder[] category order             (plus prefs and place in the snapshot)
```

`SyncSnapshot` (`src/api/local/sync.ts`) wraps that with `feeds`, `folders`, `marks` (read and
starred as separate registers with their own stamps), `prefs` and `place` — so the whole feature
set in the table above travels for a local profile without a second model.

**The one row that does not travel: lock/passcode.** Decided, not deferred — see below.

## Lock and passcode: per device, never in the document

**The lock stays on the device.** No lock field is added to `SidebarDoc` or `SyncSnapshot`, in
either direction. `tests/unit/local-sync.mjs` writes the document's own fields down and fails if
one appears that names a lock or a passcode, at any depth.

Why, in the order that decides it:

- **The passcode is a curtain, and a plain-text one.** The extension stores it exactly as typed
  and compares strings — its own comment says "A speed bump, not authentication. The passcode is
  stored in PLAIN TEXT on purpose" (`xExtension-HiddenCategories/store.php`). A synced document
  is a JSON file sitting in an iCloud, Drive, Dropbox or OneDrive folder: a copy in the provider,
  in its version history and in every backup of it, readable by anything that can read the file.
  Moving that curtain's key into four clouds is a worse place for it than the server it was
  written for.
- **It would buy nothing.** What the reader is keeping away is the category list, and the labels
  themselves travel — they are what `sidebar.hidden` is. Carrying the passcode does not make
  those labels less present in the file; it puts a secret beside them.
- **There is no conflict to resolve.** A per-device lock cannot disagree with another device,
  and "arrives unlocked, the reader sets a passcode here" is a state that needs no new UI.

What it means per profile:

- **FreshRSS profile:** unchanged, and cloud sync is not involved at all. The extension owns the
  passcode, the locked flag and the check.
- **Local profile:** there is no lock today. `resolveHidden` returns `locked: false,
  hasPasscode: false`, and the band says "Locking needs a connected service"
  (`lib/lock-title.ts`). If a local lock is ever built it follows the same rule: the code lives
  in the device's own store beside the hidden set, and the sync document carries neither the
  code nor the flag. A second device arrives with the categories and no lock; setting a passcode
  there is one action, and it is the action that lifts the curtain anyway.

The two options not taken, and what each would have cost:

- **The locked flag travels, the passcode does not.** A new device draws a curtain with no code
  that can lift it — a lockout that needs an "unlock this device" flow the app does not have —
  and the curtain is one edit away from gone in a file the reader can open.
- **The passcode travels, hashed.** A real KDF (Argon2/scrypt) instead of a string compare, a
  per-install salt, and merge rules for two devices holding different passcodes — and the hash
  still lands in the provider's folder and in its backups. Worth it only if the lock has to
  follow the reader, and it does not: the lock hides what is on this screen.

## What is genuinely server-only

Server enforcement cannot travel: the HiddenCategories extension changes what the FreshRSS
*website* shows, and there is no website to change in local mode. Local mode reproduces the
behaviour across HardlyReader devices and says so — it does not pretend to hide a category
on a server it is not using.

## Checks that keep it honest

1. With a FreshRSS profile, the sync provider is never constructed and no cloud file is
   written; grep the code paths, not just the UI.
2. With a local profile, the snapshot carries hidden, pins, view, indent, ordering and
   position — a device that syncs and then reopens has the same sidebar it left.
3. Switching profile never migrates state silently: connecting FreshRSS does not upload the
   local library to it, and signing out of FreshRSS does not import its hidden state into
   the local one.
4. Nothing on a reading path *imports* the entitlement, and no reading module names the
   capability: `paid` reaches the reader as one boolean, set by the shell (`App.svelte`), and
   `tests/unit/authority.mjs` walks the reading seam's import graph to hold that. What the flag can
   change is which side of the ladder an extra falls on: for a FreshRSS **with** the extensions it
   changes no answer for any extra the adapter carries — each one is the backend's either way. The
   reading position is the exception, and it is the exception by design: no adapter has a route for
   it, so the ladder answers `local` free and `cloud` paid, and nothing writes that cloud copy because
   a sync only ever runs on a local library (`showsDeviceSync`).
5. The document holds no lock and no passcode: `tests/unit/local-sync.mjs` lists the document's
   fields, so one naming a lock or a passcode fails the suite at any depth, and a lock-shaped
   field found in a file is dropped on read and gone the next time the document is written.
6. A failed capability check never changes authority. `tests/unit/capabilities.mjs` drives the real
   probe through a fake backend that flips between a live adapter, a `404`, a `502`, a timeout and
   an offline socket, and asserts `resolveAuthority` is identical with an `unknown` report and with
   no check at all — including on a paid device, where the cloud is the tempting answer.
