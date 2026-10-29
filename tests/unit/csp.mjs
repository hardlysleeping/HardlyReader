/**
 * The window's Content-Security-Policy, checked as invariants rather than as a
 * string match.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/csp.mjs
 *
 * `src-tauri/tauri.conf.json` cannot carry a comment: the file is parsed by
 * `serde_json` (`SecurityConfig` is `deny_unknown_fields`, so no `_comment` key
 * either), `tauri-build` only enables its JSON5 fallback behind a non-default
 * feature, and `tests/unit/window-floor.mjs` reads the same file with
 * `JSON.parse`. So the "why" for each directive lives here, next to the
 * assertions that keep it true, and in `docs/csp.md`.
 *
 *   default-src 'none'        Nothing is allowed that is not named below. The
 *                             app is a single bundle plus feed content; it has
 *                             no plugin, no embed and no second origin of its own.
 *   script-src 'self'         The one directive that must stay tight. Vite
 *                             emits one module bundle and `index.html` loads it
 *                             with `<script type="module" src>`, so there is no
 *                             inline script to allow. No 'unsafe-eval': nothing
 *                             in `src/` or in the dependencies compiles code at
 *                             runtime. No 'unsafe-inline': an event handler that
 *                             survived DOMPurify still cannot run.
 *   style-src 'self'          The built CSS bundle is a same-origin stylesheet.
 *     'unsafe-inline'         **Required, and not a mistake.** Svelte's `style:`
 *                             directives and every dynamic CSS variable
 *                             (`style:--row-scale`, `style:--card-window`, the
 *                             theme's colour variables) become style
 *                             *attributes* at runtime, and CSP counts an
 *                             attribute under style-src unless it has a nonce —
 *                             which cannot be attached to an attribute. Removing
 *                             this turns the app into unstyled text. It is not
 *                             there for feed HTML: `sanitizeArticle()` forbids
 *                             `style` as a tag and as an attribute.
 *   img-src 'self'            Article pictures come from arbitrary feed hosts
 *     data: blob:             (enclosure, media:thumbnail, or the first <img>),
 *                             from the server's own icon/ImageCache proxy, and
 *                             — `data:` — from the theme's wallpaper, which
 *                             `background-image.ts` stores as a data URL and
 *                             draws through an inline `background-image`. The
 *                             browser build may be plain http on a LAN, so http:
 *                             is deliberate. `blob:` is the picture cache: a
 *                             kept copy is a Blob in memory and the webview
 *                             draws it through a `blob:` address
 *                             (`lib/image-cache.ts`); without this every kept
 *                             picture in the desktop app is refused.
 *   media-src http: https:    DOMPurify's `html` profile keeps <video>, <audio>
 *                             and <source>, so a feed that carries one plays
 *                             today. Without this it would silently stop, because
 *                             media falls back to default-src 'none'.
 *   connect-src 'self'        `ipc:` and `http://ipc.localhost` are Tauri's own
 *     ipc:                     invoke channel — `@tauri-apps/api` reaches the
 *     http://ipc.localhost     backend with a `fetch()` to an ipc-scheme URL, so
 *     http: https:             a policy without them is a window that renders
 *                             and then cannot talk to its host. `http:`/`https:`
 *                             stay open because the server is whatever the user
 *                             types, including plain http on a LAN, and because
 *                             the browser build speaks to it with a real fetch.
 *                             (In the Tauri window the request itself goes
 *                             through `plugin-http`, i.e. Rust, which CSP never
 *                             sees; the scope for that is the capability.)
 *   object-src 'none'         No <object>/<embed> anywhere, and DOMPurify does
 *   frame-src 'none'          not allow them out of feed HTML. No iframe either:
 *                             the reader draws articles inline, never in a frame.
 *   worker-src 'none'         The service worker in `main.ts` is registered only
 *                             when `__TAURI_INTERNALS__` is absent, i.e. never in
 *                             this window.
 *   base-uri 'none'           `index.html` has no <base>; the one in `extract.ts`
 *                             is prepended to an inert DOMParser document, which
 *                             is not the document a base-uri policy governs.
 *   form-action 'none'        Every <form> in the app (login, add feed, PIN
 *                             unlock) is a Svelte `onsubmit` that calls
 *                             `preventDefault()`; none has an `action`. A real
 *                             submission has nowhere to go and must not leave.
 *   manifest-src 'self'       `index.html` links /manifest.webmanifest; without
 *                             this the webview fetches it, is refused, and logs
 *                             an error that looks like a bug.
 *
 * No `upgrade-insecure-requests`, on purpose: it would rewrite a LAN server's
 * http:// to https:// and break the connection the app exists to make.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  const passed = typeof ok === "function" ? ok() === true : ok === true;
  checks++;
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* ---------------------------------------------------------------------------
 * The policy, as directives.
 * ------------------------------------------------------------------------ */

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const raw = conf?.app?.security?.csp;

check("the window ships a policy at all", typeof raw === "string" && raw.trim() !== "", raw);

const policy = typeof raw === "string" ? raw : "";
const directives = new Map();
const duplicated = [];
for (const part of policy.split(";")) {
  const text = part.trim();
  if (text === "") continue;
  const [name, ...sources] = text.split(/\s+/);
  if (directives.has(name)) duplicated.push(name);
  directives.set(name, sources);
}
check("no directive is declared twice", duplicated.length === 0, duplicated.join(","));

/** Sources of a directive, empty when it is absent (and so falls back). */
const src = (name) => directives.get(name) ?? [];

const KNOWN = new Set([
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "media-src",
  "connect-src",
  "font-src",
  "object-src",
  "frame-src",
  "worker-src",
  "base-uri",
  "form-action",
  "manifest-src",
]);
check(
  "every directive is one a browser knows",
  () => [...directives.keys()].every((name) => KNOWN.has(name)),
  [...directives.keys()].filter((name) => !KNOWN.has(name)).join(","),
);
check(
  "no directive is a bare wildcard",
  () => [...directives.values()].every((sources) => !sources.includes("*")),
);
check("nothing is allowed by default", src("default-src").join(" ") === "'none'");

/* script-src: the one that must not be talked around. */
const script = src("script-src");
check("scripts are same-origin only", script.includes("'self'"), script.join(" "));
check("no script may be evaluated from a string", !script.includes("'unsafe-eval'"));
check("no inline script is trusted", !script.includes("'unsafe-inline'"));
check(
  "no script can come from a remote host",
  () => script.every((source) => source === "'self'" || source.startsWith("'nonce-")),
  script.join(" "),
);
check(
  "nothing in the tree calls eval or the Function constructor",
  () => {
    const bad = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|svelte|js|mjs)$/.test(entry.name)) {
          const text = read(rel);
          if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) bad.push(rel);
        }
      }
    };
    walk("src");
    if (bad.length > 0) console.log(`      ${bad.join(", ")}`);
    return bad.length === 0;
  },
);

/* style-src: 'unsafe-inline' is required by Svelte's style attributes. */
const style = src("style-src");
check("the built stylesheet is same-origin", style.includes("'self'"));
check("Svelte's style attributes are allowed", style.includes("'unsafe-inline'"));
check("and nothing else is trusted for styles", () => style.every((s) => s === "'self'" || s === "'unsafe-inline'"), style.join(" "));

/* img-src: arbitrary feed hosts, plus the theme's data URL. */
const img = src("img-src");
check("feed pictures from any host load", img.includes("http:") && img.includes("https:"));
check("the theme wallpaper (a data URL) can be drawn", img.includes("data:"));
check("a picture the device kept is drawn from its blob: address", img.includes("blob:"), img.join(" "));
check("a relative picture resolves to the app itself", img.includes("'self'"));

/* media-src: DOMPurify keeps <video>/<audio>, so keep them working. */
const media = src("media-src");
check("video and audio in a feed still play", media.includes("http:") && media.includes("https:"));

/* connect-src: must stay open enough for an arbitrary server, and for IPC. */
const connect = src("connect-src");
check("the server the user typed can be plain http", connect.includes("http:"));
check("and https", connect.includes("https:"));
check("Tauri's invoke channel is reached", connect.includes("ipc:") && connect.includes("http://ipc.localhost"));

/* The directives the app never uses. */
check("no plugin content", src("object-src").join(" ") === "'none'");
check("no frames", src("frame-src").join(" ") === "'none'");
check("no workers", src("worker-src").join(" ") === "'none'");
check("no <base> rewrite", src("base-uri").join(" ") === "'none'");
check("no form can navigate away", src("form-action").join(" ") === "'none'");
check("the manifest is fetched from the app", src("manifest-src").includes("'self'"));
check(
  "a LAN server's http:// is not silently upgraded",
  !policy.includes("upgrade-insecure-requests"),
);

/* A `javascript:` href left in feed HTML is inert under `script-src 'self'` — it
 * is inline script. The second layer is the sanitiser, so check that it has not
 * been widened: DOMPurify's default URI allow-list is what drops javascript:,
 * and this file must not replace it. */
const sanitize = read("src/lib/sanitize.ts");
const forbidTags = /FORBID_TAGS:\s*\[([^\]]*)\]/.exec(sanitize)?.[1] ?? "";
const forbidAttrs = /FORBID_ATTR:\s*\[([^\]]*)\]/.exec(sanitize)?.[1] ?? "";
check(
  "feed HTML cannot carry a script, a frame or a style",
  ["script", "iframe", "object", "embed", "style", "form"].every((tag) => forbidTags.includes(`"${tag}"`)),
  forbidTags,
);
check(
  "nor an event handler attribute",
  ["onerror", "onload"].every((attr) => forbidAttrs.includes(`"${attr}"`)),
  forbidAttrs,
);
check(
  "javascript: links are still dropped by DOMPurify's own URI allow-list",
  !/ALLOWED_URI_REGEXP|ADD_DATA_URI_TAGS/.test(sanitize),
);

/* ---------------------------------------------------------------------------
 * What the policy has to survive: the bundle as it is actually loaded.
 * ------------------------------------------------------------------------ */

const html = read("index.html");
const inline = [...html.matchAll(/<script\b[^>]*>/gi)]
  .map((match) => match[0])
  .filter((tag) => !/\bsrc\s*=/i.test(tag));
check("index.html has no inline script for script-src 'self' to refuse", inline.length === 0, inline.join(" "));
check("its one script is a module, same-origin", /<script[^>]+type="module"[^>]+src="\/src\/main\.ts"/.test(html));

/* A built bundle is the only honest answer to "does the policy run", so check
 * it when one is sitting there rather than pretending the source is enough. */
if (existsSync(join(root, "dist/index.html"))) {
  const builtHtml = read("dist/index.html");
  const builtInline = [...builtHtml.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/\bsrc\s*=/i.test(tag));
  check("the built page has no inline script either", builtInline.length === 0, builtInline.join(" "));

  const assets = join(root, "dist/assets");
  const bundles = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith(".js")) : [];
  check("the build emitted the bundle it was meant to", bundles.length > 0, bundles.join(","));
  check(
    "no bundle needs 'unsafe-eval'",
    () => bundles.length > 0 && bundles.every((name) => !/\beval\s*\(|new\s+Function\s*\(/.test(read(`dist/assets/${name}`))),
  );
  check(
    "the bundle is loaded by URL, not injected as text",
    () => /<script[^>]+src="\/assets\/[^"]+\.js"/.test(builtHtml),
  );
} else {
  console.log("SKIP  dist/ is not built, so the bundle checks did not run");
}

/* ---------------------------------------------------------------------------
 * The capability: the same policy, for the commands behind the window.
 *
 * `plugin-http` cannot be narrowed. Its own JS shim calls all five fetch
 * commands, so `http:default` stays; and its URL scope cannot become a path
 * list because `freshrss.ts` lets the user type the API prefix and
 * `extract.ts` fetches an arbitrary publisher page for full text.
 *
 * The opener can be. Every caller (`open-external.ts`, `InlineArticle`,
 * `ReaderPane`) refuses anything that is not http(s), so mailto:/tel: and the
 * unscoped `opener:default` — which also grants `reveal-item-in-dir`, a
 * filesystem call nothing in this app makes — are dropped for a scoped
 * `open-url`.
 * ------------------------------------------------------------------------ */

const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
const permissions = capability.permissions ?? [];
const byId = (id) => permissions.find((entry) => (typeof entry === "string" ? entry : entry.identifier) === id);

check("the app still opens links outside itself", byId("opener:allow-open-url") !== undefined);
check("no unscoped opener grant is left", byId("opener:default") === undefined);
check("the opener cannot reveal files on disk", JSON.stringify(permissions).includes("reveal") === false);
check(
  "the opener only opens http(s)",
  () => {
    const scope = byId("opener:allow-open-url")?.allow ?? [];
    const urls = scope.map((entry) => entry.url).sort();
    return urls.length === 2 && urls[0] === "http://*" && urls[1] === "https://*";
  },
  JSON.stringify(byId("opener:allow-open-url")?.allow ?? null),
);
check(
  "and every caller guards the URL first",
  () => {
    const callers = ["src/lib/open-external.ts", "src/components/InlineArticle.svelte", "src/components/ReaderPane.svelte"];
    return callers.every((rel) => /isExternalHttp|https\?:\\\/\\\//.test(read(rel)));
  },
);
check("the http plugin keeps the scope it needs for an arbitrary server", () => {
  const scope = byId("http:default")?.allow ?? [];
  const urls = scope.map((entry) => entry.url);
  return urls.includes("http://*:*") && urls.includes("https://*:*");
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
