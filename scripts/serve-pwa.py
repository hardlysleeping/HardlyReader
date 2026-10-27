#!/usr/bin/env python3
"""Serve the built PWA from this machine.

Why this exists instead of `python3 -m http.server`: a PWA needs three things a
plain file server gets wrong. `.webmanifest` must be served as
`application/manifest+json` or Safari ignores it; `sw.js` must never be cached
or a release can get stuck behind an old service worker; and a deep link has to
fall back to `index.html` rather than 404. Hashed assets under /assets/ are the
only thing worth caching hard, because their names change with their contents.

Binds loopback only. The tailnet address is added by `tailscale serve`, which
terminates TLS — iOS will not install a PWA from plain http.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import mimetypes
import os
import posixpath
import sys

DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/svg+xml", ".svg")


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
        print("serving %s on http://%s:%d" % (DIST, args.bind, args.port), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
