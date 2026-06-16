#!/usr/bin/env python3
"""Local dev static server with caching disabled.

`python3 -m http.server` only sends `Last-Modified`, so browsers heuristically
cache JS/CSS and keep serving stale code after edits (you have to hard-reload or
wait out the freshness window). This server sends `Cache-Control: no-store` on
every response so a normal reload always picks up the latest files.

Usage: python3 scripts/dev-server.py [port]   # default port 5173
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("", port), NoCacheHandler) as httpd:
        print(f"Serving (no-cache) on http://localhost:{port}")
        httpd.serve_forever()
