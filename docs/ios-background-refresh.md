# iOS background refresh

The local library's poller (`src/api/local/refresh.ts`) fetches the feeds that
are due whenever the app is open, resumed, or asked. On iOS the app is mostly
*not* open, so the platform offers one more moment: a `BGAppRefreshTask`, which
iOS grants at a time of its choosing — often once a day, sometimes not at all.

This is the native half of that. It is a port, not a second policy: the same
interval, the same backoff, the same cap per wake, the same conditional
requests, the same item ids, against the same `hardlyreader.db`.

## Why Swift, and not the app's own poller

A background task starts the *process*, not the WKWebView's JavaScript context.
The app's poller is JavaScript, so during a wake it is not running — unless the
task boots enough of the app to load the webview, which iOS is not generous
about in a ~30 second budget and which no one here can test.

So the wake fetches natively. That is the choice the checks can stand behind:
the arithmetic, the scanner and the SQL are all exercised outside iOS
(`scripts/ios-refresh-checks.sh`), and the only untested part is the
`BGTaskScheduler` plumbing itself — which is exactly what the Codemagic IPA is
for.

## The files

| File | What it is |
|---|---|
| `src-tauri/ios/RefreshPolicy.swift` | the numbers, and the due-time arithmetic (`RefreshMath`) |
| `src-tauri/ios/FeedScanner.swift` | RSS/Atom in, entries out — a port of `src/lib/rss.ts` |
| `src-tauri/ios/LocalLibrary.swift` | the `feeds` and `entries` tables, over `sqlite3` |
| `src-tauri/ios/BackgroundRefresher.swift` | one wake: due feeds, conditional GETs, writes, one log line |
| `src-tauri/ios/AppRefreshTask.swift` | `BGAppRefreshTask`: reschedule, run, complete exactly once |
| `src-tauri/ios/AppRefreshTaskHook.m` | `+load`, the only place registration may happen |
| `src-tauri/Info.ios.plist` | `BGTaskSchedulerPermittedIdentifiers` and `UIBackgroundModes: fetch` |
| `src-tauri/ios/Checks/Checks.swift` | 97 checks against a real SQLite file, no Mac needed |
| `scripts/ios-background-refresh.sh` | runs on the Mac: puts the two halves into the Xcode project |

`src-tauri/gen/apple` does not exist on Linux — `tauri ios init` makes it, on a
Mac — so the Swift cannot simply live in the Xcode project. The wiring script
copies it into the generated `Sources/` and re-runs XcodeGen, then proves the
files are in the target's compile sources. The plist keys need no script:
Tauri merges `src-tauri/Info.ios.plist` into the generated plist itself, during
`tauri ios build`.

## What a wake does

1. **Reschedule first.** `setTaskCompleted` spends the request; a fresh one is
   submitted before any work, so a run that is killed still leaves a wake behind.
2. **Read the due feeds** from `hardlyreader.db`, at most six, stalest first —
   the same `dueFeeds` rule, including the key that breaks ties so a bounded
   wake cannot starve the same feed every time.
3. **Fetch one at a time**, with `if-none-match` / `if-modified-since` from the
   row. A `304` moves `attempted_at`, clears `failures` and stores nothing.
4. **Write entries first, then stamp the row** — so a store that refuses a batch
   leaves the feed due rather than looking current.
5. **Log one line**: how many were due, attempted, changed, answered `304`, how
   many articles were added, how many failed, and which feeds were tried.

```
bg-refresh: background wake — 7 due, 6 attempted, 4 changed, 2 answered 304, 11 added, 0 failed — https://a.example/feed | https://b.example/rss | …
```

Failures are logged per feed, in the same words the app uses in its readout.

## Completing, on every path

`setTaskCompleted(success:)` is called exactly once per wake, through a
lock-guarded `Completion`, so the work finishing and the deadline arriving
cannot both finish the same task. The paths are:

- the work returned → `success: true`, unless the wake was stopped;
- a store error, or the deadline → `success: false`;
- there is no library on this device yet → `success: true` (nothing to do is not
  a failure);
- a `BGTask` that is not a `BGAppRefreshTask` → `success: false` immediately.

When the deadline arrives, `expirationHandler` cancels the Swift task — which
cancels the in-flight `URLSession` request — completes the background task, and
the loop stops at the next feed boundary.

## The identifier

`ing.hardlysleep.hardlyreader.refresh` — the bundle identifier plus `.refresh`.
It is spelled in four places (Swift, the `+load` hook, `Info.ios.plist`, and the
build's read-back check), and `tests/unit/ios-background-refresh.mjs` fails if
any of them disagree. A launch handler registered under an identifier the plist
does not permit is *silently* never launched, which is the failure mode this
guards against.

Nothing assumes an hour, a time of day, or that a wake will arrive. The request
says "no earlier than fifteen minutes"; iOS decides, and the due times live in
the database, so the library is current as of the last wake that did happen.

## Proving it

On any machine with Swift and libsqlite3:

```bash
scripts/ios-refresh-checks.sh     # 97 checks: policy, scanner, ids, SQLite writes, a full wake
pnpm test                         # the JS suites, including the parity checks
```

On the Mac (Codemagic does this in the `ios-unsigned` workflow):

```bash
pnpm tauri ios init --ci
bash scripts/ios-background-refresh.sh   # copy + xcodegen + prove it is in the sources
pnpm tauri ios build --ci --no-sign
```

The build step after that reads the keys back out of the built `.app` and looks
for `hardlyreader_app_refresh_handle` in the binary; a build where the wiring
did not land fails there instead of shipping.

What no build can prove is a wake actually happening. That is one line per
wake, on a device with the IPA installed:

```bash
log stream --predicate 'subsystem == "ing.hardlysleep.hardlyreader" AND category == "background-refresh"'
```

It prints `bg-refresh: background wake — …` naming the feeds tried and how many
answered `304`. Until that line exists on a device, this is code that compiles
and passes its checks, not a refresh that has been seen to run.

## What is not done here

- **No signing.** The Codemagic workflow produces an unsigned `.ipa`; installing
  it (AltStore/SideStore re-signs) is a manual step.
- **No `BGProcessingTask`.** Whole-article extraction belongs in a longer,
  rarer window and is a separate card; a wake this small is what the refresh
  budget is for.
- **No image or text cache warming** — same reason.
