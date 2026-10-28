# One authority at a time

HardlyReader is one app with two kinds of profile, and the same features in both. What
differs is **who is authoritative** for the state behind a feature, and that difference is
the rule everything else follows.

```
FreshRSS profile                 Local profile
─────────────────                ─────────────
FreshRSS + its extensions        the local database
are authoritative                is authoritative
        │                                 │
        │  free                           │  optional paid cloud provider
        ▼                                 ▼
no billing, ever                 HardlyReader Sync (iCloud / Drive / Dropbox / OneDrive)
```

**A profile has exactly one authority.** Two writers for the same hidden category, pin or
read mark is not a feature, it is a conflict generator: the server says hidden, the cloud
says revealed, and whichever ran last wins on a device nobody is looking at.

So: a FreshRSS profile never writes its hidden/pinned/read state to a cloud provider, and a
local profile never writes it to a FreshRSS server. The paid tier is a property of the
*local* profile only. Free FreshRSS users keep every feature and keep syncing it through
FreshRSS exactly as today, and nothing about billing touches that path.

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
| Reading position | extension positions, local fallback | local place → cloud snapshot |
| Lock / passcode | extension routes | none today; per device if built — never in the snapshot |

The repo already works this way in part: `hiddenScope` / `authorityOf` in
`src/state/hidden.ts` pick the extension when it answers and fall back to the device
otherwise, and `savePrefs` writes the same document (pins, hidden, collapsed, indent,
order, categoryOrder, positions) whether the authority is a server or the device. Cloud
sync extends the local side of that; it does not add a third authority.

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
4. Nothing on the FreshRSS path consults an entitlement. `cloudSync` gates the cloud
   provider only.
5. The document holds no lock and no passcode: `tests/unit/local-sync.mjs` lists the document's
   fields, so one naming a lock or a passcode fails the suite at any depth, and a lock-shaped
   field found in a file is dropped on read and gone the next time the document is written.
