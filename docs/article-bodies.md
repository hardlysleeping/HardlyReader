# The text a library on this device keeps

A feed's XML carries a summary — sometimes the whole piece, sometimes two
sentences and a "continue reading" — and nothing else. So a library made only of
feed XML is a library of what each feed chose to say, and the article itself is
fetched again every time it is opened. This document is the copy that is kept
instead: where it lives, what it costs, and who sees the request.

Out of scope here: the sync document (bodies never go into it — see below) and
pictures, which are a **separate cache with its own ceiling, its own three
answers and its own table** — `src/lib/images.ts`, `src/lib/image-cache.ts`,
Settings → **Saved pictures**. The last section is what it keeps, and what it
will not.

## What is kept, and where

`src/api/local/schema.ts` → the `extractions` table, one row per post, keyed by
the same `itemId` as the entry it belongs to. The row holds the readable body
plus everything the pane needs to draw it without the feed in hand: `title`,
`byline`, `text_length` (what `chooseBody` weighs), `bytes` and `used_at`.

| concern | answer |
|---|---|
| the copy | `extractions.html`, one row per post, beside its entry |
| a failure | `status = 'failed'` with the reason, no body and no bytes |
| the budget | `bytes` (UTF-8 of the body), `used_at` (last read), least-recently-used when full |
| the policy | `src/lib/bodies.ts` — the three answers, the ceiling, the eviction plan |
| the adapter | `src/lib/body-cache.ts` — what the pipeline reads and writes |
| the preference | `src/state/bodies.svelte.ts`, device key `hardlyreader.bodies.v1` |
| the pipeline | `src/lib/extract.ts` — `setExtractionCache()`, consulted inside `extractFor()` |
| the suites | `body-budget.mjs`, `local-bodies.mjs`, `body-cache.mjs`, `extract-cache.mjs` |

It is its own table rather than a column on `entries` because a body is a *copy*:
deleting one must never touch a subscription, a read mark, a star or a reading
position, and evicting to meet the ceiling must not be able to delete the post.

## The three answers

Settings → the Aa panel → **Saved text**, drawn next to Reader view because it is
the same question twice: *where the text is shown from* and *whether the text is
kept*.

- **Off** (default) — nothing is kept. Bodies already on the device still open
  without a request; turning keeping off never throws away a page that was
  already paid for.
- **On open** — the post you open is fetched (if it was not already) and its body
  is kept, whether or not the pane is showing the article. "Show me the article"
  and "keep the article" are separate requests on purpose.
- **Ahead** — the same, and the queue in `extract-queue.ts` also prepares the next
  few posts, so a step forward finds the article already stored. This is the one
  answer that fetches pages for a feed which already sends its posts whole.

The ceiling is a device-level choice (8, 24 or 64 MB; 24 MB by default) because
one disk has one ceiling. A post bigger than 2 MB is not kept: past that it is a
download, not an article.

## The order inside `extractFor()` is the contract

**memo → what the device kept → the ledger → the network.**

- The device's copy beats the ledger deliberately: a page parked today may have
  been read successfully last week, and what is on disk outranks a retry timer.
- `force` — an explicit ¶ press — is the only thing that skips both. A press
  means "as it is now", so the page is asked again and the copy is replaced.
- A body that arrives is offered to the cache. Declining is the cache's business
  (keeping off, a page over the per-post ceiling), and a cache that cannot write
  never fails a page that has already arrived.
- A cache with no library behind it — a reader whose articles live on a server —
  answers nothing and writes nothing, so the pipeline behaves exactly as it did
  before this existed.

## The budget

`planBodyEviction()` in `src/lib/bodies.ts` is pure: least recently used first,
then least recently fetched, then by id (the id breaks a tie so the order cannot
differ between two engines or two runs). Two things it will not do:

- **Evict a body a pane is showing.** `ReaderPane` and `InlineArticle` report the
  post they are drawing; those ids are protected for the pass.
- **Delete one body more than the ceiling needs.** When everything left is
  protected the answer says `overLimit` instead of deleting the article on screen
  — one over-limit library beats a blank page.

## Who sees the request

A kept body is fetched from the publisher's own page. The request goes from this
device, so this device's address is in that publisher's log. A reader with a
FreshRSS server has that server in front of them; a library on this device has
nothing in between. The panel says so under the rows, in those words.

Nothing about a body goes into the sync document. Bodies grow without bound, and
a document carrying them is a document nobody could sync: the library travels
between devices and each device fetches the text it wants to keep.

## Pictures are a separate cache

Every picture in the app used to be an `<img>` pointed straight at the publisher:
a scroll cost one request per picture, and a scroll back cost them all again. The
picture cache keeps what a pane has drawn, at the size it drew it.

| concern | answer |
|---|---|
| the copy | the `images` table (one row per variant, `thumb` or `full`) and `image_data` (the bytes, base64) in `src/api/local/schema.ts` |
| downscaled at fetch | `thumb` is 192px; `full` is the article column's width × the screen's density, capped at 1600 |
| the policy | `src/lib/images.ts` — three answers, 100 / 200 / 500 MB (200 default), 2 MB per picture |
| the budget | `bytes` is the UTF-8 size of the stored text (about a third more than the file), `used_at` is the last draw, LRU when full |
| the adapter | `src/lib/image-cache.ts` — fetch, downscale, keep, evict; one promise per picture, four downloads at a time |
| the preference | `src/state/pictures.svelte.ts`, device key `hardlyreader.pictures.v1` |
| the element | `use:picture` — the action that hands an `<img>` its address |
| the suites | `picture-budget.mjs`, `picture-cache.mjs` |

- **Three answers.** *Off* keeps no copy and every draw fetches from the
  publisher, exactly as the app did before; *Thumbnails* (the default) keeps the
  post list's pictures, which is what a scroll pays for; *Everything* also keeps
  the article's lead picture.
- **The device's copy is the loader, not a second request.** On a miss the
  `<img>` is given no address until the fetch settles, so a picture is downloaded
  once and drawn from disk from then on — the fallback is the publisher's own
  address, used when there is nothing to keep (a server's library, keeping off, a
  refused fetch) and never a blank box.
- **A picture on screen is never evicted.** Every draw holds its key until the
  element goes; a pass that cannot get under the ceiling without taking one says
  `overLimit` instead.
- **What it does not keep:** the pictures inside an article's body (that is the
  article's own markup), and nothing at all for a library on a server.
- **In a browser tab** a picture can only be read if the publisher allows this
  origin to read it (CORS). Where it does not, the download is a miss and the
  hotlink is drawn as before, so the cache fills in the desktop app — whose
  request is made by Rust and carries neither the webview's origin nor its
  referrer. That is a real limit of the browser build, not a bug.
- Nothing about a picture enters the sync document: `docs/sync-format.md` says
  image caches never travel, and this cache does not change the format.
