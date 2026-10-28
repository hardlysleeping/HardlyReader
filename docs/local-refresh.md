# Local background refresh

In server mode FreshRSS is the crawler: the app asks for a stream and the server
has already fetched the feeds. A **local** library has nobody behind it, so the
app fetches its own feeds — `src/api/local/refresh.ts`.

## The rule: a wake, not a schedule

Nothing here has a timer. Each feed's row remembers when it was last attempted
(`attempted_at`), when it was last read successfully (`fetched_at`), and how many
attempts in a row have failed (`failures`). A **wake** fetches whatever has gone
stale and does nothing else.

| Wake | Who calls it |
|---|---|
| `launch` | the app opened |
| `resume` | the window came back (`visibilitychange`) |
| `background` | the OS granted a moment (iOS `BGAppRefreshTask`) |
| `manual` | a reader pressed refresh |

All four are the same call — `refresher.wake(reason)` — and all four are answered
by the same due-time arithmetic. That is deliberate: a wake that arrives early
costs nothing, a wake that never arrives costs nothing, and no code anywhere
depends on being called at a particular hour.

## The numbers

`REFRESH_POLICY` in `refresh.ts`:

- **60 minutes** between polls of a feed that works.
- **×2 per consecutive failure**, capped at **6 hours** — a site that has been
  down since Tuesday is asked a handful of times a day, not on every wake.
- **6 feeds per wake**, stalest first — a week away and a relaunch is six
  requests, not sixty.
- **15 seconds** per request before it counts as a failure.

Two times are stored rather than one because they answer different questions:
`fetched_at` says how stale this library is (a `500` does not make a feed
current), `attempted_at` is what the next attempt is measured from.

## A poll that changed nothing costs nothing

The feed's `ETag` and `Last-Modified` are stored beside it and sent back as
`if-none-match` / `if-modified-since`. A `304` is the ordinary answer for a feed
that has not published since last time; it moves `attempted_at`, clears the
failure count and writes no articles. Measured against live feeds: xkcd and
Lobsters both answered `304` on the second wake, `added: 0`.

## A feed that answers somewhere else

A feed's key is the address it **finally answers at**, not the one it was typed
in as: `response.url` is compared with the row's key, and a difference in origin
or path moves the subscription rather than adding one. The row keeps the address
it resolved to in `resolved_url`, its articles are re-minted under the new key so
their read and starred marks move with them, and the old address is left in
`redirects` so the other device follows instead of subscribing a second copy.
`src/api/local/store.ts` does the rewrite in one transaction; the poller only
tells it where the answer came from.

Three parts of that are deliberate:

- **Only after the body is a feed.** A redirect that lands on a login page or an
  error page is not a move, and moving a subscription because a site had a bad
  afternoon would be worse than leaving it where the reader put it.
- **A trailing slash is not a move.** `https://example.com/feed/` and
  `https://example.com/feed` are one address spelled two ways; a different host
  is not.
- **A redirect back is not a move.** The recorded move answers the loop, so a
  feed that answers one way and then the other is not rewritten on every poll.

## Failures belong to the feed, not to the wake

A network error, a `500`, an HTML page where the feed should be, a body that will
not read — each becomes one line in `report.failures`, one increment on that
feed's row, and a `last_error` in words. The loop carries on to the next feed.
Being **offline** is not a failure: the wake returns `skipped: "offline"` and
counts nothing against anybody.

## iOS

iOS never promises an interval. `BGAppRefreshTask` is granted at a time of the
system's choosing — often once a day, sometimes not at all — so nothing here may
assume it will be called, and nothing here needs it to be: the due times live in
the database, so the library is current as of the last wake that did happen.

Two facts about the platform shape the work:

1. **The webview is not running in a background task.** A `BGAppRefreshTask`
   starts the process, not the WKWebView's JS context, so the poller above
   cannot be the thing that runs — unless the task boots the app far enough to
   load it, which iOS is not generous about.
2. **The project is generated on a Mac.** `src-tauri/gen/apple` does not exist on
   Linux (the Linux Tauri CLI has no `ios` subcommand); it is produced by
   `tauri ios init` on the cloud Mac that Codemagic uses. So the Swift side of
   this cannot be written or compiled on this machine.

What the native task must do, whichever way it is built:

- Register a `BGAppRefreshTask` identifier in `Info.plist` and schedule it after
  each run (`setTaskCompleted`), never at a fixed hour.
- On the wake, fetch the feeds that are due by the same rule — the same
  `intervalMinutes`/`failures` arithmetic, read from the same SQLite file — and
  write entries and validators back into that file. Reimplementing the policy in
  Swift is acceptable; inventing a *second*, different policy is not.
- Finish within the system's deadline and call `setTaskCompleted(success:)`
  either way.

A wake that fetches at most six feeds with conditional requests is small enough
for the budget iOS gives. Anything that downloads whole articles in a background
task is not, and the image/text caches are separate cards for that reason.

## Proving it

```bash
# the suite (32 checks): due times, backoff, 304s, refusals, timeouts, the shared wake
distrobox enter Arch -- bash -lc 'cd … && node --experimental-strip-types \
  --import ./tests/unit/register-ts.mjs tests/unit/local-refresh.mjs'

# the whole set
distrobox enter Arch -- bash -lc 'cd … && pnpm check && pnpm build && pnpm test'
```

The live smoke run used xkcd's Atom feed and Lobsters' RSS feed through the real
`fetch`: 29 articles stored on the first wake, and two `304`s on the second.
