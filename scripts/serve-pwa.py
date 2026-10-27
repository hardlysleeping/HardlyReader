#!/usr/bin/env python3
"""Serve the built PWA from this machine, and proxy its API to the server.

Why this exists instead of `python3 -m http.server`: a PWA needs three things a
plain file server gets wrong. `.webmanifest` must be served as
`application/manifest+json` or Safari ignores it; `sw.js` must never be cached
or a release can get stuck behind an old service worker; and a deep link has to
fall back to `index.html` rather than 404. Hashed assets under /assets/ are the
only thing worth caching hard, because their names change with their contents.

Why `/api/` is proxied
----------------------
The app talks to two things on the FreshRSS host, and only one of them carries
CORS headers. The GReader API sends `access-control-allow-origin: *` itself; the
Hardly Read adapter's routes under `/api/misc.php/...` send none. Measured from
this page's own origin: the GReader request answers, while
`/api/misc.php/Hardly%20Read/v1/state` goes out and comes back as
`TypeError: Failed to fetch` — a CORS refusal, not a network failure.

That refusal is not cosmetic: the extension's state is where the passcode count,
the hidden categories and the pins live, so on the PWA the app could not tell
whether a passcode existed and told the reader it had not been told.

Forwarding `/api/` makes the page and its API one origin, so the browser has
nothing to check and the adapter needs no change on the server. Sign in with
this app's own address as the server URL; `/api/greader.php` answers here as it
does there.

Binds loopback only. The tailnet address is added by `tailscale serve`, which
terminates TLS — iOS will not install a PWA from plain http.
"""

from __future__ import annotations

import argparse
import functools
import http.client
import http.server
import mimetypes
import os
import posixpath
import ssl
import sys
import urllib.parse

DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist")

# Where /api/ goes. Overridable so this can point at a test harness instead.
UPSTREAM = os.environ.get("HARDLYREAD_UPSTREAM", "https://cenvalweb.tail900410.ts.net:8449")

# Headers that describe a single hop and must not be forwarded either way.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/svg+xml", ".svg")


def forward(method: str, path: str, headers, body: bytes | None):
    """One request to the upstream, as (status, headers, body)."""
    url = urllib.parse.urlsplit(UPSTREAM)
    host = url.hostname or "127.0.0.1"
    if url.scheme == "https":
        conn = http.client.HTTPSConnection(
            host, url.port or 443, timeout=30, context=ssl.create_default_context()
        )
    else:
        conn = http.client.HTTPConnection(host, url.port or 80, timeout=30)

    target = posixpath.join(url.path.rstrip("/") or "", path.lstrip("/"))
    out = {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP}
    out["Host"] = host if url.port is None else f"{host}:{url.port}"

    try:
        conn.request(method, "/" + target.lstrip("/"), body=body, headers=out)
        response = conn.getresponse()
        data = response.read()
        returned = [(k, v) for k, v in response.getheaders() if k.lower() not in HOP_BY_HOP]
        return response.status, returned, data
    finally:
        conn.close()


class PWAHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        # Strip the query string, normalise, and refuse to climb out of dist.
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = posixpath.normpath(path)
        parts = [p for p in path.split("/") if p and p not in (".", "..")]
        target = os.path.join(DIST, *parts)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            # Deep links and the app's own routes belong to the SPA.
            target = os.path.join(DIST, "index.html")
        return target

    def end_headers(self) -> None:
        name = os.path.basename(self.path.split("?", 1)[0])
        if name in ("sw.js", "index.html", "manifest.webmanifest"):
            self.send_header("Cache-Control", "no-cache")
        elif "/assets/" in self.path:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        # iOS asks for these when it decides whether a page is installable.
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # keep the journal readable
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _is_api(self) -> bool:
        return self.path == "/api" or self.path.startswith("/api/")

    def _forward(self) -> None:
        body = None
        length = self.headers.get("Content-Length")
        if length:
            body = self.rfile.read(int(length))
        try:
            status, headers, data = forward(self.command, self.path, self.headers, body)
        except Exception as error:  # unreachable upstream, refused TLS, timeout
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"upstream {UPSTREAM} failed: {error}\n".encode())
            return

        self.send_response(status)
        for key, value in headers:
            if key.lower() in ("content-length", "connection"):
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        # `super()`, not `self`: the override above adds the static-file caching
        # and nosniff headers, and an upstream response already has its own.
        super().end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self) -> None:
        if self._is_api():
            return self._forward()
        return super().do_GET()

    def do_HEAD(self) -> None:
        if self._is_api():
            return self._forward()
        return super().do_HEAD()

    def do_POST(self) -> None:
        if self._is_api():
            return self._forward()
        self.send_error(405)

    def do_PUT(self) -> None:
        if self._is_api():
            return self._forward()
        self.send_error(405)

    def do_DELETE(self) -> None:
        if self._is_api():
            return self._forward()
        self.send_error(405)

    def do_OPTIONS(self) -> None:
        if self._is_api():
            return self._forward()
        self.send_error(405)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4179)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("no dist/index.html — run `pnpm build` first", file=sys.stderr)
        return 1

    handler = functools.partial(PWAHandler, directory=DIST)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(
            "serving %s on http://%s:%d (api → %s)" % (DIST, args.bind, args.port, UPSTREAM),
            flush=True,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
