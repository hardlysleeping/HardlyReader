# The sync format is the product, the provider is storage

One canonical, portable file set. iCloud, Google Drive, Dropbox and OneDrive are transports that read
and write those same files — none of the files knows where it is, and moving a library between
providers is copying a folder.

```
HardlyReader/
  manifest.json        format + version, written last
  library.json         feeds, folders, ordering
  state.json           read / starred marks, tombstones
  preferences.json     reader settings, theme, layout, filters
  positions.json       current stream, article, scroll
```

A document that grows past this splits inside a folder (`feeds/`, `state/`, `devices/`) rather than
changing the format.

## The rules

1. **Never sync SQLite.** A SQLite file mutated by two devices is a corruption, not a merge. The
   device's SQLite is the fast working copy; the folder is the interchange format; the engine sits
   between them.
2. **Every file carries the format name and version.** `manifest.json` is `{"format":
   "hardlyreader-sync", "version": 1}` and is written **last**, so a reader can never see a manifest
   that promises files which are not there. A newer version is refused rather than upgraded blindly —
   `sync.ts` already does this for the single document and the same rule applies per file.
3. **Small.** No article bodies, no images, no extraction results, no ETags or poll state. Those
   rebuild per device; a document that carried them would grow without bound and sync every few
   minutes.
4. **Provider-neutral.** No provider name, no account id and no token inside any file. A provider is
   `readFile`, `writeFile`, `deleteFile`, `list`, `getRevision` — nothing about libraries, marks or
   conflicts.
5. **Portable by hand.** The reader can open the folder in their own file manager, copy it to another
   provider, and the app reads it. That property is the reason for the next section.

## What this changed about the providers

| provider | not this | this |
|---|---|---|
| iCloud | CloudKit records | **iCloud Documents / iCloud Drive folder** — ordinary files, visible to the reader |
| Google Drive | hidden `appDataFolder` | **a visible `HardlyReader/` folder**, narrowest practical permission |
| Dropbox | full Dropbox | `Apps/HardlyReader/` app folder |
| OneDrive | broad Drive scope | `Files.ReadWrite.AppFolder` → `Apps/HardlyReader/` |

CloudKit would work and would sync Apple devices beautifully, but it breaks the property that matters
more: a folder you can copy. Apple's own distinction is between iCloud *Documents* (files) and
CloudKit (records); this app wants files. The same reasoning retires the hidden `appDataFolder` on
Google — invisible storage is invisible to the person trying to move it.

v1 still ships folder-backed: the reader points at the folder their own sync client mirrors. The
integrations above are the same folders reached through an API instead of through the filesystem,
which is why they are transport work rather than a rewrite.

## Export Sync Archive

**Settings → Sync → Export archive** writes `HardlyReader-Sync.zip` containing exactly these files.
**Import archive** reads one back and merges it through the same engine, with the same conflict rules.

That is the escape hatch that makes a provider lock-in impossible: export from iCloud, import into
Google Drive, no migration code, no special case. It is also the answer to "the provider changed its
API" and to "I want a copy of my state I can keep".

## What the engine already does, and what is left

`src/api/local/sync.ts` merges a single document (`hardlyreader-sync.json`) with three-way merge,
tombstones, separate read/star registers and whole-record ordering. That document contains every field
the file set above splits out, so this is a layout change rather than a data-model change:

1. `SyncProvider` gains the path-scoped members beside `read()`/`write()` (optional, so the folder
   provider keeps working) — see the interface in `src/api/local/sync-provider.ts`.
2. The engine writes the file set and migrates a v1 single document on first read.
3. Tombstones live in `state.json`; ordering lives in `library.json`; positions are their own file so
   a position write does not rewrite the library.

Tracked as `t_eec0be1f` (the file set) and `t_f04b12d1` (export/import archive).
