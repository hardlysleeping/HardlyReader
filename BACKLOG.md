# Backlog

MVP scope per the commit checklist. Linux + FreshRSS + HiddenCategories only; iOS, Android,
Favorites, Sidebar Indent, offline caching and background sync are explicitly out of scope until
this loop is solid.

Status: `done` / `wip` / `next` / `todo` / `blocked`

## P0 — Core reader

| # | Commit | Status | Notes |
|---|---|---|---|
| 1 | App shell: Svelte 5 + TS + Vite + Tauri 2, Linux dev works | done | SvelteKit template stripped to plain Svelte+Vite; `c6d1002` |
| 2 | FreshRSS auth: GReader `ClientLogin`, reuse GoogleLogin token | done | API password only; token in localStorage; http plugin scope needs `http://*:*` |
| 3 | Reader data: categories, subscriptions, articles, read/unread, star | done | `withQuery()` applies `output=json` centrally; `editTag` fetches a write token per call; `subscribe`/`unsubscribe` post `subscription/edit` with the `feed/<url>` id form (`feed:<url>` answers 200 and does nothing); 26/26 smoke checks |
| 4 | Basic UI: sidebar, article list, reader, responsive | done | Three-pane ≥1200, two-pane 840–1199, drawer ≤839; DOMPurify strips scripts/handlers/iframes from real feed HTML; `78c7345` |

## P0 — HiddenCategories bridge

| # | Commit | Status | Notes |
|---|---|---|---|
| 5 | `setCategoryHidden(int, bool)` + `changeView(string)` only | done | Plan §5.1/§5.2 give the bodies; the deployed VPS copy is the source of truth, and editing it needs the owner's explicit permission. Extracted from the inline handler blocks and deployed. `setCategoryHidden(int,bool): array` and `changeView(string): array`; the form handler now calls them, so the web UI and the API share one path. Proven in a disposable container: 200 on hide/unhide/view, `changed:false` when repeated, 400 on /0, non-numeric, absent boolean and unknown view; 409 when the extension is disabled for the user; 423 while armed, carrying state. Refactor of the *live* instance verified read-only: both methods public with those signatures, pages still 200 |
| 6 | `xExtension-HardlyRead`: ApiMisc, 3 routes, GoogleLogin auth | done | 600 lines; 51 tests / 166 assertions green on PHP 8.2, 8.3 and 8.4. `Minz_HookType::ApiMisc`, `enableByList($list,$type)`, `checkUsername()` and every extension accessor it calls (`store`, `categories`, `effectiveView`, `hiddenIds`, `mode`, `view`, `isLocked`) verified public against the deployed FreshRSS 1.30.1; `2a26529` |

## P1 — App integration

| # | Commit | Status | Notes |
|---|---|---|---|
| 7 | Read `/v1/state`, map categories to numeric IDs, apply hidden state | done | `src/api/hardlyread.ts`; state shape matches plan §3 (`available`, `mode`, `view`, `effectiveView`, `hiddenIds`, `locked`, `categories[]`); 57 unit checks. **Not** exercised against a running extension — nothing implements §5 yet; `85951c9` |
| 8 | Hide/unhide UI: right-click desktop, long-press mobile | done | `CategoryMenu.svelte` + `lib/contextmenu.ts`; desktop contextmenu, 500 ms long-press, Shift+F10 and the context-menu key; 81 unit checks. Rendering, focus rings, long-press timing and the drawer-transform positioning argued from code and CSS, never observed; `58b4427` |
| 9 | Optimistic sync: server state + pending mutations = UI state | done | `src/state/hidden-write.ts`: optimistic commit then server state; 409/423 reconcile with the returned state, stateless failures roll back with a banner; 59 unit checks through the real client with a recording fetch; `58b4427` |
| 10 | Hidden view modes: hidden / revealed / only | done | Menu's View group writes `PUT /v1/hidden-categories/view`; HiddenCategories still owns Strict/Light. 423 when locked; `58b4427`. A persistent control in the header cycles the three views, because hiding the last category with feeds emptied the sidebar and the row menu was the only way back — a dead end |

## P1 — Tests

| # | Commit | Status | Notes |
|---|---|---|---|
| 11 | PHPUnit: GET state, PUT category, PUT view; 200/401/404/409/423 | done | 51 tests / 166 assertions, green on PHP 8.2, 8.3, 8.4. Covers auth-before-routing, 404 (unknown route/version/empty/trailing), 405 with `Allow`, 400 (zero, non-numeric, malformed, non-boolean), 409 (`hidden_categories_unavailable`, `extension_incompatible`), 423 locked, convergence carrying authoritative state. Fakes only — no FreshRSS in the loop; `a5dc943` |
| 12 | PHP CI matrix + combined summary | **done** | **Executed on a real runner** (run `39888463114`, 24 s): `PHPUnit / PHP 8.2 → success`, `8.3 → success`, `8.4 → success`, `PHPUnit Summary → success`. Previously only parsed as YAML; `c77f09c` |
| 13 | Docker E2E against real FreshRSS container | done | `tests/integration/run.sh`: own compose project (`hardlyread-e2e`) on port 18081, so it never touches the developer's 18080; installs both extensions, seeds fixed fixture categories, waits on `cli/health.php`, restarts the web server so opcache picks the new config up, runs 52 wire-level checks (`tests/integration/e2e.mjs`) and cross-checks the extension's own store. Diagnostics land in `tests/integration/artifacts/` on failure; `KEEP_CONTAINERS_ON_FAILURE=1` leaves the stack up. 52/52 green locally, twice, plus a verified failure path. **On CI it fails in ~20 s**: `error: Hidden Categories source not found at /home/runner/apps/freshrss/extensions-src/xExtension-HiddenCategories`. So the E2E suite has still never run on a runner — row 43 fixes the checkout, row 44 the missing extension |

## P2 — Release

| # | Task | Status | Notes |
|---|---|---|---|
| 14 | Publish to public GitHub | **done (early, at owner's request)** | `github.com/hardlysleeping/hardlyread`, public, default branch `main`. History is a **single squashed root commit** because the older commits carried private infrastructure details (a tailnet IP, a hostname, the harness password) and a force-push would not have removed them from the remote. Those values were neutralised *before* the snapshot was created — this file deliberately does not repeat them. Verified by cloning the public repo back and grepping. Local `master` keeps the full history and must never be pushed |

Gate: the "Done when" section below must actually pass first. Full history is scanned before the first
push — a force-push does not purge old commits, and this account cannot delete repos.

## Verified, and not

Measured on the merged tree (`d119590`): svelte-check 0 errors / 0 warnings, `vite build` clean,
214 unit checks across five suites, PHPUnit 51/51 on PHP 8.2 + 8.3 + 8.4, and 26/26 live smoke
checks against the disposable harness including subscribe/unsubscribe round-trips.

Measured through the UI against the harness (browser, real HTTP): right-click a category → Hide removes it and its feeds,
the server's `hiddenIds` agrees, `Show` restores it, and the header control cycles Hidden → Revealed → Only → Hidden.

Not measured: anything involving Hidden Categories against the *live* instance. The adapter answers
`409 extension_incompatible` on `PUT` until row 5 adds the two methods, so the hide round-trip —
app, extension and FreshRSS web UI agreeing — has never run. Native WebKit rendering, long-press
timing on a touchscreen and the GitHub Actions run are likewise unobserved.

## Done when

Launch the Linux app, log in, see real FreshRSS content, right-click a category, Hide, it disappears
instantly, HiddenCategories updates, the FreshRSS web UI matches, and server-side changes sync back
into the app. All PHPUnit and Docker tests pass.

## Not building yet

Favorites, Sidebar Indent, NewsBlur, local RSS, offline articles, iOS, Android, background sync.

## Local development

`tests/integration/compose.yml` runs an ephemeral FreshRSS 1.30.1 on
`http://127.0.0.1:18080` with user `itest` / API password `hardlyread-test-password`.

```bash
docker compose -f tests/integration/compose.yml up -d
docker compose -f tests/integration/compose.yml down -v
```

Full E2E in one command. It uses its own compose project and port, so it does
not disturb the harness above (or its 18080):

```bash
tests/integration/run.sh
```

It installs Hardly Read and Hidden Categories into a disposable container, seeds
three fixed categories (`101`–`103`), waits on `cli/health.php`, restarts the web
server so opcache sees the new config, and then drives the v1 API over real HTTP:
auth before routing, 400/404/405, hide/unhide and idempotence, the view cycle,
and absent collaborators answering 409 rather than 500. At the end it reads the
extension's own store back, so the adapter cannot pass by agreeing with itself.

`HARDLYREAD_HIDDEN_CATEGORIES_DIR` must name a checkout that has
`setCategoryHidden()` and `changeView()` (default
`~/apps/freshrss/extensions-src/xExtension-HiddenCategories`).
`HARDLYREAD_E2E_PORT` (default 18081) and `HARDLYREAD_E2E_PROJECT` (default
`hardlyread-e2e`) move the run out of the way of anything else. Every failure
collects FreshRSS and compose logs plus the extension's store into
`tests/integration/artifacts/` (gitignored) before teardown;
`KEEP_CONTAINERS_ON_FAILURE=1` leaves the stack up instead.

Smoke suite against the running harness (real endpoints, real writes):

```bash
node --experimental-strip-types tests/smoke/api.mjs
```

It round-trips read and star on one item, and subscribe/unsubscribe on one feed, restoring both,
so repeated runs stay stable. The subscribe check needs outbound network from the harness, because
FreshRSS fetches the feed itself; `HARDLYREAD_FEED_URL=""` skips it.

Unit tests (no server, no network, no GUI):

```bash
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/hardlyread-api.mjs
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/reader-state.mjs
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/context-menu.mjs
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/hidden-write.mjs
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/menu-render.mjs
```

`register-ts.mjs` lets Node resolve the extensionless relative imports Vite
handles; `reader-state.mjs` and `hidden-write.mjs` compile the runes module with
`svelte/compiler` because Node cannot import `$state` directly. `hidden-write.mjs`
replaces `globalThis.fetch` with a recorder, so the write path runs through the
real client and transport without dialling anything. `menu-render.mjs` renders
`CategoryMenu.svelte` on Svelte's server target and checks the markup string;
documented events, focus and layout remain a visual check.

Browser development (`pnpm dev` only): FreshRSS sends no CORS headers, so `/freshrss`
is proxied to the harness and the app is reached at `http://127.0.0.1:1420` with
server URL `http://127.0.0.1:1420/freshrss`. The Tauri build never uses this proxy.

Never point this at the live instance; the harness is disposable by design.

## v1.1 — Favourites, sidebar indent, add feed (2026-10-22 evening)

| # | Item | State | Evidence |
|---|---|---|---|
| 15 | FavoriteCategories: extract `setCategoryFavorite()`, `changeView()` | **done locally** | Mirror `557f373` + `f5ece2c`. **NOT deployed**: the authoritative VPS copy has neither method (md5 `bf656ec7`, 0 matches), so the favourites routes return 409 on the live instance until it is deployed |
| 16 | Adapter v1.1: favourites + sidebar-indent state and routes | done and deployed | `b404f3f`, status mapping `3a90a5a`, merge `1192140`. PHPUnit 96 tests / 311 assertions. Live deploy hash `06b64c8a`, route still 401 unauthenticated, seven enabled extensions preserved |
| 17 | App v1.1: star, favourites view cycle, indent, add/remove feed | done | branch `b6ae3b9`, merge `a354b46`. svelte-check 0/0, build clean, 377 unit checks across 6 files |
| 18 | Verify v1.1 against a real container | done (API) | `GET /v1/state` returns `favorites{available,view,ids,categories}` and `sidebarIndent{available,px:24}`; favourite on/off round-trips with `changed:false` on repeat; `PUT /v1/favorites/view` cycles all/only/without; 400 for id 0, bad view and non-boolean, 404 for an unknown category. Hidden categories still correct in the same state payload |

Measured in a browser against the harness, after the API contract passed: the sidebar reads the server's
`px: 24` and applies `--feed-indent: 24px`; the category menu shows Hide, Favorite and the three hidden views;
starring Uncategorized updates the row to ★ and persists (`favorites.ids == [1]`); the header cycles the
favourites view All -> Favorites -> No favorites with a visible label at each step; "+ Add feed" subscribes a
real feed (18 -> 22 items, "This Week in Rust") and the confirmation dialog removes it again (back to 18).

Operational note: the browser build reaches the adapter through the Vite `/freshrss` proxy or a same-origin
host. Pointing the browser app straight at a different origin fails CORS before the adapter is reached — the
native build is unaffected because its HTTP plugin ignores CORS. A PWA release needs the adapter's CORS
headers or a same-origin deployment.

Live after deployment: `extension.php` and `lib/HardlyReadApi.php` hashes match this repo, PHP lint clean on
1.30.1 / PHP 8.4.26, `/v1/state` 401 unauthenticated, `/i/` 200, and reflection shows Favorite Categories,
Hidden Categories and Sidebar Indent all exposing the public methods the adapter calls. Revert commands and
backups are recorded in `docs/live-deployment.md`.

Still not measured: an authenticated v1.1 call on the live instance — it needs the owner's API password.

## UI overhaul — plan v1 (2026-10-22 18:00)

Plan: `~/.hermes/plans/2026-10-22_1800-hardlyreader-ui-overhaul-v1.md` (copy in the workspace).
Planning only: nothing below is built. Rows 19-26 map one-to-one onto the plan's phases,
and every one stays blocked until the reference screenshots land and the four open
questions in the plan are answered.

| # | Item | State | Notes |
|---|---|---|---|
| 19 | Password reveal toggle on the login form | **done** | Show/Hide button in the field; measured in the browser: `password → text → password`, label follows, value kept; `0666681` |
| 20 | Stream switching performance | **partial** | Today every switch is one uncached GReader round-trip with no abort and no generation guard. Plan: 60s in-memory stream cache, `AbortController` + generation token, hover prefetch (max 2 in flight), keyed list items, scroll preserved per stream, `performance.mark` p50/p95. Targets: <50ms cached, <400ms cold over the tailnet. **Landed:** StreamCache (60s TTL, 20 streams, LRU-ish eviction), AbortController + token guard so a stale response can never paint, hover/focus prefetch capped at two in flight, cache kept in step after read/star/paginate, `lastStreamMs`/`lastStreamSource` exposed. Tests: 17 cache checks plus a reader-level check proving 3 switches cost 2 requests. **Fixed the stale-list bug:** an uncached switch used to keep the previous stream's articles on screen under the new title, which read as "the click did nothing". The list now clears immediately and shows skeleton rows; measured with a 1.5s throttle — title updates at once, 0 stale items, 6 skeleton rows, then 10 real ones. Honest gap: a cold stream fetch measures **4-5ms** on the local harness, so network is not the bottleneck there — the perceived slowness is render cost or the live instance over the tailnet, and neither is measured yet |
| 21 | Tri-pane desktop layout (feeds / articles / reader) | **done** | Three columns from 1200px (`300px minmax(320,400) minmax(0,1fr)`); picking a feed swaps only the middle column. 840-1199 two-pane, drawer below. Plan said 1100px — the breakpoint was already 1200 and was left alone |
| 22 | Sidebar control row: hidden view (left), lock (middle), favourite filter (right) | **done** | `SidebarBand.svelte`: eye left, lock centre, pin right, label under each icon; it is now the only place the hidden view changes; `d8b9b6c` |
| 23 | Row menu: hide/favourite and their reverses only | **done** | Menu actions are hide, pin, indent, remove-feed — no view entries (`contextmenu.ts`). Hidden still beats favourite |
| 24 | Favourites sort above everything else | **done** | `arrangeByPins()` now ranks favourite(0) → pinned(1) → rest(2), ties alphabetical, both for categories and for feeds inside a group. Favourites rank above pins on purpose: a favourite is a server fact the web sidebar also shows, a pin is local. Verified: `favorites.mjs` asserts the order |
| 25 | Manual pin for categories and feeds | **done** | Pins are local for categories *and* feeds (`setCategoryPinned()` writes local prefs only, no request). The row menu offers **Favourite/Unfavourite** (server, via Favorite Categories) *and* **Pin/Unpin** (local, bookmark glyph) as two separate items. 159 checks in `favorites.mjs`, incl. "a pin sends nothing to the server" and "being a favourite does not pin it" |
| 26 | Feed thumbnails from `iconUrl` | **done** | `src/lib/feedicon.ts` + rows; loopback icon URLs rewritten to the configured server, deterministic letter tile + hue as fallback, dead icons fall back instead of showing a broken image. 18 unit checks; measured in the app: both feeds render loaded icons; `0666681` |
| 27 | Collapsible tree, indent visible, Starred above it | todo | `--feed-indent` is plumbed but not visible on rows; check row markup against the extension's `.item-title` selector. Indent is confirmed **global, covering all feeds** — no per-feed setting exists or is wanted |
| 28 | Feed settings popup from the row menu | **partial** | Popup works and holds hide, pin, indent slider (0-64, applied live, menu stays open, choice remembered per device) and remove-feed with its confirmation. Still missing: title, feed/home URLs, item counts. Per-feed indent remains a new extension capability, not a UI change; `021adbe` |
| 29 | Visual parity pass against the screenshots | todo | Blocked until the reference images arrive |

Evidence carried into this batch: `iconUrl` is present on every subscription in the
GReader payload and its `/f.php` endpoint answers 200, so thumbnails need a host rewrite
rather than a new service. `SidebarIndent` stores one global `sidebar_indent_px` (12-60) —
there is no per-feed setting to expose. `Sidebar.svelte` is 485 lines and four phases touch
it, so it should be split before P3/P4.

### Reference screenshots integrated (2026-10-22 18:10)

Four screenshots of the sidebar to match. Read by OCR with word boxes plus pixel sampling: the vision
provider returns unparseable streaming chunks to the image tool, so geometry, labels and colours are
measured but icon shapes and type weights are inferences.

Measured: sidebar 295px; page `#262626`, sidebar `#171717`, band `#2f2f2f`, borders `#333`, muted `#999`,
accent `#0062b7`; band at y 78-106; rows every 43-46px; status strip at y 892/936/975.

| # | Item | State | Notes |
|---|---|---|---|
| 30 | Sidebar band in three states: expanded / locked / collapsed | **done** | All three measured. Locked compacts to glyphs and drops every hidden clue; collapsed leaves only a full-width caret bar (`2bada61`); `d8b9b6c` |
| 31 | Inline passcode area under the band | **done** | Inline panel: set a passcode, Lock now, unlock with passcode, "Wrong passcode." shown in place. Backed by real routes (`POST /v1/lock`, `POST /v1/unlock`, `PUT /v1/passcode`) proven on the harness (200/403); `dc72ae8` |
| 32 | Count-visibility rules for hidden | **done (count)** | Unlocked shows `Hidden 1` and it appears in the same tick as the hide (measured); locked shows no count and no hidden clues. Still open: an ENFORCED badge, and whether the number counts categories or feeds |
| 33 | Collapse/expand affordance | **done — redesigned** | Not the corner chevron the plan asked for: the caret is a full-width bar across the top of the band. Collapsed measures `281×20` inside a `283×22` box (controls gone); expanded `281×14` above the controls. Arrow points up to hide, down to restore, and the label/title say which; persisted per server+user; `2bada61` |
| 34 | Adopt the reference visual tokens | **todo** | Band treatment and muted labels are in place; the reference palette and right-aligned counts are not verified against the screenshots. Extension vocabulary is in use (`Hidden / Revealed / Only`, `Mixed / Favourites / Hidden favourites`) |

Two open questions carried in the plan §8: what `Hidden 1009` counts, and whether `Important feeds` is the
pinned band or an existing FreshRSS grouping.

### Decisions from the owner (2026-10-22 18:20)

| # | Item | State | Notes |
|---|---|---|---|
| 35 | Adapter v1.2: pin state and routes | **deferred** | Superseded by the 2026-10-22 20:00 review and dropped from the MVP: FavoriteCategories already writes `category.attributes.position`, so a second writer is the exact extension conflict this project has avoided. Manual pins stay app-local until ownership of that column is written down and tested. `tag/list` still carries ids only, so server pins would need the adapter — later, not now |

Answered: pins go server-side wherever the server can hold them and local otherwise, for both hidden and
favourite, and must not require either extension; indent is global across all feeds; favicons come from
FreshRSS's cache with a third-party fallback planned for future local RSS.

Priority order now on the board, 1-9: perf, band, thumbnails, tri-pane, pins (adapter v1.2 + local),
collapse, password toggle, feed settings, parity. Sidebar edits never run concurrently — the file gets split
into row components in whichever of tri-pane or band runs first.

### Fast sync with the site (2026-10-22 19:00) — design only, not started

Plan: `~/.hermes/plans/2026-10-22_1900-hardlyreader-sync-v1.md` (copy in the workspace).

Why: the app only reads state at login and after its own writes, so a change made on the website
is invisible until relaunch. Polling `/v1/state` to fix that is not viable — measured 6,173 bytes
with 1,000 hidden ids — so the plan adds a 32-byte revision token instead.

| # | Item | State | Notes |
|---|---|---|---|
| 36 | Adapter: `touch()` revision counters in both stores, `GET /v1/revision`, `If-None-Match` → 304 | todo | Blocked on VPS deploy approval + backup. Harness first |
| 37 | Client `SyncEngine`: 5 s focused / 20 s idle / 0 when hidden, immediate poll on focus, visibility and `online`, backoff 5→60 s, single in-flight | todo | Unit tests with an injected clock |
| 38 | Diff-apply and targeted feed refresh: Strict mode → refresh subscriptions; Light → only if the changed category holds the open stream | todo | Reuses the existing generation guard |
| 39 | Integration test with two clients: hide via curl, assert the app reflects it inside the target window | todo | Docker harness, separate port |
| 40 | Feed-list cadence decision (60 s while focused vs on demand) | todo | Question 3 in the plan; changes the cost profile |

Conflict rules recorded in the plan §3.3: server wins for hidden/favourite/lock/view/indent
(unless a local indent override exists); the device keeps band collapse, feed pins, open stream
and drafts. Rejected there too, with reasons: SSE, long-poll, WebSocket, full-state polling,
extension-side push, and SQLite mtime watching.

## P0 — reproducible repos and real CI (2026-10-22 20:00)

Plan: `~/.hermes/plans/2026-10-22_2000-hardlyread-mvp-repro-ci.md` (copy in the workspace).
This sits **above** sync: a fresh public clone must pass its own tests first.

Adopted from the owner's external review after re-checking each claim: CI run `39888463114` is real
(PHPUnit 8.2/8.3/8.4 success, integration failure in ~20 s), the public collaborator repos really are
missing the extracted methods, and `setCategoryPinned()` really does write through
`setCategoryFavorite()`. One correction to the review: favourites ordering is **not** implemented.

| # | Item | State | Notes |
|---|---|---|---|
| 41 | Publish HiddenCategories with `setCategoryHidden()`, `changeView()` | todo | Public repo predates commit `73cfde6`, so the adapter 409s against any fresh clone. **Needs explicit approval naming that repo before any push.** Should also carry `lock()`, `unlock()`, `setPasscode()` or the adapter's lock routes stay dead on a stock install |
| 42 | Publish FavoriteCategories with `setCategoryFavorite()`, public `changeView()` | todo | Same gate: explicit approval naming that repo |
| 43 | CI: checkout collaborator repos into `.deps/`, pass absolute paths to `run.sh` | todo | `HARDLYREAD_HIDDEN_CATEGORIES_DIR` plus a new `HARDLYREAD_FAVORITE_CATEGORIES_DIR`; fail with a clear message when a dep is missing instead of exit 1 |
| 44 | E2E: install FavoriteCategories, replace the absent-extension assertions with real ones | todo | favourite, unfavourite, favourites view cycle, idempotence, persistence, Hidden+Favourite coexistence. Keep one deliberate 409 configuration |
| 45 | Frontend CI job | **done** | `frontend` job in `.github/workflows/tests.yml`: pnpm 12 + Node 22, `install --frozen-lockfile`, `check`, `build`, `test`. `package.json` gained `test` → `tests/unit/run.mjs`, which spawns each suite in its own process and exits non-zero on any failure — piping to `tail` had been hiding real exit codes. Local: 8/8 suites, 442 checks, check 0/0, build clean |
| 46 | Pin ownership: decouple manual pins from favourites | **done** | `setCategoryPinned()` no longer calls `setCategoryFavorite()`; `pinSource` is gone. `pinView` still reads the extension's favourite *view* when present, because that is a filter over favourites, not pin storage. Four old tests that asserted "a pin writes the favourite on the server" were rewritten to assert the opposite |
| 47 | Login token storage + Tauri CSP | todo — **after MVP** | `src/api/session.ts` keeps the GoogleLogin token in `localStorage`; `tauri.conf.json` has `"csp": null`. Both are prerequisites for a public or mobile build, not for the daily-driver loop |

**MVP gate** (nothing new until all true): fresh public clone → CI green → log in → hide/favourite
respond instantly → FreshRSS web agrees → a web-side change shows in the app within 5 s.

**Do not rebuild:** tri-pane, `SidebarBand`, lock/passcode UI, collapsible categories, feed favicons,
indent control, local pins, stream cache/prefetch, password reveal, caret bar — all built (rows 19-33).
Extract `SyncEngine` as a new module; do not rewrite `ReaderState`.

## Layout, resizing, continuous reading, keyboard (2026-10-22 21:30)

Plan: `~/.hermes/plans/2026-10-22_2130-hardlyread-panes-and-keyboard-v1.md` (copy in the workspace).

| # | Item | State | Notes |
|---|---|---|---|
| 48 | Explicit pane mode 1 / 2 / 3, persisted, with effective-vs-desired clamping | **done** | `src/state/layout.svelte.ts` holds `desired`, `widths` and `chosen` in `localStorage` (`hardlyreader.layout.v1`). **iPhone: portrait opens in 1, landscape in 3**, and rotation keeps following the orientation *until* the user picks a mode themselves (`chosen`), after which rotation leaves it alone. All three stay available everywhere. Desktop floors 1000/700px; phone floors 660/440px with narrower minimums (150/210/240), because a landscape iPhone is 844px and the desktop floor would refuse three panes there |
| 49 | Resizable gutters between panes | **done** | `PaneGutter.svelte`: 1px line inside a 6px hit area, pointer capture, one `requestAnimationFrame` update per frame, absolute width during drag so it cannot drift, clamps on both neighbours' minimums, double-click resets, `role="separator"` with `aria-valuenow` and ←/→ (Shift = 64px) when focused |
| 50 | Three-pane as a real mode: article opens to the right, list never replaced | **done** | Mode 3 renders sidebar | gutter | list | gutter | article; selecting a post leaves the list in place. Two-column mode keeps today's behaviour (list and article share the second column) but is now chosen, not inferred from the window |
| 51 | One-pane traversal with breadcrumb | **done** | Mode 1 walks feeds → posts → article in one column with a `Feeds › Feed › Article` crumb; Left/`Esc` back out a level. The hamburger returns to the feed list |
| 52 | Continuous reading across feeds | **done** | ↑/↓ toolbar buttons and Space-at-end call `advanceArticle()`, which steps within the stream and calls `crossToNextStream()` at the end (opens the next feed, lands on its first post). **Scroll advance is progressive, not linear** (`src/lib/scroll-advance.ts`): wheel travel at the bottom accumulates into a pull whose contribution falls off as it fills (threshold 200, resistance 2.5 → 450px of travel, about four 100px notches), drawn as a filling 3px line at the bottom of the pane, released after 700ms idle or when you scroll back up. `advanceOnScroll` is persisted (`hardlyreader.reading.v1`) and toggled by the ⇣ button; off keeps the buttons and Space working. 18 checks in `scroll-advance.mjs` |
| 53 | Keyboard map as one pure resolver | **done** | `src/lib/keys.ts` (`resolveKey`, `resolveShiftKey`, `isTypingTarget`) + `Main.svelte` dispatching intents. ↑/↓ = previous/next **feed** in every mode, →/Enter = enter, ← = back out, Home/End, Esc (menu first), Space/Shift+Space page and advance at the ends. 36 checks incl. every key swallowed while typing or while the menu is open |
| 54 | Tests for the layout core | **done** | `panes.mjs` 36 (desktop + phone floors, clamping, re-clamp, drag, reset, nudge, grid template, orientation defaults), `keys.mjs` 36, `reading-order.mjs` 18. 11/11 suites / 532 checks, check 0 errors 0 warnings, build clean |

Acceptance for the whole set: switching 3→2→1 never reloads a stream or loses the open article; a
reload restores mode and widths; every key row works in all three modes; one throttled browser run
shows a feed handover under 1.5s of induced latency.

| # | Item | State | Notes |
|---|---|---|---|
| 55 | Band collapse remembered across relaunches | **done** | It was stored in the per-account prefs blob (`serverUrl|email`) and read in `start()`, which made a purely visual preference depend on the session being restored before the first frame. Moved to its own key, `hardlyreader.chrome.v1`, via `src/lib/chrome-prefs.ts` + `src/state/chrome.svelte.ts`, read at module load so the band cannot paint expanded and snap closed. `chrome.mjs` proves first run, relaunch, expand, corrupt JSON, non-boolean values, and storage that throws (12 checks). Category-group collapse stays in the account prefs — it is per account by nature — with its own roundtrip checks |

| # | Item | State | Notes |
|---|---|---|---|
| 56 | Hidden writes: no dropped clicks, no stale repaint, strict-mode catch-up | **done** | A hide writes seconds of work server-side on a large account (Strict mode rewrites every feed in the category). The old code refused any second intent while one was in flight and disabled the band control, so the click that brought categories back was silently discarded and the reply for the first click repainted the older state. Writes are now queued per target with a token each: every click paints immediately, the newest intent owns the screen, a stale reply is discarded, and only failures that are still current roll back. After the queue drains, Strict mode reloads the sidebar once (debounced, skipped if a newer intent arrived) because the server's subscription list stops reporting hidden feeds. Measured in the dev UI against the disposable harness: hide paints in 2 ms with a 13 ms write; with 1.5 s induced latency three clicks 120 ms apart all registered and the last one won, where the old code dropped two. `hidden-write.mjs` 63 checks incl. queued second hide and discarded stale view reply |

| # | Item | State | Notes |
|---|---|---|---|
| 57 | Visual language: sticker controls, red hidden, blue pinned | **done** | The band lost its box entirely — three die-cut outlines on the sidebar's own background, tone-coded (hidden red `#e5484d`, pins blue `#0078e0`, lock neutral), transparent until the control is *on*, then filled with a soft glow; hover thickens the outline, `:active` scales to 0.95 and deepens the fill so the click is answered on the frame the pointer goes down. Row titles follow the same two colours: a pinned category or feed takes the logo blue with a 1px blue outline, a blue underlight along the bottom edge and a soft outer glow, and a blue pin glyph replaces the 📌 emoji; a hidden category's title and chevron go red, visible in the revealed/only views where the point is to see what is hidden |
| 58 | Feed indent built in and server-synced | **done** | `Sidebar Feed Indent` gained `setIndent()`/`maxIndent()` (clamped, standalone behaviour unchanged) and the adapter gained `PUT /v1/indent`, so the app's slider and the extension's slider write one stored integer. The app draws on `input` and writes 250 ms later (one request per drag, not sixty), adopts the server's clamped value, keeps the server's cap as the slider's `max`, and honours the server's value over any stale local one. 0..60 now matches the extension exactly (was 64 — the old mismatch would have sent values the extension silently clamped). Against a server whose adapter predates the route the slider degrades to this device and says so in its tooltip instead of freezing. Verified in the UI: drag to 30 → feed padding 34+30=64 px live, `PUT /v1/indent` sent, old adapter 404 → local fallback with the explanation. Needs the adapter + extension deployed to take effect on the VPS |
| 59 | Harder scroll before switching posts | **done** | Threshold 200→280, resistance 2.5→3.2: nominal wheel travel to advance 450→728 px, about seven 100 px notches instead of four, with the same progressive falloff (full contribution at the top, 1/(1+3.2)≈24 % at the end) and the same 3 px progress line |

| # | Item | State | Notes |
|---|---|---|---|
| 60 | Global post filter on the article list | **done** | One control in the list header — Unread / All / Starred — that applies to every stream (reading list, starred, category, single feed), because "only unread" is a way of reading rather than a property of one feed. It filters what is already loaded, so switching is instant, the cached stream survives, and no second request is needed; the header shows `8 of 10` while filtered. `reader.listItems` is the single source for both the list and continuous reading/↑↓ traversal, so a filtered-out post is never stepped into. Persisted with the other reading prefs (`hardlyreader.reading.v1`), default `all` so a first launch cannot look like a feed that lost its posts. 14 new unit checks incl. reading-in-place dropping out of Unread |

| # | Item | State | Notes |
|---|---|---|---|
| 61 | Theme: accent, tones, dark/light, marker and wording | **done** | A swatch beside the pane switch opens a panel: appearance (Auto/Dark/Light), five colours, pin-or-star marker, and what to call a pin. The tones are the *meaning* the UI already encodes — hidden, favourite, lock open, lock locked — so they are set separately rather than derived from one hue, and the accent drives every ring, fill and glow through `color-mix()` rather than a second palette in JS. Light is `#fdfdfd` on `#1c1c1f`; Auto follows the OS live (`data-theme` is only stamped for an explicit choice). Device-local (`hardlyreader.theme.v1`) and applied before first paint, so a light-mode start never flashes dark. Choosing "Favourites" also relabels the server-synced favourite as "Favourite (synced)", so one word never means two things. 35 new unit checks |

| # | Item | State | Notes |
|---|---|---|---|
| 62 | Continuous reading both ways, wrapping, and read-after-dwell | **done** | The pull now runs in both directions from one signed accumulator: down at the end goes to the next post, up at the top to the previous, and reversing eats the pull already made rather than starting a second counter. Each article opens at the edge you arrived from, so scrolling up does not drop you at the top of the previous post. At the end of the walk it wraps: last post → first feed, first post → last feed, and folded categories are skipped because their feeds are not on screen. The walk is bounded by the number of streams, so "nothing left" is a definite answer, and it is only reachable in the unread view — every other view has something to wrap back to. Running out restores the feed you were in instead of leaving the last probed one open. Auto-mark-read is a preference, **off**, and marks a post only after three seconds as the open article, so a post flipped past stays unread and stays reachable; in the unread view a marked post leaves the list and the reader lands on the next one. 24 new checks + 11 new reader checks |

| # | Item | State | Notes |
|---|---|---|---|
| 63 | Dwell delay as a setting | **done** | The three seconds are a control in Options, 1–30 in whole seconds, default 3, stored with the other reading preferences. Changing it re-times the post already open rather than waiting for the next one, and the reader's ⏱ tooltip quotes the real number instead of a hardcoded "three". Bounds are clamped in one place so a stored 0 or a stored 999 cannot make auto-mark useless: under a second marks posts you only flipped past, over half a minute never fires before you move on. 10 new checks |

| # | Item | State | Notes |
|---|---|---|---|
| 64 | Scroll effort as a setting | **done** | How much wheel travel it takes to leave a post is a multiplier in Options, ×0.5 to ×2.0, default **×1.0** — the value tuned by hand, so nothing moves for the owner. It scales the pull threshold only, so the curve and the indicator behave identically at every setting and both directions scale together; the panel states the cost in wheel notches (7 at default, 15 at ×2) rather than in pixels. Measured in a mounted pane: one notch fills 0.357 of the pull at ×1.0 and 0.179 at ×2.0. 11 new checks |

| # | Item | State | Notes |
|---|---|---|---|
| 65 | Search field: one quiet field, filters as you type | **done** | The separate "Text" button beside the input is gone. Search was already live-on-keystroke; now the box says so: a single 30px field with a drawn magnifier inside, a clear × that exists only while there is text, and the deep-search switch reduced to a ¶ glyph that stays dim until it is on. Focus is a soft accent ring instead of a hard outline, and the browser's own grey clear blob is suppressed in favour of the drawn one. Empty-state copy updated to match (no more "Text" button to point at). Also gave the selected sidebar row a 2px accent rail so "where am I" reads at a glance. Verified in a mounted sidebar: no button beside the field, `ars` → 2 hits, `art` → the Art category's feed, clear × returns the tree. |

| # | Item | State | Notes |
|---|---|---|---|
| 66 | Header: sign out beside the account, room for sync | **done** | Sign out moved from the far right to sit with the username it signs out of (brand → account → Sign out), quiet until hovered. Sync is now a 34×34 rounded control with a 10px gap before it rather than a 28px glyph wedged against its neighbours, its border takes the accent on hover, and the glyph turns while a refresh is running (still, not spinning, under reduced motion). Measured in a mounted header: brand/username/Sign out at x=12/108/183, sync 34×34 at the far end with a 10px margin. |

| # | Item | State | Notes |
|---|---|---|---|
| 67 | Search above the band; shorter collapse bar | **done** | The search field is now the sidebar's first element, above the hidden/favourites band it filters, with the band's own control strip below it. The collapse handle shrank from 14px to 8px closed→open (20px → 12px when the band is folded), and its caret from 14px to 11px, since it is a handle rather than a row. Measured in a mounted sidebar: order `find → bandbox → indent → section`, bar 8px/12px, caret 11px, and typing `art` still filters to the right feeds. |

| # | Item | State | Notes |
|---|---|---|---|
| 68 | Options numbers are editable: any value, plus reset | **done** | The readout beside each slider is now a number you can tap and type into, and it takes values past the slider's range — the slider is for finding a feel, the number for saying what you want. Scroll effort: slider 0.5–2, typed 0.1–10. Mark read after: slider 1–30s, typed 1–600s. Out-of-range values pin the slider at its end while the number shows the truth. A `↺` beside each number returns it to the default (×1.0, 3s) and greys out when already there. Measured in a mounted Options panel: `4` → stored 4, slider 2, hint 29 notches; `90` → stored 90s, slider 30; `99`/`9999` → clamped 10 / 600; reset → 1 / 3 with storage back to defaults. |

| # | Item | State | Notes |
|---|---|---|---|
| 69 | One-column back/home pair, level-faithful | **done** | The old breadcrumb strip (a `←` that meant "previous feed" and disabled itself when there was no history, plus text crumbs that came and went) is replaced by two fixed controls at the top left: **back** and **home**, at x=8 and x=38 at every level, never swapping sides. Back steps exactly one pane — article → its posts → feeds — so you always see the screen you land on; home goes straight to the feed list in one press from any depth. The location is a single truncating label beside them (Feeds / feed / feed › post), not a clickable crumb trail, so nothing reflows under your finger. Swipe follows the same path: right = one level out, left = one level in (article → posts → feeds, and back). Targets are 26px with a pointer and 34px on coarse pointers. Walk verified in a mounted one-column `Main`: posts → article → posts → home from the article → feeds, buttons unmoved at x=8/38, and synthetic swipes traversed feeds → posts → article → posts → feeds. |

| # | Item | State | Notes |
|---|---|---|---|
| 70 | Category rows: whole-row fold, band-style caret | **done** | The category caret is the sidebar control strip's own caret — same path, same stroke, drawn as an SVG rather than a font glyph — a size up at 13px so it reads in a dense tree. It points up when the category is open (a click folds it) and down when folded (a click unfolds it), matching the strip's rule that the arrow describes the click. The whole row now folds: the old invisible 24px left-edge hit strip and the ▾ glyph are gone, so tapping anywhere on the category toggles it (`aria-expanded` on the row). Opening a category's posts moved to the count badge on the right, which is its own 34px target with a hover state and an "Open posts in …" tooltip — nothing was dropped to win the gesture. Verified in a mounted sidebar: row click flips `aria-expanded` and hides/shows its feeds, caret rotates 180°, the count still opens that category (active row moves) and folding keeps the open stream. |

| # | Item | State | Notes |
|---|---|---|---|
| 71 | A category's favourite *is* its pin | **done** | Corrected: these were never two facts. A marked category is one state — stored as the extension's favourite when Favorite Categories is installed (so the FreshRSS website agrees) and in this app's storage when it isn't; only the storage differs. `isCategoryPinned` now reads the favourite, marking writes `/v1/favorites/<id>` instead of a local list, and the ranking collapsed from three bands (favourite / pin / rest) to two (marked / rest). The row menu offers one item instead of two — 📌 Pin/Unpin, or ★ Favourite/Unfavourite under the Favourites vocabulary — with no "synced" second name anywhere; the `server` wording was deleted from the theme. Feeds keep their local pin, since the extension has no feed favourites. Verified against a stubbed server with the extension: Art marked drew the blue sticker and sorted first, its menu read `Hide` + `📌 Unpin` only, and unmarking sent `{"favorite":false}` and cleared the sticker. |

## 72. The seam is the activity light

The gap between the header and the panes — the 1px border and whatever padding sat under it — is now a permanent 3px slot. Idle it is the same hairline as before, with nothing animating (an invisible compositor loop is still work on a phone). When something is in flight it becomes the app's activity light, with no extra spinner corner.

Two behaviours, because there are two kinds of waiting. When there is no honest fraction (a stream fetch, a hidden/favourite/feed write, an item write) a soft accent sweep travels the strip and a blurred bloom spills ~55% opacity down over the top of the panes. When the work *is* a sync, the fraction is real — the header already counts its fetches — so the strip draws as a determinate fill in the sync tone instead (`--tone-sync`), sweep and bloom matching. No fabricated percentage anywhere.

That is also the merge with the sync readout built alongside it: the readout in the header keeps the numbers (`2/5 · 40%`) and its own 96px stub bar was deleted, because the same progress now draws full width in the seam. One progress, one place. Before the step count is known the readout names the step (`Feeds…`) rather than printing `0/0 · 0%`, and the description says "starting".

Verified with the real Header and LoadAura mounted against a stub reader: aura top 48px = header bottom, height 3px; 1/4 → 320/1280px, 3/4 → 960/1280px, 2/5 → 512/1280px fill in the sync tone with bloom 0.55; unknown total kept the sweep in the sync tone while the readout read `Feeds…`; non-sync work swept in the accent; idle returned to no fill, no sweep animation, bloom 0. Reduced motion drops the sweep and the fill transition. New `tests/unit/sync-progress.mjs` (12 checks) covers the readout, the clamp and the unknown-total wording; `pnpm check` 0/0, 20/20 suites. The live in-app look on the native window is still yours to judge — the HMR window has the real account.

| # | Item | State | Notes |
|---|---|---|---|
| 73 | Lock: unknown route on the live adapter | **fixed** | The app called `POST /v1/lock` and got `route_not_found: Unknown route.` Two causes, both server-side. (1) The deployed `lib/HardlyReadApi.php` was a 625-line build with no `lock`/`unlock`/`passcode` routes (the repo's 812-line build has them); only that one file differed. (2) Even with the routes, they called `$hidden->lock()` on the extension object, while Hidden Categories keeps `lock()`/`unlock()`/`setPasscode()` on its **store** — the PHPUnit fakes put them on the extension, which is how the mismatch stayed green in tests. The adapter now resolves via `curtain($hidden, $method)`: extension method if present, else the store's. Deployed with backups `HardlyReadApi.php.bak-hardlyread-20261023-071711` and `-072037`; the same deploy also switched on `PUT /v1/indent` and `PUT /v1/favorites/{id}`, which were unknown routes live too. Verified in the container against the real shape (`tests/lock-shapes.php`, 14/14: no-passcode 409, set 200, lock 200, wrong code 403, right code 200, letters 400, unknown route still 404) and on the deployed file, not just a staged copy. |

| # | Item | State | Notes |
|---|---|---|---|
| 74 | Header row: 48px → 42px | **done** | Trimmed the title bar without crowding the controls: height 42px (from 48), side padding 12 → 10px, gap 8 → 7px, Sign out's and sync's left margins 8/10 → 6/8px, Sign out padding 3/8 → 2/7px so it sits inside the shorter row. Sync keeps its 34px box with 4–5px of air above and below, which is the floor before it starts touching the border. Measured in a mounted header: 42px tall, 10px padding, 7px gap, sync 34px with 4px top / 5px bottom air, brand at x=10, seam at y=42, no overflow — and the sync readout appearing (`2/5 · 40%`) leaves the height at 42, so nothing shifts when a sync starts. |

| # | Item | State | Notes |
|---|---|---|---|
| 75 | Post thumbnails in the article list | **done** | Rows show a 48×48 picture when the feed gives one, and stay plain text when it does not — no placeholder boxes. `src/lib/thumb.ts` picks it in trust order: image enclosure → `media:thumbnail`/`media:content` (image types only) → first `<img>` in `content`, then `summary`. Trackers and spacer pixels are filtered by filename (1x1, pixel, beacon, spacer, blank, tracker, analytics), `srcset` beats `src` and takes the largest candidate, relative and protocol-relative sources resolve against the post's own link, `data:image/*` is allowed, `javascript:`/`file:` refused. Extraction is memoised per item object (WeakMap) so scroll re-renders do not re-parse HTML. Images are `loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"`, `alt=""` (decorative — the title is the content); one that fails to load is dropped rather than left as a broken box. `StreamItem` gained `enclosure` and `media`. 16 checks in `tests/unit/thumb.mjs`; mounted list verified: 48×48 at radius 6 with the row's 16px right margin, text-only rows keep a full-width body, and a 404ing image removes its own thumb. Picture bytes still come from the publisher each time — no owned image cache. |

| # | Item | State | Notes |
|---|---|---|---|
| 76 | Lock panel asked for a passcode the server already had | **fixed** | The app read `/v1/state` once at sign-in and never again, so a session that started while the deployed adapter was still the older build (no lock route, no passcode in its state) kept believing there was no passcode — and every lock attempt got `route_not_found: Unknown route.` The live server was fine: `/v1/state` returns `available: true, mode: strict, hasPasscode: true`, and `PUT /v1/passcode` accepts an invalid code with `400 invalid_passcode`, so routing, auth and the extension's own passcode all work. Fixes: opening the lock panel now re-reads hidden state, so whether a passcode exists and whether the curtain is down come from the server rather than from startup; a failed lock or unlock refreshes the same state (a server that rejects the route is a server whose extension is behind the app); and `route_not_found` is translated into "This server's Hardly Read extension has no lock route yet — update the extension on the server." instead of echoing the server's opaque "Unknown route." 66 checks in `hidden-write.mjs` (3 new for the message mapping), 21/21 suites, `svelte-check` 0/0. Mounted band verified: passcode present → "Lock now / Change passcode", no "set a passcode", and opening the panel issues exactly one state read. |

| # | Item | State | Notes |
|---|---|---|---|
| 77 | Day/night toggle moved off the Options swatch | **done** | The mode switch sat 4px from the Options swatch in the header, both 28px targets — a near-miss on the small swatch flipped the whole screen. It now lives at the right end of the sidebar's Indent strip as a 20×20 icon button (12px sun/moon SVG, muted, hover background, focus ring), while deliberate mode choice — Light/Dark/System — stays in the Options panel. Header keeps only the 28px swatch. Mounted check: 0 mode buttons and 1 swatch in the header, toggle inside the indent row at the row's right edge (x=287 of 320, 12px from the edge, 20×20, fits the 30px row), and clicking walks system → light → dark. The swatch's own CSS had been grouped with `.mode`, so it was restored to its original 28×28 bordered style rather than left inheriting nothing. `svelte-check` 0/0, 21/21 suites. |

| # | Item | State | Notes |
|---|---|---|---|
| 78 | Reading controls in the top bar | **done** | Three buttons on the bar — A−, A+, and Aa — plus a popout with Text size (same two commands, with a % readout), List size, Line spacing (Tight/Normal/Loose), Align (left/centre/right), Paragraph indent (on/off) and Reset. Text size steps 85–150% in 10% steps, list size 80–140%; both clamp at the ends and the buttons disable there. `src/lib/reading-layout.ts` holds the arithmetic (clamping, drift-free stepping, percentage labels, leading table, CSS-variable mapping) with 18 checks; `reading.svelte.ts` stores all five in the existing `hardlyreader.reading.v1` object. One decision: **layout is global and device-local, not per-post** — sizing per post would mean re-deciding on every open, and an A+ that means something different depending on what is open is worse than none. The variables are set once on the pane container in `Main.svelte`; the article reads `--read-scale`/`--read-leading`/`--read-indent`/`--read-align`, the list reads `--row-scale` for row padding, title, preview, byline and thumbnail together (scaling the picture alone makes a row look broken, not bigger). Measured: text 100% → 15px/24.75px leading, 110% → 16.5px/27.225px, Loose at 110% → 32.175px, Align Right → `text-align: right`, indent on → 19.8px first-line indent with list paragraphs still 0; thumbnail 48 → 58 → 38px with row height 83 → 118 → 67; Reset returns all five and disables itself. Header is 42px throughout, no overflow at 360/500/600/900px; at ≤520px the two quick buttons hide and the same commands are the panel's first row. 22/22 suites, `svelte-check` 0/0. |

| # | Item | State | Notes |
|---|---|---|---|
| 79 | Indent slider: collapsible and hairline-thin | **done** | The strip collapsed to a single row: `Indent 12 ⌄` — the value stays readable as text, the slider is a click away, and the day/night toggle keeps its place at the right. State is the second flag in `hardlyreader.chrome.v1` (`indentOpen`), written through a merge so opening the slider cannot drop `bandCollapsed` and vice versa (5 new checks in `chrome.mjs`, 19 total). When open, the slider is no longer the native 14px trough: `appearance:none` with a 2px `--border` track, 9px `--muted` thumb that turns `--accent` on hover/focus, reduced-motion-respecting caret. Verified by screenshot at 2×: the track measures 4 device pixels = 2 CSS px of `rgb(51,51,58)` on the row background, i.e. a hairline rather than the old trough. Collapsed shows no `<input>` at all, and the stored JSON after two clicks reads `{"bandCollapsed":false,"indentOpen":false}`, so both flags coexist. 22/22 suites, `svelte-check` 0/0. |

| 80 | Action feedback: a short flood of light | **done** | Hide/unhide, pin/unpin, lock/unlock and a finished sync now leave a 520ms glow at the point of the click: it rises ~46px while spreading from 0.42 to 1.55 scale and fades through a `screen`-blended radial gradient tinted by the action's own semantic tone (`--tone-hidden`, `--tone-favourite`, `--tone-lock-*`, `--tone-sync`). Origin is the menu's click point clamped into the viewport; a sync has no click so it arrives top right under its button. Three in the air at most, oldest dropped, each element removes itself on `animationend` — no timers and no layout property animated, only opacity and transform. `prefers-reduced-motion` suppresses emission in the store rather than shortening it. New `floods.ts` (pure), `floods.svelte.ts`, `FloodLayer.svelte`; the reader imports it, so the three generated reader fixtures now compile the store the way they compile theme (`.gen/floods.mjs`, 10 new checks in `floods.mjs`, 3 in `reader-state.mjs`). Mounted check: created at `(200,260)`, `animationName svelte-…-flood` 0.52s forwards, transform `scale(0.77) translateY(-6px)` → `scale(1.46) translateY(-41px)`, opacity 0.82 → 0.43, gone after the life, layer `fixed` + `pointer-events:none` + z 55; under emulated reduced motion 0 emitted. Also eased the row marker fill and row background transitions (120–160ms) so the colour change belongs to the same gesture. 23/23 suites, `svelte-check` 0/0, build clean. |

| # | Item | State | Notes |
|---|---|---|---|
| 82 | Indent removed from the right-click menu | **done** | The feed menu carried an Indent slider. It is a sidebar setting with its own strip (and that strip is now collapsible), and a slider inside a right-click menu is a drag away from changing every feed's indent by accident. Removed end to end: `IndentControl` and `MenuModel.indent` are gone from `contextmenu.ts`, `feedMenu()` no longer takes `indentPx`/`indentServerBacked`, the `{ type: "indent" }` action is out of `MenuAction` (so the `case "indent"` in `applyMenuAction` is gone too, no dead branch), and `CategoryMenu.svelte` lost the slider markup, its `onindent` prop and four orphaned selectors. `Main.svelte` no longer passes `onindent`. Guards added so it does not come back: `menu-render.mjs` renders the real menu and asserts no "Indent" and no `type="range"` (PASS), and `context-menu.mjs` asserts the model has no `indent` field. The sidebar strip still owns the setting. 0 errors/0 warnings, 23/23 suites. |

