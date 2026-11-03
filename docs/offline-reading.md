# Offline reading, v1

A reader on a train. The tunnel takes the network away for four minutes, they
read nine posts and star one, and then the signal comes back. Nothing in that
window is a decision they have to make again.

That is the whole feature, and it is two separate things that happen to meet on
the same screen:

| the reading | how it stays readable with no network |
|---|---|
| **the sidebar** — feeds, folders, counts | the last successful read is stored per account (`state/persist.ts`) and painted before the first request; a launch with no network keeps those rows |
| **the post lists** — a stream's page, its continuation | the last page of every recently opened stream is on disk too (`stream:<stream>`, 60 streams), painted immediately and revalidated behind it; a failed revalidation leaves the page alone. On top of that, the **offline copy** keeps the last 8 posts of every feed (`lib/offline-copy.ts`), so a feed never opened this session still opens with something in it |
| **the article text** | a saved-text cache keeps both halves of what the pane draws — the feed's own HTML and the extracted article — for every post that was opened, so the second open is a disk read, not a request |
| **the marks** — read, starred | `api/offline` — the queue this document is about |

The three caches were already there and are not this change. The queue is.

## A mark lands on the device first

`ReaderState.setRead` and `toggleStar` no longer speak HTTP. They ask the
account's backend, exactly as every read does:

```
reader.setRead(item, true)
  → backend.setRead([id], true)
      → OfflineBackend   writes the mark to the queue, resolves
      → GReaderBackend   …later, when there is a network: edit-tag
```

`OfflineBackend` (`src/api/offline/backend.ts`) is the server backend with a queue
in front of it. It is installed by `serverBackend` in `api/profile.ts` — the one
place a server backend is built — so a local
library is untouched: its `LocalBackend` writes the mark into SQLite/IndexedDB and
it is on disk before the call returns, which is what "persist immediately" means
for an account with no server. A wrapper around a store would only add a second
place a mark could be lost.

`setRead` resolves as soon as the queue has the mark on disk. It does not wait for
the request, and it does not fail when the request fails: the reader's press is
finished. If the queue itself cannot be written — a locked database, no disk at
all — the mark goes to the server the old way and fails the old way, with the
banner, because a quiet "saved" that is neither stored nor sent is the one
outcome worse than an error.

## The queue

`src/api/offline/journal.ts`. One queue per account, keyed by the same slug every
other device store uses (`lib/account-key`), so two logins on one phone never
flush into each other.

- **Read and starred are two registers.** A post marked read and then starred is
  two facts, and one field cannot hold both. Same rule as the device-sync document.
- **Last value wins.** Read, unread, read again queues one write, and it says read.
- **Ordered by when the reader pressed**, so the queue reads like the session did.
- **Stored in `hardlyreader-writes`** (IndexedDB), its own database: never the
  local library, never a cache that may be cleared on a whim. A queued mark is a
  decision the server has not heard yet.
- **Written through on every press**, not on exit: a crash or a killed window must
  not take a mark with it.

## Sending it

`OfflineBackend.flush(force)` drains the queue oldest first, batched by register
and value — one `edit-tag` carries every post marked read in a batch, because
twenty requests' worth of round trips is not what a reconnect should spend.

It runs by itself:

| moment | why |
|---|---|
| after a press, when the last attempt worked | online, the queue is emptied as fast as it fills |
| after any read that got through (a page, the sidebar) | a request landing means there is a network — the cheapest liveness check there is |
| the browser's `online` event (`Main.svelte`) | the reason for waiting is over; `force` skips the backoff |
| the start of a pull (`ReaderState.refresh`) | before the reads, so the answer that comes back has heard about the marks |
| the next launch | a queue on disk is sent by the first flush of the session |

A failed attempt leaves a backoff (20 s for a network, 5 min for a dead
credential) so a press while offline does not turn into a request per keystroke.
Nothing is retried while the backoff stands, except a `force`.

A failure is classified by what it was (`verdictFor`):

| what happened | what the queue does |
|---|---|
| the connection never reached a server; a 5xx; a 429; an abort | kept, retried after the backoff |
| the credential was refused (401) | kept, retried rarely — a token does not heal by waiting, it heals by signing in |
| any other 4xx: the server looked at the request and refused it | dropped, and named in `lastFlush.refused` |

Looping on a request a server has refused is not persistence, it is a bug with a
timer.

## A page is painted with the mark the server has not heard

A read that lands while marks are still queued returns the server's answer, which
is older than the reader's press. `OfflineBackend.stream` overlays the queued
marks onto the page before it is returned, so the list does not flip a post back
to unread for the length of a flush. A page with no queued marks is returned
untouched — the same object, not a copy.

`ReaderState` also keeps its disk copy of the open stream in step (`cacheActiveStream`
after a mark), so a restart with no network shows the mark rather than the page as
it was before it. Posts marked read in *other* streams' stored pages are corrected
by the overlay on the next live read, and by the server once the queue lands.

## What this deliberately does not do

- **No second cache in the middle.** Reads are not mirrored by the offline layer;
  the disk caches above already answer "what did the server say", and a second
  copy would disagree with the first within a week.
- **No queue for feed management.** Adding, removing and refiling a feed, the
  extension's hidden/pinned state and the sidebar positions still need the
  network and still say so. They are rare, they change structure rather than one
  flag, and two devices editing structure offline is a merge problem this version
  has no answer for.
- **No new screen, no badge, no "offline mode" to switch into.** The three panes, the
  themes, the views and the keyboard flow are what they were, and a mark that lands
  is drawn exactly like a mark that lands. The one control the mode has is a Settings
  row ("Keep feeds for offline", under Refreshing) because the offline copy spends
  requests, and spending them without a way to stop is not a default — it is a
  surprise.

## What is proven, and where

`tests/unit/offline-writes.mjs`, 55 checks:

- a queued mark survives a restart, last value wins, the two registers stay
  separate, the queue keeps the order of the presses;
- forgetting a mark only forgets the exact one that landed, so a press made while
  the write was out survives its completion;
- a press resolves while its request is still hanging, and the mark is one request
  once it does;
- three presses are one `edit-tag`; read and starred are two calls; an empty queue
  makes no request;
- a dead connection keeps the mark and reports `unreached`; the backoff holds
  against repeated attempts and expires into a successful one; `force` skips it;
- a 503 and a 401 keep the marks; a 400 drops them and names them;
- a page from the server is painted with the queued mark and is not mutated; a
  page with nothing queued comes back as itself;
- a queue that cannot be written sends the mark the old way, keeps no phantom
  copy, and lets a real failure reach the reader;
- `serverBackend(session)` gives a server account a queue; a local library keeps
  its own store and has no queue, because its marks are already on disk;
- the queue answers `pendingMarks()` for a page the backend did not send, and a
  mark reads the same whether the server spells it `user/-/…` or `user/1/…`.

The offline copy is its own suite, `tests/unit/offline-copy.mjs`, 50 checks: the
ceilings, the twelve-hour staleness rule, never-kept feeds first, junk stamps, and
that the reader writes it to disk only (`keepStreamOnDisk`) so a kept page can
never become the page the list shows.

## What the offline copy costs, and what it does not do

Eight posts a feed, at most twenty feeds a pass, one request at a time, and a feed
kept in the last twelve hours is not asked again — so a normal day is one pass,
not one per sync. It never replaces a page the reader is holding in memory, and it
never writes a shorter page over a longer one on disk.

It does not fetch article text or pictures: a post whose body was never opened has
no body, and a picture never shown has no bytes. Those are separate caches and
separate budgets.

Not proven by tests, and worth a hand check on the release build: reading for a
few minutes in airplane mode, killing the app, relaunching still in airplane
mode, and watching the marks arrive on the server when the network returns.
