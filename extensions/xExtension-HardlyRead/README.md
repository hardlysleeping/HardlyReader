# Hardly Read (FreshRSS extension)

A small API bridge between [HardlyReader](https://github.com/hardlysleeping/HardlyReader) clients and the FreshRSS extensions that own the sidebar state.

HardlyReader's sidebar controls — hide a category, pin a category, lock the hidden ones, drag an order — are not part of the GReader API. This extension exposes them over a JSON API that sits alongside it, so a desktop or phone client can use the same state the website writes, without a second copy of it anywhere.

It owns no state of its own, with one exception (the dragged order, see below). It authenticates the caller with the same credential the GReader API accepts, then forwards intent to the extension that owns that state:

| Owning extension | What is forwarded |
|---|---|
| [Hidden Categories](https://github.com/hardlysleeping/xExtension-HiddenCategories) | hide / reveal a category, the sidebar view, lock, unlock, passcode |
| [Pinned Categories](https://github.com/hardlysleeping/xExtension-FavoriteCategories) | which categories are pinned, and their order |
| [Sidebar Feed Indent](https://github.com/hardlysleeping/xExtension-SidebarIndent) | the indent setting, read and written (read-only if it is absent) |

It never writes `feed.priority`, never opens another extension's database, and never reimplements another extension's rules: the client asks for a result, the owning extension decides how to reach it. Each of those extensions is optional; requests that need a missing one come back as a clear status rather than a crash.

## Install

1. Copy this directory to your FreshRSS `extensions/` folder, so that `extensions/xExtension-HardlyRead/metadata.json` exists.
2. Enable it. It is a **system** extension: in the web UI (Administration → Extensions) or by adding its registry name to `data/config.php`:

   ```php
   'extensions_enabled' => array( /* ... */ 'Hardly Read' => true, ),
   ```

   The key is the `name` field in `metadata.json` — `Hardly Read` — not the folder name and not the entrypoint.
3. Enable the state-owning extensions you already use (Hidden Categories, Pinned Categories, Sidebar Feed Indent). They stay user extensions, enabled per user.

Nothing is served until the extension is enabled: a request to the route below on an install without it returns a 404.

## API

Base path — note the space, which is why it is URL-encoded:

```
/api/misc.php/Hardly%20Read/v1/...
```

Every request needs the same `Authorization: GoogleLogin auth=...` credential the GReader API takes. No credential, or a bad one, is `401 unauthorized` with `Google-Bad-Token: true`, so a client can tell a rejected credential from a bad route.

| Method | Route | Purpose |
|---|---|---|
| GET | `/v1/revision` | one short token over the user's state; poll this, not the whole state |
| GET | `/v1/state` | hidden categories, favourites, pins and their order, sidebar indent |
| GET | `/v1/positions` | the arrangement the user dragged, as stored for this user |
| PUT | `/v1/positions` | store that arrangement; last write wins by the client's `updatedAt`, a stale write is `409` |
| PUT | `/v1/hidden-categories/{id}` | hide or reveal one category |
| PUT | `/v1/hidden-categories/view` | the sidebar view (`/v1/view` is an accepted alias) |
| PUT | `/v1/favorites/{id}` | pin or unpin a category |
| PUT | `/v1/favorites/view` | the pinned view |
| PUT | `/v1/pins/category/{id}` | where a pinned category sits — the category's own `position` |
| PUT | `/v1/indent` | the sidebar indent setting |
| POST | `/v1/lock`, `/v1/unlock` | the hidden-categories lock |
| PUT | `/v1/passcode` | the lock's passcode |

Errors carry a status and a stable code, and the codes are mapped from what the owning extension actually reported rather than invented here, so `store_unusable`, `save_failed` and `convergence_failed` mean what they say.

`/v1/positions` is the one route where this extension keeps state instead of forwarding: FreshRSS stores no folder position, so there is nothing to hand it to. It is a per-user `positions.json` under `data/users/<login>/extensions/HardlyRead/`, a file rather than the user config because a finishing refresh rewrites that config from its in-memory copy and would silently drop a write made by another request.

The optional `/v1/people` routes exist only on an install that also carries the people provider; everywhere else they are plain unknown routes, because an empty list would read as "no such person" — a different truth from "this install cannot do that".

## Layout

| File | What it is |
|---|---|
| `extension.php` | the transport: superglobals, headers, output, and the collaborators the router needs |
| `lib/HardlyReadApi.php` | routing, validation, status mapping — no FreshRSS dependency, so it is testable on its own |
| `lib/HardlyReadPins.php` | pin order, read from the categories' own `position` |
| `lib/HardlyReadPositionStore.php` | the per-user `positions.json` |
| `lib/HardlyReadPeople.php` | the optional people provider |

## Tests

The router is pure and its suite is included, but it needs a FreshRSS checkout to run — this repository is one directory of an install, not the install:

```sh
vendor/bin/phpunit -c extensions/xExtension-HardlyRead/phpunit.xml
```

The fakes under `tests/Fakes/` stand in for the state-owning extensions, so the suite runs without them installed.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE), the same licence as HardlyReader: free for noncommercial use, commercial use needs written permission.

This extension is built for FreshRSS, which is GPL-3.0; it is distributed separately from it.
