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
| 12 | PHP CI matrix + combined summary | wip | `.github/workflows/tests.yml`, three jobs, matrix 8.2/8.3/8.4 per §6.6; parses as YAML and the scripts pass `bash -n`. **Never executed on a GitHub runner** — `actionlint` is still not installed; `c77f09c` |
| 13 | Docker E2E against real FreshRSS container | todo | Upload FreshRSS logs on failure |

## P2 — Release

| # | Task | Status | Notes |
|---|---|---|---|
| 14 | Publish to public GitHub — **only after the MVP is done** | todo | `github.com/hardlysleeping/hardlyreader`; no personal data in files *or* history; plan §8.1 |

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
`http://127.0.0.1:18080` with user `itest` / API password `itest-api-password`.

```bash
docker compose -f tests/integration/compose.yml up -d
docker compose -f tests/integration/compose.yml down -v
```

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
| 16 | Adapter v1.1: favourites + sidebar-indent state and routes | done | `b404f3f`, status mapping `3a90a5a`, merge `1192140`. PHPUnit 96 tests / 311 assertions |
| 17 | App v1.1: star, favourites view cycle, indent, add/remove feed | done | branch `b6ae3b9`, merge `a354b46`. svelte-check 0/0, build clean, 377 unit checks across 6 files |
| 18 | Verify v1.1 against a real container | done (API) | `GET /v1/state` returns `favorites{available,view,ids,categories}` and `sidebarIndent{available,px:24}`; favourite on/off round-trips with `changed:false` on repeat; `PUT /v1/favorites/view` cycles all/only/without; 400 for id 0, bad view and non-boolean, 404 for an unknown category. Hidden categories still correct in the same state payload |

Measured, not assumed: 377 unit checks, 96 PHPUnit tests, clean Svelte check and Vite build on merged
master. Not measured: the v1.1 UI in a browser, and any v1.1 path on the live instance.
