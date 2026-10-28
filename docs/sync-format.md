# The sync format is the product, the provider is a dumb transport

Hand this to anything that designs `SyncEngine` or a provider. Every supported provider stores **the
same data in the same format**: iCloud Drive, Google Drive, Dropbox, OneDrive. A provider decides how
bytes are uploaded and downloaded. It never decides what a feed is, how pins work, how hidden
categories work, how ordering merges, or how conflicts resolve.

```
Local SQLite  →  SyncEngine  →  canonical HardlyReader files  →  any provider
```

Copy `HardlyReader/` from one provider to another and the app keeps working, with no conversion tool:

```
iCloud Drive/HardlyReader/   →   Google Drive/HardlyReader/   →   same library, same state
```

## SQLite is never synced

The device's SQLite is the working database: feeds, articles, read state, stars, categories, hidden
and pinned categories, ordering, preferences, position. A SQLite file mutated by two devices is
corruption, not a merge. It stays on the device; the folder is the interchange format; the engine sits
between them.

## The canonical folder

```
HardlyReader/
  manifest.json        format + version, written last, read first
  library.json         subscriptions, categories/folders, feed and category ordering
  state.json           read/unread, starred
  preferences.json     theme, reading and layout settings, filters
  positions.json       selected feed, selected article, article position
  tombstones.json      deletions, so an offline device cannot resurrect them
  devices.json         which device wrote what last
```

Split further when a file gets large — `library/feeds.json`, `state/hidden.json`,
`state/ordering.json`, `devices/<device-id>.json` — **inside the same format**. The layout may evolve;
the format identity may not.

## manifest.json, from day one

```json
{ "format": "hardlyreader-sync", "version": 1, "encryption": "none" }
```

Written **last**, read **first**: a reader must never see a manifest promising files that are absent.
A newer version is refused, never half-applied. Migration `v1 → v2` lives in the shared engine —
never `icloud-v2`, `google-v3`. The provider has no vote on the format.

### Encryption: none in v1, ready from day one

No app-level encryption ships in v1. The manifest still **declares** it, so the field is a decision
the format makes rather than a version that has to be inferred later:

```json
{ "format": "hardlyreader-sync", "version": 2, "encryption": "xchacha20-poly1305" }
```

Rules that keep the door open without paying for it now:

- `encryption` is a **required** field in v1 and its only legal value is `"none"`. A reader that
  meets an unknown value refuses the folder and says so, instead of guessing at bytes.
- If it is added, it goes **above the provider layer** — one implementation encrypts the canonical
  files and every transport receives the same ciphertext. Never four implementations.
- The provider interface already takes `Uint8Array`, so encrypted payloads need no interface change.
- A `"none"` folder and an encrypted folder never merge. Switching is a migration, and the manifest
  is what tells the engine which one it is looking at.

Why v1 stays plaintext: the payload is deliberately small (feeds, folders, read and starred state,
hidden and pinned state, ordering, preferences, positions — no bodies, no extracted text, no images),
the files live in the reader's own cloud account, and a lost encryption key would make a *sync* file
unreadable on every device at once. The local library is the source of truth, so this is survivable —
but it is a cost worth deferring until someone asks for it.

## Provider neutrality

Nothing in the canonical data may name a provider or carry a provider's identifiers:

```json
{ "feedId": "feed/https://example.com/rss", "hidden": true,
  "revision": 18, "modifiedAt": 1793123456, "modifiedBy": "iphone-123" }
```

Never `icloudRecordId`, `googleDriveFileId`, `dropboxRevision`, `oneDriveItemId`. Those belong in the
provider adapter's own local metadata, which is disposable.

## Conflict metadata on every record

```
recordId · revision · modifiedAt · modifiedBy · deleted
```

`revision` is monotonic per device and `modifiedBy` is the device id, because timestamps alone let a
device with a wrong clock win every argument. Card `t_21b91dd5`.

## Different data, different merge rules

| data | rule |
|---|---|
| read state | merge independently, per article |
| starred | a separate register from read |
| preferences | last modified wins |
| deletions | tombstones with a retention window |
| feed / category ordering | one ordered-list revision, never interleaved indexes |
| hidden / pinned categories | merge by item id + revision |

## The provider interface

```ts
interface SyncProvider {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  list(path: string): Promise<SyncFile[]>;
  revision(path: string): Promise<string | null>;
}
```

Bytes rather than strings, because encryption sits **above** this layer: one implementation encrypts
the canonical files and every provider receives the same encrypted bytes. Four encryption
implementations would be four ways to get it wrong.

`src/api/local/sync-provider.ts` carries these as **optional** members beside the existing
`read()`/`write()`, so the folder-backed provider keeps working while the engine moves over.

Provider code answers five questions only: where is the file, how do I authenticate, how do I read it,
how do I write it, how do I know it changed.

## Where each provider puts the folder

| provider | location | why |
|---|---|---|
| iCloud | **iCloud Documents / iCloud Drive** `HardlyReader/` | files, visible and copyable; CloudKit records would break portability |
| Google Drive | **visible `HardlyReader/` folder**, narrowest scope | a hidden `appDataFolder` is invisible to the person migrating |
| Dropbox | `Apps/HardlyReader/` (app folder) | narrowest practical permission |
| OneDrive | `Apps/HardlyReader/` (`Files.ReadWrite.AppFolder`) | same |

CloudKit would sync Apple devices beautifully and break the property that matters more: a folder you
can copy. Apple's own distinction is between iCloud *Documents* (files) and CloudKit (records); this
app wants files.

v1 ships folder-backed — the reader points at the folder their own sync client mirrors — and the
integrations above are the same folders reached through an API instead of the filesystem.

## Provider switching is a migration

`Settings → Sync → Change provider`:

```
1. fully sync the current provider      6. write canonical state to the new one
2. read canonical state                 7. verify what was written
3. connect the new provider             8. switch the active provider
4. look for existing HardlyReader state 9. never delete the old provider's files
5. merge if there is any
```

Failure at any step leaves the old provider active and the local library untouched, and says which
step failed. Card `t_c9457710`.

## Export / Import

`Settings → Sync → Export archive` writes `HardlyReader-Sync.zip` with exactly the canonical files;
`Import archive` merges one back through the same engine with the same conflict rules — an import is
a sync, not a replace. Backup, recovery, provider migration, and protection against a provider's API
changing under us. Card `t_f04b12d1`.

```
HardlyReader-Sync.zip
  library.json        subscriptions, folders, the moves, the sidebar's arrangement
  state.json          read and starred
  preferences.json    the settings document, namespaces and their stamps
  positions.json      where the reader was
  tombstones.json     the feeds and folders that were deleted
  manifest.json       format + version, written last, read first
```

`src/api/local/sync-archive.ts` writes and reads it; `src/lib/zip.ts` is the zip, by hand, so the
binary gains no dependency. The manifest is the same three fields the folder's document carries
(`hardlyreader-sync`, version, `encryption: "none"`), plus the device, the time and the file list.

Refusals, each naming what it found rather than what it wanted:

| found | what happens |
|---|---|
| no `manifest.json` | refused: the zip is not a HardlyReader archive |
| a newer `version` | refused, naming the archive's version and this build's |
| a different `format` | refused, naming the format in the file |
| an `encryption` this build cannot undo | refused, naming the value |
| a file the manifest lists and the zip lacks | refused, naming the file |
| a damaged payload (CRC) | refused, naming the file — never half-imported |

An import writes nothing anywhere except the local library: it builds this device's document,
merges the archive into it with `mergeSnapshots`, and applies the result with `applySnapshot` — the
same two calls a folder sync makes. Two consequences worth knowing:

- A mark for an article this device has not fetched is **kept, not refused** — it waits in the
  device's agreement and lands when the post does (the engine's arrival rule, not a new one).
- The merged document becomes this device's base (`withImport`), so a later folder sync carries
  what the archive brought instead of treating it as someone else's copy.

Export needs no provider, no folder and no subscription: a library on this device is the whole
requirement, because the point of the feature is a copy no provider can hold hostage.

## What does not travel, ever (v1)

Extracted article HTML, image caches, thumbnails, temporary API responses, search indexes, stream
caches, and the SQLite file. All rebuildable; all would make sync large and slow.

## Relationship to ReaderBackend

Different questions, deliberately separate:

```
ReaderBackend   where RSS comes from               LocalBackend | GReaderBackend
SyncProvider    where cross-device state lives     iCloud | Drive | Dropbox | OneDrive
```

All three of these are ordinary: The Old Reader + Drive sync; local library + iCloud sync; FreshRSS
with the extensions and no paid sync at all. `docs/authority.md` says who owns which feature;
`docs/sync-invariants.md` lists the traps.

## Definition of done

The architecture is right when this succeeds without a conversion tool:

```
1. iPhone, iCloud sync on
2. add feeds, hide a category, pin another, star articles, rearrange feeds
3. HardlyReader writes the canonical files
4. copy HardlyReader/ into Google Drive
5. open HardlyReader on Linux, connect Google Drive
6. the same feeds, ordering, hidden categories, pins, stars and preferences appear
```
