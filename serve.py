#!/usr/bin/env python3
"""
Local dev server for the track viewer: serves the static files AND proxies
`/vd/*` to VelociDrone's API on the same origin.

Why the proxy: the live "Fetch WR line" feature calls the leaderboard API,
whose `getFlight` response carries no CORS header, so a browser can't read it
directly. Forwarding it here on the same origin sidesteps that — the request
goes browser -> localhost -> VelociDrone (it carries no account data).

    python3 serve.py            # http://localhost:8099
    PORT=9000 python3 serve.py

Plain `python3 -m http.server` still works for everything except live fetch.
"""
import os, urllib.request, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8099"))
UPSTREAM = "https://www.velocidrone.com/api/"
ALLOWED = ("leaderboard/", "get_official_tracks", "download-file")


class Handler(SimpleHTTPRequestHandler):
    def _proxy(self):
        path = self.path[len("/vd/"):].split("?", 1)[0]
        if not path.startswith(ALLOWED):
            self.send_error(403, "endpoint not allowed")
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            UPSTREAM + path, data=body, method=self.command,
            headers={"Content-Type": self.headers.get(
                        "Content-Type", "application/x-www-form-urlencoded"),
                     "User-Agent": "vd-track-viewer"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, status = e.read(), e.code
        except Exception as e:                      # noqa: BLE001
            self.send_error(502, f"upstream error: {e}")
            return
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.startswith("/vd/"):
            self._proxy()
        else:
            self.send_error(405)

    def do_GET(self):
        if self.path.startswith("/vd/"):
            self._proxy()
        else:
            super().do_GET()

    def end_headers(self):
        # plain dev server sends no cache headers; force revalidation so edited
        # modules don't get served stale
        if not self.path.startswith("/vd/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"track viewer + /vd proxy on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
