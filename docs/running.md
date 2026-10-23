# Running HardlyReader

A Svelte 5 + TypeScript + Tauri 2 client for FreshRSS. Reads and writes go through
the GReader API and a thin `misc.php` adapter extension; nothing is cached yet and
nothing is stored locally beyond the session.

## Prerequisites

Everything builds inside an Arch distrobox on this machine (Bazzite is atomic, so
nothing is layered):

- rustc / cargo, WebKitGTK 4.1, GTK 3, Node 20+, pnpm
- Docker, for the disposable FreshRSS harness

## Development, against the disposable harness

```bash
# the harness (rebuilds nothing unless the compose file changed)
docker compose -f tests/integration/compose.yml up -d      # 127.0.0.1:18080

# the app
pnpm dev --port 1420
```

Open `http://127.0.0.1:1420` and connect with:

- **Server URL** `http://127.0.0.1:1420/freshrss` — the Vite proxy. Not
  `http://127.0.0.1:18080`: the adapter sends no CORS headers, so a direct
  cross-origin call is blocked by the browser before it reaches PHP.
- **Username** and **API password** from the harness user.

## Native window

```bash
pnpm tauri dev
```

In the native build the server URL is the real one, because Tauri's HTTP plugin is
not subject to CORS:

- `https://cenvalweb.tail900410.ts.net:8449/` over the tailnet, or
- `http://100.79.162.94:8081/` on the LAN/VPN

The window's capability allowlist already permits `http://*:*` and `https://*:*`.

## What the app does

| Feature | Where it lives |
|---|---|
| Sign in, session reuse | `src/api/freshrss.ts`, `src/api/session.ts` |
| Categories, subscriptions, articles, read/unread, star | `src/api/freshrss.ts` (GReader) |
| Add and remove feeds | `Sidebar.svelte` → `reader.addFeed` / `removeFeed` |
| Hidden categories: hide, show, and the Hidden/Revealed/Only view | adapter `/v1/hidden-categories`, `src/state/hidden*.ts`, category menu, header view control |
| Favourite categories: star, and the All/Favorites/No favorites view | adapter `/v1/favorites`, `src/state/favorites.ts`, category menu, header favourites control |
| Sidebar indent | adapter `/v1/state` → `sidebarIndent.px`, applied as `--feed-indent` |

The app never implements extension behaviour itself. It asks the adapter, the
adapter calls the extension's own public methods, and the extension writes its own
state. `Hidden Categories`, `Favorite Categories` and `Sidebar Feed Indent` remain
the source of truth for their features, and their web UI keeps working alongside
the app.

## Tests

```bash
pnpm check                                        # svelte-check: 0 errors, 0 warnings
node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/<file>.mjs
docker run --rm -v "$PWD":/app -w /app php:8.4-cli php vendor/bin/phpunit -c extensions/xExtension-HardlyRead/phpunit.xml
bash tests/integration/run.sh                     # full E2E: own container on 18081, logs in artifacts/ on failure
```

Current numbers on `master`: 377 unit checks across 6 files, 96 PHPUnit tests /
311 assertions (PHP 8.2, 8.3 and 8.4), 52 E2E checks, 26 live GReader smoke checks,
svelte-check clean.

`run.sh` never touches the development harness: it uses project `hardlyread-e2e` on
port 18081 and removes its own volume and network on success.

## Live installation

See `docs/live-deployment.md` for what is deployed, every backup taken, the revert
commands, and the traps (opcache delay, `metadata.json` name as the routing key,
CORS in the browser build).

## Known gaps

- **No caching or offline mode.** Every view is a live request; the app is useless
  without a reachable server. Deliberate — the UI came first.
- **No authenticated call has been made against the live instance.** The adapter
  and all four extensions are installed and load, and the route refuses anonymous
  callers, but the first real sign-in is the owner's to do.
- **The native window has never been visually verified.** It compiles and links;
  every UI check so far ran in a browser.
- **CI has never run on a runner.** The workflow parses and the E2E passes locally.
  The integration job needs a Hidden Categories checkout, and the published copy
  predates the refactor the adapter requires — see the blocked card on the board.
- **No iOS or Android build.** `src-tauri` is portable, but neither target has been
  initialised.
- **Nothing is published.** The public-release gate is in `BACKLOG.md`, row 14.
