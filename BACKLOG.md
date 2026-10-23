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
| 14 | Publish to public GitHub | **done (early, at owner's request)** | `github.com/hardlysleeping/hardlyread`, public, default branch `main`, 100 files. History is a **single squashed root commit** because the older commits carried a tailnet IP, hostname and the harness password and a force-push would not have removed them. Scrubbed before pushing: `100.79.162.94` → `your-server`, `cenvalweb.tail900410.ts.net` → `your-freshrss-host.example.ts.net`, `itest-api-password` → `hardlyread-test-password` (consistently, so the harness still runs). Verified by cloning the public repo back and grepping: clean. Local `master` keeps full history; `origin` points at the public repo |

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
