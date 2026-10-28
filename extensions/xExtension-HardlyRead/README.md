# Hardly Read (FreshRSS extension)

A small API bridge between [HardlyReader](https://github.com/hardlysleeping/HardlyReader) clients and the FreshRSS extensions that own the sidebar state.

HardlyReader's sidebar controls — hide a category, pin a category, lock the hidden ones, drag an order — are not part of the GReader API. This extension exposes them over a JSON API that sits alongside it, so a desktop or phone client can use the same state the website writes, without a second copy of it anywhere.

It owns no state of its own, with two exceptions (the dragged order and the remembered settings — see below). It authenticates the caller with the same credential the GReader API accepts, then forwards intent to the extension that owns that state:

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
| GET | `/v1/preferences` | the reader's remembered settings, one stamped document per account |
| PUT | `/v1/preferences` | store that document; last write wins by stamp, a stale write is `409` with the winning document |
| PUT | `/v1/hidden-categories/{id}` | hide or reveal one category |
| PUT | `/v1/hidden-categories/view` | the sidebar view (`/v1/view` is an accepted alias) |
| PUT | `/v1/favorites/{id}` | pin or unpin a category |
| PUT | `/v1/favorites/view` | the pinned view |
| PUT | `/v1/pins/category/{id}` | where a pinned category sits — the category's own `position` |
| PUT | `/v1/indent` | the sidebar indent setting |
| POST | `/v1/lock`, `/v1/unlock` | the hidden-categories lock |
| PUT | `/v1/passcode` | the lock's passcode |

Errors carry a status and a stable code, and the codes are mapped from what the owning extension actually reported rather than invented here, so `store_unusable`, `save_failed` and `convergence_failed` mean what they say.

`/v1/positions` is one of two routes where this extension keeps state instead of forwarding: FreshRSS stores no folder position, so there is nothing to hand it to. It is a per-user `positions.json` under `data/users/<login>/extensions/HardlyRead/`, a file rather than the user config because a finishing refresh rewrites that config from its in-memory copy and would silently drop a write made by another request.

`/v1/preferences` is the second: a `preferences.json` beside it, holding the client's namespaces (`reading`, `cards`, `theme`, `search`) as `{ updatedAt, value }` entries. The extension does not interpret a namespace's fields — a newer client may add one, and this server keeps it intact — and it never stores anything from the session. A read-only or older install answers `404`/`503`, which a client reads as "keep it on this device".

The optional `/v1/people` routes exist only on an install that also carries the people provider; everywhere else they are plain unknown routes, because an empty list would read as "no such person" — a different truth from "this install cannot do that".

### Pairing a phone

An account whose login asks for a captcha cannot sign a phone in: the phone's HTTP client will never answer that captcha, and nothing here tries to. Instead the code moves the human check to a device that can show the page:

| Method | Route | Who may call it |
|---|---|---|
| POST | `/v1/pair/request` | **signed out** — body `{label}`; answers `{code, expiresAt, label}` |
| GET | `/v1/pair/pending` | signed in — the codes waiting for this account to approve |
| POST | `/v1/pair/approve` | signed in — body `{code}`; binds the code to this account |
| POST | `/v1/pair/redeem` | **signed out** — body `{code, label}`; answers `{token, account, label, expiresAt}` |
| POST | `/v1/pair/revoke` | either side — `{token}`, or nothing for the caller's own |

`request` and `redeem` are the only two routes reachable without a `GoogleLogin` credential, and they are named one by one in `HardlyReadApi::isSignedOutRoute()` so that adding a route cannot quietly widen that set. Everything else — including `pending`, `approve`, and any pairing route that does not exist — is `401` first, so an unauthenticated caller still cannot enumerate the router.

The approve press *is* the human check: whoever presses it is already past the captcha on a device that rendered it. A code is eight digits, single use, five minutes, and worthless until approved; it belongs to no account until then, which is why the store is server-wide (`lib/HardlyReadPairingStore.php`, under `DATA_PATH/extensions/HardlyRead/pairing/`) rather than a per-user file. Codes are stored as displayed — they are not a secret kept from the server — while device tokens are stored only as SHA-256, so the file cannot be turned back into credentials. Authenticating a paired device is a lookup of that hash plus a revoked flag, so revoking takes effect on the next request rather than whenever a token would have expired.

What the server must still do, and this extension cannot: **GReader has to accept a device token too.** The extension's own authenticator accepts `hrd_…` tokens (see `HardlyReadExtension::authenticateGoogleLogin`), so a paired phone can use `/v1/*`; but feeds are read through `/api/greader.php`, which only knows `user/sha1(apiPasswordHash)`. Until a device token is also installed as a per-device API password for the account, a paired phone signs in and its feed requests are `401`. That is a server-side piece: a core patch, or a proxy in front of GReader that swaps a device token for the account's credential. Likewise rate limiting on `/pair/redeem` belongs at the web server — eight digits is only 10^8, and the extension cannot see the client address through most proxies.


## Layout

| File | What it is |
|---|---|
| `extension.php` | the transport: superglobals, headers, output, and the collaborators the router needs |
| `lib/HardlyReadApi.php` | routing, validation, status mapping — no FreshRSS dependency, so it is testable on its own |
| `lib/HardlyReadPins.php` | pin order, read from the categories' own `position` |
| `lib/HardlyReadPositionStore.php` | the per-user `positions.json` |
| `lib/HardlyReadPreferenceStore.php` | the per-user `preferences.json` |
| `lib/HardlyReadPeople.php` | the optional people provider |
| `lib/HardlyReadPairingStore.php` | pairing tickets and paired-device credentials, server-wide |

## Tests

The router is pure and its suite is included, but it needs a FreshRSS checkout to run — this repository is one directory of an install, not the install:

```sh
vendor/bin/phpunit -c extensions/xExtension-HardlyRead/phpunit.xml
```

The fakes under `tests/Fakes/` stand in for the state-owning extensions, so the suite runs without them installed.

The pairing store and routes have a plain-PHP check next to the others, which needs no database and no FreshRSS boot:

```sh
php extensions/xExtension-HardlyRead/tests/pairing.php
```

It walks a ticket through issue → approve → redeem → revoke with an injected clock, and asserts the two things that are easiest to get wrong: that a code signs one device in once, and that the device token is only ever written as a hash.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE), the same licence as HardlyReader: free for noncommercial use, commercial use needs written permission.

This extension is built for FreshRSS, which is GPL-3.0; it is distributed separately from it.
The extension itself, like the app, is **PolyForm Noncommercial 1.0.0** — see the
repository's `LICENSE`. It is installed into a FreshRSS instance the reader runs; it is
not a redistribution of FreshRSS.
