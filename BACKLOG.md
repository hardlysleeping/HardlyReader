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
| 3 | Reader data: categories, subscriptions, articles, read/unread, star | next | JSON endpoints require `?output=json` or they 501 |
| 4 | Basic UI: sidebar, article list, reader, responsive | todo | |

## P0 — HiddenCategories bridge

| # | Commit | Status | Notes |
|---|---|---|---|
| 5 | `setCategoryHidden(int, bool)` + `changeView(string)` only | todo | Reuse existing logic; no sweep/Strict internals exposed |
| 6 | `xExtension-HardlyRead`: ApiMisc, 3 routes, GoogleLogin auth | todo | 401 / 404 / 409 / 423 |

## P1 — App integration

| # | Commit | Status | Notes |
|---|---|---|---|
| 7 | Read `/v1/state`, map categories to numeric IDs, apply hidden state | todo | |
| 8 | Hide/unhide UI: right-click desktop, long-press mobile | todo | |
| 9 | Optimistic sync: server state + pending mutations = UI state | todo | No toggle API; always send explicit state |
| 10 | Hidden view modes: hidden / revealed / only | todo | HiddenCategories owns Strict/Light behaviour |

## P1 — Tests

| # | Commit | Status | Notes |
|---|---|---|---|
| 11 | PHPUnit: GET state, PUT category, PUT view; 200/401/404/409/423 | todo | |
| 12 | PHP CI matrix + combined summary | todo | Version range decision recorded in plan §6.6 |
| 13 | Docker E2E against real FreshRSS container | todo | Upload FreshRSS logs on failure |

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

Never point this at the live instance; the harness is disposable by design.
