# Hosting the PWA

The same `dist/` can be served two ways. Both give an installable app; they differ
in who is talking to whom when the app calls the API.

## 0. The API proxy: why the page and the API must share an origin

`scripts/serve-pwa.py` forwards anything under `/api/` to the FreshRSS host
(`HARDLYREAD_UPSTREAM`, default `https://cenvalweb.tail900410.ts.net:8449`).
That exists because of a measured difference between the two APIs the app uses:

| request from the PWA's origin | before | with the proxy |
|---|---|---|
| `/api/greader.php/accounts/ClientLogin` | readable (the API sends `access-control-allow-origin: *`) | readable |
| `/api/misc.php/Hardly%20Read/v1/state` | `TypeError: Failed to fetch` — CORS refusal | `401` (auth required), readable |

The adapter's routes send no CORS headers, so cross-origin the app could never
read the extension state — which is where the passcode count, the hidden
categories and the pins live. The visible symptom was the lock claiming it had
not been told whether a passcode was set, on an account that had one.

With the proxy in place, **sign in with this app's own address as the server
URL** (for example `https://<host>.<tailnet>.ts.net:8457`), not the FreshRSS
host. `/api/greader.php` answers through the proxy exactly as it does there, and
because the page and the API are one origin the browser has nothing to check.
An account already saved against the FreshRSS host will keep hitting the CORS
wall until its server URL is changed.

The alternative is the same-origin deployment below, which removes the question
for the same reason: one origin, no CORS.

## 1. From this workstation, over the tailnet (default)

```
pnpm build
python3 scripts/serve-pwa.py --port 4179        # loopback only
tailscale serve --bg --https=8457 http://127.0.0.1:4179
```

The phone opens `https://<host>.<tailnet>.ts.net:8457/` and uses Share → Add to
Home Screen. Plain `http://` will not install: iOS requires a secure context for
a service worker, so the tailnet's TLS is what makes this work.

`scripts/serve-pwa.py` exists because a PWA needs three things a plain file
server gets wrong:

- `.webmanifest` served as `application/manifest+json`, otherwise Safari ignores
  the manifest and the Home Screen entry is a bookmark;
- `sw.js` and `index.html` sent `no-cache`, otherwise a release can be pinned
  behind an old service worker for as long as its cache lives;
- unknown paths fall back to `index.html` instead of 404, so a deep link lands
  in the app rather than on an error page.

Hashed files under `/assets/` are the only ones sent with a long immutable
cache, because their names change with their contents.

### Running it without a terminal

`~/.config/systemd/user/hardlyreader-pwa.service`:

```ini
[Unit]
Description=HardlyReader PWA (static dist, loopback only; the tailnet address comes from tailscale serve)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/apps/hardlyread
ExecStart=/usr/bin/python3 %h/apps/hardlyread/scripts/serve-pwa.py --port 4179
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```
systemctl --user enable --now hardlyreader-pwa.service
```

The unit serves files; it does not rebuild them. After a `git pull`, run
`pnpm build` and the service picks the new `dist/` up on the next request,
because nothing is held in memory except the file paths.

## 2. On the FreshRSS host, same-origin

Copy `dist/` into the FreshRSS web root as a subdirectory (`pwa/`) and open it at
`https://<freshrss-host>/pwa/`. Two consequences, both good:

- **There is no CORS question.** The app's calls to `/api/greader.php` and
  `/api/misc.php/Hardly%20Read/v1/*` become same-origin requests, so the
  adapter's extension routes do not need to learn how to answer a preflight.
- **One certificate, one hostname** for the instance and the reader.

Two things to adjust when it lives under a subpath rather than at the root:

- `manifest.webmanifest` `start_url` and `scope` must become `/pwa/` (they are
  `/` today), or the installed app opens outside its own scope.
- Vite's `base` must match (`base: "/pwa/"`) so `/assets/*` resolves; asset URLs
  are absolute in the built HTML.

The GReader API already answers with `access-control-allow-origin: *`, so the
cross-origin route (option 1) works today; the adapter's `misc.php` routes are
the only piece whose CORS behaviour has not been measured from a browser origin.
Serving same-origin sidesteps that entirely.

## What neither option provides

The native shell's extras — the iOS share sheet and `BGAppRefreshTask` — are
properties of the Tauri wrapper, not of the web app. A Home Screen PWA gets no
background refresh, because iOS does not run service workers in the background
for web apps.
