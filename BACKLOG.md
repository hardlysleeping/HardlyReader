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
| 3 | Reader data: categories, subscriptions, articles, read/unread, star | done | `withQuery()` applies `output=json` centrally; `editTag` fetches a write token per call; 19/19 smoke checks |
| 4 | Basic UI: sidebar, article list, reader, responsive | done | Three-pane ≥1200, two-pane 840–1199, drawer ≤839; DOMPurify strips scripts/handlers/iframes from real feed HTML; `6845887` |

## P0 — HiddenCategories bridge

| # | Commit | Status | Notes |
|---|---|---|---|
| 5 | `setCategoryHidden(int, bool)` + `changeView(string)` only | todo | Reuse existing logic; no sweep/Strict internals exposed |
| 6 | `xExtension-HardlyRead`: ApiMisc, 3 routes, GoogleLogin auth | todo | 401 / 404 / 409 / 423 |

## P1 — App integration

| # | Commit | Status | Notes |
|---|---|---|---|
| 7 | Read `/v1/state`, map categories to numeric IDs, apply hidden state | todo | `src/api/hardlyread.ts` + sidebar filtering landed; 74 unit checks. Integration against a running extension still unverified |
| 8 | Hide/unhide UI: right-click desktop, long-press mobile | wip | `src/components/CategoryMenu.svelte` + `src/lib/contextmenu.ts`; also Shift+F10 / context-menu key. 140 unit checks in three new files. Visual check pending — no GUI was launched |
| 9 | Optimistic sync: server state + pending mutations = UI state | wip | `src/state/hidden-write.ts`: optimistic commit, then server state; 409/423 reconcile with the returned state, stateless failures roll back with a banner. One write at a time per app |
| 10 | Hidden view modes: hidden / revealed / only | wip | The menu's View group writes `/hidden-categories/view`; HiddenCategories owns Strict/Light behaviour |

## P1 — Tests

| # | Commit | Status | Notes |
|---|---|---|---|
| 11 | PHPUnit: GET state, PUT category, PUT view; 200/401/404/409/423 | todo | |
| 12 | PHP CI matrix + combined summary | todo | Version range decision recorded in plan §6.6 |
| 13 | Docker E2E against real FreshRSS container | todo | Upload FreshRSS logs on failure |

## P2 — Release

| # | Task | Status | Notes |
|---|---|---|---|
| 14 | Publish to public GitHub — **only after the MVP is done** | todo | `github.com/hardlysleeping/hardlyreader`; no personal data in files *or* history; plan §8.1 |

Gate: the "Done when" section below must actually pass first. Full history is scanned before the first
push — a force-push does not purge old commits, and this account cannot delete repos.

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

It round-trips read and star on one item and restores it, so repeated runs stay stable.

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
