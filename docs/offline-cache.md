# The offline cache, and its settings

A local library is two things in one file: the reader's **list** — subscriptions,
folders, titles, summaries, read marks, stars — and copies of **other people's
prose** fetched because the reader opened something. The second is cache. It
grows on its own, it can be fetched again, and it is the only thing the settings
panel is allowed to throw away.

Code: `src/api/local/cache.ts` (the policy, pure), `LocalStore.cacheUsage()`,
`pruneCache()` and `clearCache()` (applying it), `src/state/offline.svelte.ts`
(the reader's answers and the library they are applied to),
`src/components/OfflinePanel.svelte` (Settings → Offline).

## What the panel offers

| Row | Meaning |
|---|---|
| **Storage used** | the whole library: list rows, cached bodies, extracted bodies, pictures |
| **Keep read articles** | off: an article's copy is dropped as soon as it is read |
| **Keep starred and pinned** | on: a starred post, and every post of a pinned feed, is never evicted |
| **Cache pictures** | written to the same blob the picture cache reads; this build has no picture cache, and the row says so |
| **Cache limit** | ceiling on cached text only: No limit / 100 MB / 250 MB / 500 MB / 1 GB, default 250 MB |
| **Clear cache** | drops every body and every extraction, keeps the list |

There is no **download everything**, and that is a decision, not a gap: the
reader fetches what it is asked for. Mirroring every feed would spend a reader's
data without asking and retain other people's words past what reading requires.

## The limit never counts the list

`planEviction` measures copies only — article bodies plus extracted bodies.
Titles, summaries, feeds, folders, positions, read flags and stars are the
library, and a ceiling that deleted them to save a megabyte would be a data loss
wearing a cache's name. If everything left is protected and the ceiling is still
exceeded, the report says `overLimit` and the panel says the rest is starred or
pinned; nothing protected is sacrificed to make a number look right.

## Eviction order, and why

1. **Read copies**, when `keepRead` is off — at once, not when the device
   happens to fill up.
2. **The oldest bodies** by `stored_at`, then by key so two articles stored in
   one second evict in the same order on every engine.
3. **Leftover extractions**, oldest first. An extracted body can outlive the
   feed's own copy and is usually larger; it can be fetched again by opening the
   article, while a body the feed has stopped serving cannot.

## Bytes are an estimate, and that is enough

Every text value costs its UTF-8 length and every other value eight bytes. That
is not the file size on disk — SQLite and IndexedDB have their own overhead — but
it is the same number for the same library in both engines, which is what a limit
and a readout need.

## Who attaches a library

`offline.attach(store)` is the only way the panel sees one; whoever opens a local
library calls it (and `attach(null)` on sign-out). Until then the panel says
"no offline library on this device yet" instead of showing a zero that would look
like an empty one. A picture cache announces itself with `attachPictures(cache)`,
which is how the Cache pictures row becomes more than a stored preference; its
"Clear cache" goes through the same button.

The policy is stored on the device, not per account (`hardlyreader.offline.v1`):
two accounts on one phone share one disk, so they share one ceiling.

## What is proven, and where

- `tests/unit/offline-cache.mjs` — the policy and the eviction plan against the
  in-memory engine and Node's SQLite: sizes, protection, ordering, clearing,
  and that flags, summaries and subscriptions survive a wipe.
- `tests/unit/settings-panel.mjs` — the section is a disclosure with the six
  rows inside it, five ceilings and no download-everything switch.
- Not proven by tests: what the panel looks like on a phone, or a second visit
  to a feed rendering with no network. Those are running-app checks.
