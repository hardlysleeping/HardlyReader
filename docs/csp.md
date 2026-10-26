# The window's Content-Security-Policy

The policy lives in `src-tauri/tauri.conf.json` under `app.security.csp`. As shipped:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: http: https:; media-src http: https:;
connect-src 'self' ipc: http://ipc.localhost http: https:;
object-src 'none'; frame-src 'none'; worker-src 'none';
base-uri 'none'; form-action 'none'; manifest-src 'self'
```

The reason it is not commented in place: `tauri.conf.json` must stay strict JSON.
`SecurityConfig` is `deny_unknown_fields`, so a `_comment` key is rejected;
`tauri-build` enables its JSON5 fallback only behind the non-default
`config-json5` feature (this crate takes the defaults, `config-json`); and
`tests/unit/window-floor.mjs` reads the same file with `JSON.parse`. The
invariants, and this rationale, are asserted in `tests/unit/csp.mjs`.

## Directive by directive

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'none'` | Nothing is allowed that is not named below. The window is one bundle plus feed content: no plugin, no embed, no second origin of its own. |
| `script-src` | `'self'` | Vite emits one module bundle, loaded from `index.html` by `<script type="module" src>`. No inline script, so no `'unsafe-inline'`; nothing in `src/` or the dependencies compiles code at runtime, so no `'unsafe-eval'`. Tauri will add `'sha256-…'` for any inline script it finds in the HTML and `'nonce-…'` for its own nonce tokens; this `index.html` has neither, so the header that reaches the webview is exactly the string above. |
| `style-src` | `'self' 'unsafe-inline'` | `'self'` is the built CSS bundle. `'unsafe-inline'` is **required and deliberate**: Svelte's `style:` directives and every dynamic CSS variable (`style:--row-scale`, `style:--card-window`, the theme colours) become style *attributes* at runtime, and CSP counts an attribute under `style-src` unless it carries a nonce — which an attribute cannot. Dropping it turns the app into unstyled text. It is not there to let feed HTML style itself: `sanitizeArticle()` forbids `style` both as a tag and as an attribute. |
| `img-src` | `'self' data: http: https:` | Article pictures come from arbitrary feed hosts (enclosure, `media:thumbnail`, or the first `<img>` in the body, see `thumb.ts`), from the server's own icon/ImageCache proxy (`/f.php`, `piccache.php`), and — `data:` — from the theme wallpaper, which `background-image.ts` stores as a data URL and draws through an inline `background-image`. `http:` is deliberate: a LAN server, and the images it proxies, can be plain http. |
| `media-src` | `http: https:` | DOMPurify's `html` profile keeps `<video>`, `<audio>` and `<source>`, so a feed that carries one plays today. Media falls back to `default-src`, so without this it would silently stop. |
| `connect-src` | `'self' ipc: http://ipc.localhost http: https:` | `ipc:` / `http://ipc.localhost` are Tauri's own invoke channel: `@tauri-apps/api` reaches the backend with a `fetch()` to an ipc-scheme URL (`ipc://localhost/…` on Linux, `http://ipc.localhost/…` on Windows and Android). A policy without them renders a window that then cannot talk to its host. `http:`/`https:` stay open because the server is whatever the user types — including plain http on a LAN — and because the browser build talks to it with a real `fetch` (`src/api/transport.ts`). In the Tauri window the request itself goes through `plugin-http`, i.e. Rust, which CSP never sees; the scope for that is the capability, below. |
| `object-src` | `'none'` | No `<object>`/`<embed>` in the app, and DOMPurify does not produce them from feed HTML. |
| `frame-src` | `'none'` | Articles are drawn inline in the reader, never in a frame. `sanitizeArticle()` forbids `iframe` outright. |
| `worker-src` | `'none'` | The service worker in `main.ts` is registered only when `__TAURI_INTERNALS__` is absent, i.e. never in this window. |
| `base-uri` | `'none'` | `index.html` has no `<base>`. The one `extract.ts` prepends goes into an inert `DOMParser` document, which is not the document `base-uri` governs. |
| `form-action` | `'none'` | Every `<form>` in the app — login, add feed, PIN unlock — is a Svelte `onsubmit` that calls `preventDefault()`, and none carries an `action`. A real submission has nowhere to go and must not leave the window. |
| `manifest-src` | `'self'` | `index.html` links `/manifest.webmanifest`. Without this the webview fetches it, is refused, and logs an error that reads like a bug. |

No `upgrade-insecure-requests`, on purpose: it would rewrite a LAN server's
`http://` to `https://` and break the one connection this app exists to make.

## What the policy does not cover

- **`plugin-http` requests.** They are made in Rust and are governed by the
  capability, not by CSP. The capability keeps `http:default` over `http://*:*`
  and `https://*:*`, and it cannot be narrowed to a path list: `freshrss.ts`
  lets the user type the API prefix (any `*greader.php`, or a custom path), and
  `extract.ts` fetches an arbitrary publisher page for full text. It cannot be
  narrowed to a command either — `@tauri-apps/plugin-http`'s own `fetch` shim
  calls `fetch`, `fetch_send`, `fetch_read_body`, `fetch_cancel` and
  `fetch_cancel_body`, i.e. all five of `http:default`.
- **The opener, which is narrowed.** `opener:default` is gone: it also granted
  `reveal_item_in_dir` (a filesystem call nothing in this app makes) and
  `mailto:`/`tel:`. In its place `opener:allow-open-url` scoped to `http://*`
  and `https://*`. Sound because all three callers —
  `lib/open-external.ts`, `InlineArticle.svelte`, `ReaderPane.svelte` — refuse
  anything that is not `http(s)` before calling `openUrl`.
- **The browser build.** The policy is attached by Tauri's asset protocol
  response, so it applies to the packaged window. The phone-over-LAN browser
  build is served by the app's own `tiny_http` server and is unaffected.
- **Downloads.** The OPML export builds a `blob:` and clicks a `download` link
  (`Sidebar.svelte`). That is a download, not a fetch or a frame, so no directive
  here governs it and `blob:` is deliberately absent from `img-src`.
- **`tauri dev` on the desktop.** The page comes from Vite (`devUrl`), not from
  the asset protocol, so the CSP is not attached and a dev session proves
  nothing about it. `devCsp` is deliberately unset; it is the lever if a future
  dev flow does serve through the asset protocol (it would need `ws:` for the
  HMR socket).
- **`withGlobalTauri`** is off (not set in the config), so there is no
  `window.__TAURI__` global to account for. `devtools` needs nothing from the
  policy: the inspector is not subject to `script-src`, and the crate does not
  enable the `devtools` feature in release builds.

## What only running the app can prove

The policy is checked here as a config invariant, not as a working window. Still
unproven without launching a build:

- that the page renders at all under it — this is the failure mode the task
  warned about, and nothing in a unit test can rule it out;
- that WebKitGTK honours the `ipc:` scheme source. The syntax is standard CSP,
  but the scheme is Tauri's own, and if the engine ignored it the window would
  draw and then fail to talk to its host;
- that Tauri's injected init script (`window.__TAURI_INTERNALS__`) is exempt from
  `script-src` the way a webview *user script* should be. If it were treated as a
  page inline script, IPC would be dead with no visible error;
- that Svelte's style attributes really are all the inline styling the app needs,
  rather than the shell also injecting a `<style>` element somewhere;
- that the theme wallpaper (`data:`, drawn through an inline `background-image`)
  still shows;
- that a feed's `<video>`/`<audio>` still plays under `media-src`;
- that icons and proxied pictures on a plain-http LAN server still load, i.e.
  that the webview treats `http:` in `img-src` as a scheme source and not as a
  host that must be spelled out;
- that `pnpm tauri build` accepts the capability as written. The permission id
  (`opener:allow-open-url`) and the scope entry shape (`{"url": "http://*"}`) are
  both taken from the plugin's own shipped permission files, and scoped
  permissions in a capability are already used in this file for `http:default`,
  but the ACL is resolved by `tauri-build` at compile time and that has not been
  run here.
