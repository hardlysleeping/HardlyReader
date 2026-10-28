# The text a library on this device keeps

A feed's XML carries a summary — sometimes the whole piece, sometimes two
sentences and a "continue reading" — and nothing else. So a library made only of
feed XML is a library of what each feed chose to say, and the article itself is
fetched again every time it is opened. This document is the copy that is kept
instead: where it lives, what it costs, and who sees the request.

Out of scope here: pictures (a separate, larger cache) and the sync document
(bodies never go into it — see below).

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
