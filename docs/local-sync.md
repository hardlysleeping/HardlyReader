# Local device sync

A **local** library has no server behind it, so two devices hold two libraries
that know nothing about each other: the same feeds subscribed twice, the same
article read on one and unread on the other. `src/api/local/sync.ts` closes that
gap without inventing a server. Both devices write one document into a folder
they can already see — an **iCloud Drive** folder, a **Google Drive** folder, a
directory on a network share — and merge it whenever they open.

The fetching engine is never part of it. Each device fetches its own feeds, on
its own schedule, with its own validators.

## What travels, and what does not

| Travels | Does not travel |
|---|---|
| subscriptions: URL, title, title source, folder, when added | article bodies, summaries, enclosures |
| a feed that moved: the old address and where it answers now | the address a poll resolved to on this device |
| folders, including empty ones | extraction results and their failures |
| read marks, starred marks | `ETag`, `Last-Modified`, poll times, failure counts |
| the settings document (`reading`, `theme`, `search`) | window layout, pane widths, phone chrome |
| removals, as tombstones | the session: server URL, token, password |

A document carrying article bodies would grow without bound and sync every few
minutes; a document carrying validators would have two devices contradicting
each other about a feed neither of them fetched the same way.

## The file

`hardlyreader-sync.json`, inside whichever folder the reader points at. Compact
JSON, because a cloud folder uploads every byte.

The webview names a **folder**; `src-tauri/src/sync.rs` names the file. A page
that could name any path could write any file the app can reach, and this needs
exactly one. The write is staged in `hardlyreader-sync.json.writing` and renamed
onto the real name, so a second device reading at that moment sees the old
document or the new one, never half of either. `~` is expanded in Rust, because
the folder a panel suggests lives under the reader's home and no shell is in the
loop; a relative path is refused rather than resolved against whatever directory
the app was launched from.

## Where it lives: a provider

`syncOnce()` does not know about paths. It asks a **`SyncProvider`**
(`src/api/local/sync-provider.ts`) for the document and hands the merged one
back: `id`, `label`, `read()`, `write(document)`, `describe()`.

**All five providers in this build are folder-backed, including the four
clouds.** iCloud Drive, Google Drive, Dropbox and OneDrive are *names for a
folder the reader's own sync client already mirrors* — the reader picks that
folder, and the provider records which service it belongs to so a panel can say
where the file went. There is no CloudKit, no Drive, Dropbox or OneDrive API, no
OAuth and no account. When one of them grows into a real integration it grows a
provider with the same four members, and the merge here does not change.

| `id` | `label` | what `describe()` says |
|---|---|---|
| `icloud` | iCloud Drive | the iCloud Drive folder your Mac or iPhone already keeps in sync |
| `gdrive` | Google Drive | the Google Drive folder your Drive app already keeps in sync |
| `dropbox` | Dropbox | the Dropbox folder your Dropbox app already keeps in sync |
| `onedrive` | OneDrive | the OneDrive folder your OneDrive app already keeps in sync |
| `folder` | A folder | a folder on this device, or on a network share |

`FolderSyncProvider` wraps the folder — `NativeSyncFolder` on the desktop — and
adds the service's name plus the path, which is all `describe()` needs.
`syncProviderAt(id, path)` builds one from a reader's pick and applies
`syncFolderAt`'s rules: a path is required, and a build that cannot reach a
folder on the device is refused rather than offered a switch that does nothing.
`MemorySyncProvider` is the test double: a memory folder that says it is one, so
two simulated devices can share it.

The merge's vocabulary still says *"the folder's copy"* for the other side of a
document (`SyncConflict.kept`). That is the merge's language; a provider changes
where the bytes live, not how two libraries are reconciled.

## The merge

Three-way, against the **last agreement**: the document as this device last saw
it, kept beside the library (never in the folder), because that is what turns
"the mark is set" into "the mark changed here since we last agreed".

- Every record carries the second it last changed. A record that has not changed
  since the agreement keeps the time it was agreed by, so a device that has done
  nothing cannot win an argument with a device that has.
- **Read and starred are two registers.** One device marking an article read and
  the other starring it both keep their change; a boolean cannot disagree with
  itself, so the only question a mark answers is *when* it moved.
- **An arrival is not an unmark.** A post fetched after the last agreement was
  never compared, and unread is what a fetch writes. So an unmarked article that
  arrived recently inherits the agreement's mark instead of clearing it —
  otherwise the first device to fetch a post would delete the other's read mark.
  An article that was already here and is unread *is* a reader's decision, and
  travels.
- **A removal is a decision.** A deleted feed leaves a tombstone holding its last
  known name. A rename or a refile on the other device is not a re-subscription
  and does not bring it back; only a device that has *seen* the tombstone can
  subscribe again, and the tombstone's title is what it restores.
- **A tie settles on the record, not on the side it came from.** Two devices
  editing the same field in the same second are compared field by field, so both
  of them land on the same answer instead of flapping it between them.
- **A move is not a second subscription.** A feed's key is the address it finally
  answers at. When one device sees it answer somewhere else it rewrites the feed's
  key and its article ids, and the old address travels in the document's
  `redirects` group. Every copy is read through those redirects *before* anything
  is compared, so a device that disagrees only about an address has not disagreed
  about the feed: the document ends with one feed, one set of marks, and the old
  address recorded rather than tombstoned. A redirect that points back where it
  came from is dropped instead of being followed.
- Every disagreement is reported as a conflict (`SyncConflict`: group, key, which
  side was kept, what the loser said) rather than resolved silently.

Subscriptions merge as one record. Renaming a feed on one device while refiling
it on another keeps the newer record whole — the granularity of a feed is a feed.

## Settings

The settings half of the document is a `PrefsDoc` — the same shape, the same
`mergePreferences` rule and the same namespaces (`reading`, `theme`, `search`)
that the server path already uses (`lib/prefs-sync`). Reusing it is the point: a
reader who syncs one device by folder and another by FreshRSS must not get two
opinions about text size. Provenance is per namespace, newer wins, a tie keeps
this device's copy.

The engine does not own that document: the caller passes
`{ local: PrefsDoc, adopt(doc, namespaces) }`. Its `adopt` is called with the
merged document and the namespaces whose value came from the folder's copy, so
the stores can take them and the stamps can be recorded exactly as the server
path records them.

The background picture is not among the values that travel: it arrives as a
data URL of megabytes, and `plainValue()` in `lib/prefs-sync` already drops any
string past 2048 characters.

## The section

Settings draws **Device sync** for a local library that has feeds in it and for
nothing else: a first launch has nothing to sync, and a reader signed in to a
server already has FreshRSS doing this for them (`showsDeviceSync`). Two halves,
and `cloudSync` alone decides which one:

- **not bought** — what stays in step, both terms and their real saving, and the
  two buttons;
- **bought** — the four services, each with the folder it remembers on this
  device, the last run and **Sync now**.

One purchase covers all four providers, so changing service opens the folder
picker and never the store. A run is refused before the engine when there is no
provider or no folder for it, and a failed run is one line under the button that
leaves the library, the agreement and the last-run time alone.

## Refusals

| Situation | What happens |
|---|---|
| the folder has never been used | a document is written; this is the first device |
| the document is unchanged by a merge | nothing is written, so cloud folders stay quiet |
| the provider cannot be read (no permission, an unmounted drive) | refused before anything is applied or written: the library, the document and the last agreement are all left exactly as they were |
| the document is from a newer build (`version` greater) | refused, nothing written — read it wrongly and a newer device's data is erased |
| the file is not a document (truncated, hand-edited) | refused, nothing written; the panel can say to move it aside |
| one record is unreadable | that record is dropped, the rest of the document still arrives |
| a mark is for an article this device does not hold | skipped and kept in the document for the device that has it; counted in `ApplyReport.marksSkipped` |

## What is not here yet

- **When a run happens.** Only when the reader presses **Sync now**. Running on
  launch, on resume and after a change is not wired to the folder yet — the
  refresh interval in Settings is about fetching feeds and is a different
  scheduler. The section is
  `src/components/DeviceSyncPanel.svelte`, its state is `state/device-sync`, and
  what this device chose is `lib/sync-setup` — one folder per provider per
  profile, under a device key, never in the document.
- **The per-account preferences blob** (`hardlyreader:prefs:<slug>`: sidebar
  order, pins mirror, indent). It is keyed by an account slug that a local
  profile does not have yet; inventing one here would put a device-specific key
  in the document.
- **iOS.** The Rust side is std-only and compiles for the phone builds, but an
  iCloud container needs an entitlement and a folder the Files app can see. Until
  then a phone build can point at a synced folder it is allowed to open.
- **Folder-level conflict copies.** Two devices writing at once through a cloud
  client that keeps `(conflicted copy)` files leave one of those beside the
  document; the merge already converges on the next run, and nothing here deletes
  the reader's file for them.

## Proving it

`tests/unit/local-sync.mjs` — 29 checks over two real `LocalStore`s and one
shared folder: adoption, quiet re-syncs, independent registers, arrivals, unmarks,
removals versus renames, re-subscriptions, empty folders, settings adoption,
refusals, same-second ties, pruning, and the name this file and `sync.rs` agree
on. `src-tauri/src/sync.rs` carries its own `cargo test` cases for the path rules
and the atomic write.

`tests/unit/feed-identity.mjs` — 9 checks on the identity a redirect must not
split: the resolved address recorded, the key rewritten instead of a second feed
added, the articles and their marks following, a second spelling folded in, a
redirect to a web page ignored, a redirect back not followed, a changed guid
scheme keeping the old row superseded — and the acceptance case: a feed that
redirects between two syncs leaving one feed, one set of marks and no duplicate
in either device's document.

`tests/unit/sync-provider.mjs` — 6 checks on the seam itself: two devices merging
through one `MemorySyncProvider`, a provider whose `read()` throws leaving the
library, the document and the last agreement untouched, the four cloud ids writing
to the folder they were handed and nowhere else, and a plain object with the four
members standing in as a provider.

`tests/unit/device-sync.mjs` — 71 checks on the state behind the section: one
record per provider per profile under a device key (never the synced settings
document), the refusals in order (no library, no provider, no folder, no folder
support) each saying why in one line, a failed run leaving the agreement and the
last-run time exactly as they were, and the section's own gate.

`tests/unit/device-sync-section.mjs` — 29 checks that render the component for
Svelte's server target in both entitlement states with everything else held still,
so the half that is drawn is decided by `cloudSync` and by nothing else; it also
pins that all four providers sit behind the one purchase and that switching
service asks the store for nothing.

`tests/unit/settings-panel.mjs` — the real sheet: the interval row is called
**Refreshing**, no section is called Sync, Device sync is absent for an empty
library and for a server profile, and both of its halves draw inside the section
that mounts it.
