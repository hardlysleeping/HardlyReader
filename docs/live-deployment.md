# Live deployment: HardlyReader adapter and the extensions it wears

What is installed on the FreshRSS instance behind your FreshRSS host, what was backed up
immediately before each change, and how to undo each one. Commands are written to
run from the workstation; the container is `freshrss` and the web root inside it
is `/var/www/FreshRSS`.

No credentials, hostnames beyond the tailnet address, or feed data belong in this
file.

## Deployed state

| Piece | Path in container | Source of truth |
|---|---|---|
| Adapter (system extension, registry name `Hardly Read`) | `extensions/xExtension-HardlyRead/` | this repo, `extensions/xExtension-HardlyRead/` |
| Hidden Categories | `extensions/xExtension-HiddenCategories/` | VPS is authoritative; local mirror in `~/apps/freshrss/extensions-src/` |
| Favorite Categories | `extensions/xExtension-FavoriteCategories/` | VPS is authoritative; local mirror in `~/apps/freshrss/extensions-src/` |
| Sidebar Feed Indent | `extensions/xExtension-SidebarIndent/` | VPS is authoritative, unchanged |

The adapter is a system extension and is switched on in the system config:

```php
// /var/www/FreshRSS/data/config.php
'extensions_enabled' => array( /* ... */ 'Hardly Read' => true, ),
```

The other three are user extensions, switched on per user in
`data/users/<user>/config.php` under `extensions_enabled`:

- `Hidden Categories`
- `Favorite Categories`
- `Sidebar Feed Indent`

The route is keyed by the registry `name` field in each `metadata.json`, not by
the folder name:

```
/api/misc.php/Hardly%20Read/v1/state
```

## Backups taken before each change

| Change | Backup | Size / hash |
|---|---|---|
| Adapter installed and enabled | `data/config.php.bak-hardlyread-20261022-165143` | prior config, seven extensions enabled |
| Hidden Categories refactor | `extensions/xExtension-HiddenCategories/.bak-hardlyread-20261022-164719.php` | 40,732 bytes, md5 `1c917171411772cde727420186758f9b` |
| Favorite Categories refactor | `extensions/xExtension-FavoriteCategories/.bak-hardlyread-v11-20261022-173752.php` | 22,867 bytes, md5 `bf656ec7b0254f29f9c75bcc24346cc2` |
| Adapter v1.1 | `extensions/.bak-hardlyread-adapter-v10-20261022-173752.tgz` | the whole v1.0 adapter directory |
| Config before v1.1 | `data/config.php.bak-hardlyread-v11-20261022-173752` | unchanged by the v1.1 deploy |

## Deployed hashes (v1.1, 2026-10-22 17:38)

| File | md5 |
|---|---|
| `extensions/xExtension-FavoriteCategories/extension.php` | `1a310e2f40f0f7d20c8b5fa225c33458` |
| `extensions/xExtension-HardlyRead/extension.php` | `06b64c8a39bedc7d8b52a636817dc48e` |
| `extensions/xExtension-HardlyRead/lib/HardlyReadApi.php` | `5d697360d499b2f6d2f6c75e513e009f` |

The adapter hashes match this repo. The Favorite Categories hash matches the local
mirror; its `metadata.json` still carries the deployed `author` value, which was
deliberately not overwritten.

## Revert: Favorite Categories only

```bash
ssh your-user@your-server 'docker exec freshrss cp -p \
  /var/www/FreshRSS/extensions/xExtension-FavoriteCategories/.bak-hardlyread-v11-20261022-173752.php \
  /var/www/FreshRSS/extensions/xExtension-FavoriteCategories/extension.php'
```

The favourites routes then answer `409 favorites_unavailable` (the adapter checks
for the methods before calling them); hidden categories are unaffected.

## Revert: adapter to v1.0

```bash
ssh your-user@your-server 'docker exec freshrss tar -xzf \
  /var/www/FreshRSS/extensions/.bak-hardlyread-adapter-v10-20261022-173752.tgz \
  -C /var/www/FreshRSS/extensions && docker exec freshrss chown -R www-data:www-data \
  /var/www/FreshRSS/extensions/xExtension-HardlyRead'
```

## Remove the adapter entirely

```bash
ssh your-user@your-server 'docker exec freshrss cp -p \
  /var/www/FreshRSS/data/config.php.bak-hardlyread-v11-20261022-173752 \
  /var/www/FreshRSS/data/config.php && docker exec freshrss rm -rf \
  /var/www/FreshRSS/extensions/xExtension-HardlyRead'
```

Note that the config restore removes `'Hardly Read' => true` and restores the
seven extensions that were enabled before it. The app then shows every extension
feature as unavailable rather than failing: `GET /v1/state` 404s, the client
reports `available: false` for all three blocks and the sidebar keeps working from
the GReader API alone.

## Verifying after any change

Unauthenticated, the route must answer **401** (proving it is routed and refusing
anonymous callers) — a **404** means the extension is not enabled for that
registry name:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://your-server:8081/api/misc.php/Hardly%20Read/v1/state'
```

The web UI must still render:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://your-server:8081/i/
```

Both extensions must report the public methods the adapter calls. Run inside the
container:

```php
require '/var/www/FreshRSS/cli/_cli.php';
$ext = Minz_ExtensionManager::findExtension('Favorite Categories');
var_dump((new ReflectionMethod($ext, 'setCategoryFavorite'))->isPublic()); // true
```

## Things that bite

- **Opcache holds the old file.** A changed extension can keep serving the old
  class for several seconds. Wait ~6–8 seconds before concluding a `409` is real.
- **`metadata.json` `name` is the key** for both the route and `extensions_enabled`.
  Renaming the folder changes nothing; renaming `name` breaks the route, the
  enablement entry, and the app in one step.
- **The browser build is subject to CORS.** The adapter sends no CORS headers, so a
  web build pointed at a different origin fails before reaching it. Use the Vite
  `/freshrss` proxy in development, or serve the app from the same origin. The
  native build is unaffected.
- **Never test with the account's real state.** Hidden categories and favourites
  write real feed priorities and real user config. Use the disposable harness
  (`tests/integration/`, or the dev container on port 18080).
